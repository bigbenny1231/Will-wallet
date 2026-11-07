// The keeper poll loop (SPEC §3): poke overdue vaults, drive settlement, relay signed foreign txs.
import type { Backend } from './backend.js';
import type { Chains } from './chainsApi.js';
import { deriveState, describeAction, nextAction } from './machine.js';
import type { ChainName, StepArgs, TxResult, VaultView } from './types.js';
import { MAX_RESIGNS, RELAY_COOLDOWN, classifyRelayError } from './relay.js';
import { bumpedEvmArgs, clampEvm, msUntilResign, payoutTxId } from './resign.js';
import { errMsg, foreignTxLink, logErr, logInfo, logOk, logWarn, nearTxLink, sleep } from './util.js';

export interface Logger {
  ok(tag: string, msg: string): void;
  warn(tag: string, msg: string): void;
  err(tag: string, msg: string): void;
  info(tag: string, msg: string): void;
}
export const consoleLogger: Logger = { ok: logOk, warn: logWarn, err: logErr, info: logInfo };

export interface KeeperDeps {
  backend: Backend;
  chains: Chains;
  contractId: string;
  now: () => number;
  log: Logger;
  /** "token:index" -> foreign tx hash, for payouts broadcast but not yet marked on NEAR. */
  relayed: Map<string, string>;
  /** last observed state per token, for change lines */
  lastState: Map<string, string>;
  /** "token:index" -> parked relay (unfunded source, errors); retried after `until`. Status stays `signed` on-chain. */
  relayBlock: Map<string, { until: number; reason: string }>;
  /** "token:index" -> resign_foreign calls so far (capped so an unfunded Solana payout cannot burn gas forever). */
  resigns: Map<string, number>;
  /** "token:index:txid" of payouts whose tx was seen on chain (never re-checked). */
  landed: Set<string>;
  /** "token:index" -> next time a broadcast payout's hash may be looked up on chain again. */
  landedCheckAt: Map<string, number>;
  /** When set, only these token ids are driven (the live demo must not touch other people's vaults). */
  only?: Set<string>;
}

export function makeDeps(p: Pick<KeeperDeps, 'backend' | 'chains' | 'contractId'> & Partial<KeeperDeps>): KeeperDeps {
  return { now: Date.now, log: consoleLogger, relayed: new Map(), lastState: new Map(), relayBlock: new Map(), resigns: new Map(), landed: new Set(), landedCheckAt: new Map(), ...p };
}

export interface ActionRecord {
  kind: 'poke' | 'step' | 'broadcast' | 'mark';
  tokenId: string;
  hash?: string;
  detail?: string;
  ok: boolean;
}

export async function stepArgsFor(deps: KeeperDeps, v: VaultView, chain: ChainName, index: number): Promise<StepArgs> {
  if (chain === 'base' || chain === 'monad') {
    const from = v.foreign[index].from_address || (await deps.chains.deriveAddresses(deps.contractId, v.token_id))[chain];
    // The contract sets the nonce itself (SPEC 2.7) and ignores ours; we still send it. Fees/gas stay inside its per-chain caps.
    return { evm: clampEvm(await deps.chains.evmParams(from, chain), chain) };
  }
  return { solana: await deps.chains.solanaParams() };
}

const LANDED_RECHECK_MS = 30_000;

/** Indexes of `broadcast` payouts whose recorded tx is unknown to the chain (checked at most every 30 s, positives are cached). */
async function findUnlanded(deps: KeeperDeps, v: VaultView): Promise<Set<number>> {
  const missing = new Set<number>();
  if (v.state !== 'Triggered' && v.state !== 'Settled') return missing;
  for (let i = 0; i < v.foreign.length; i++) {
    const p = v.foreign[i];
    if (p.status !== 'broadcast' || !p.signed_tx || !p.tx_hash) continue;
    const key = `${v.token_id}:${i}`;
    if (deps.landed.has(`${key}:${p.tx_hash}`)) continue;
    if ((deps.landedCheckAt.get(key) ?? 0) > deps.now()) continue;
    if ((deps.relayBlock.get(key)?.until ?? 0) > deps.now()) continue;
    try {
      if (await deps.chains.txLanded(p.chain, p.tx_hash)) {
        deps.landed.add(`${key}:${p.tx_hash}`);
        deps.log.info('verify', `vault ${v.token_id} payout #${i} ${p.chain} ${p.tx_hash} is on chain`);
      } else {
        deps.log.warn('verify', `vault ${v.token_id} payout #${i} ${p.chain} is broadcast but ${p.tx_hash} is not on chain; relaying the stored tx`);
        missing.add(i);
      }
    } catch (e) {
      deps.log.warn('verify', `vault ${v.token_id} payout #${i}: chain lookup failed (${errMsg(e)}); will retry`);
      deps.landedCheckAt.set(key, deps.now() + LANDED_RECHECK_MS);
    }
  }
  return missing;
}

type StaleResult = { kind: 'resigned' } | { kind: 'landed'; hash: string } | { kind: 'wait' } | { kind: 'error' };

/**
 * A relay of a signed tx is stale (expired Solana blockhash, EVM nonce/price problem). Hardened contract rules:
 *  - wait until `resign_allowed_after_ms` (5 min after the last request), never re-sign right away;
 *  - first confirm the old signature never landed (Solana getSignatureStatuses / EVM tx lookup);
 *  - EVM: both fees = max(fresh, 1.1 x last), inside 21000..100000 gas and 100 gwei;
 *  - Solana: the call must come from the keeper account (set_keeper), which is the account this backend signs with.
 */
async function handleStale(deps: KeeperDeps, v: VaultView, index: number, chain: ChainName, why: string, out: ActionRecord[]): Promise<StaleResult> {
  const { backend, chains, log } = deps;
  const id = v.token_id;
  const key = `${id}:${index}`;
  const p = v.foreign[index];
  const label = `vault ${id} payout #${index} ${chain}`;
  const park = (ms: number, reason: string) => deps.relayBlock.set(key, { until: deps.now() + ms, reason });
  try {
    const track = await backend.getSignTrack(id, index);
    const wait = msUntilResign(track, deps.now());
    if (wait > 0) {
      park(wait, 'resign-wait');
      log.warn('resign', `${label} signed tx is stale (${why}); re-sign allowed in ${Math.ceil(wait / 1000)}s, waiting`);
      return { kind: 'wait' };
    }
    const oldId = payoutTxId(p);
    if (oldId && (await chains.txLanded(chain, oldId).catch(() => false))) {
      log.ok('resign', `${label}: the old tx ${oldId} is on chain, not signing again`);
      deps.landed.add(`${key}:${oldId}`);
      return { kind: 'landed', hash: oldId };
    }
    const n = deps.resigns.get(key) ?? 0;
    if (n >= MAX_RESIGNS) {
      deps.resigns.set(key, 0);
      park(RELAY_COOLDOWN.resignCap, 'stale');
      log.warn('relay', `${label} still stale after ${MAX_RESIGNS} resigns; parked ${RELAY_COOLDOWN.resignCap / 1000}s`);
      return { kind: 'wait' };
    }
    let args = await stepArgsFor(deps, v, chain, index);
    if (chain !== 'solana' && args.evm && (p.status === 'signed' || p.status === 'broadcast')) {
      const bumped = bumpedEvmArgs(args.evm, track, chain);
      if (!bumped) {
        park(RELAY_COOLDOWN.resignCap, 'fee-cap');
        log.err('resign', `${label}: a 1.1x fee bump over the last request exceeds the chain's max-fee cap; cannot re-sign`);
        return { kind: 'wait' };
      }
      args = { evm: bumped };
    }
    deps.resigns.set(key, n + 1);
    log.warn('resign', `${label} signed tx is stale (${why}); resign_foreign${args.evm ? ` fees ${args.evm.max_fee_per_gas}/${args.evm.max_priority_fee_per_gas}` : ''}`);
    const rtx = await backend.resignForeign(id, index, args);
    out.push({ kind: 'step', tokenId: id, hash: rtx.hash, ok: !rtx.failure, detail: 'resign_foreign' });
    log[rtx.failure ? 'err' : 'ok']('resign', `${label} resign_foreign${rtx.failure ? ` failed: ${rtx.failure}` : ''}  ${nearTxLink(rtx.hash)}`);
    if (rtx.failure) {
      park(RELAY_COOLDOWN.other, 'resign-failed');
      return { kind: 'error' };
    }
    return { kind: 'resigned' };
  } catch (e) {
    park(RELAY_COOLDOWN.other, 'resign-failed');
    log.err('resign', `${label}: ${errMsg(e)} (retry in ${RELAY_COOLDOWN.other / 1000}s)`);
    out.push({ kind: 'step', tokenId: id, ok: false, detail: errMsg(e) });
    return { kind: 'error' };
  }
}

/** Payouts that ended `failed` (no usable signature): re-sign once the cooldown is over. */
async function resignFailedPayouts(deps: KeeperDeps, v: VaultView, out: ActionRecord[]): Promise<void> {
  if (v.state !== 'Triggered' && v.state !== 'Settled') return;
  for (let i = 0; i < v.foreign.length; i++) {
    const p = v.foreign[i];
    if (p.status !== 'failed') continue;
    if (v.state === 'Triggered' && !(v.step > 3 || (v.step === 3 && i < v.foreign_index))) continue;
    const key = `${v.token_id}:${i}`;
    if ((deps.relayBlock.get(key)?.until ?? 0) > deps.now()) continue;
    const park = (ms: number) => deps.relayBlock.set(key, { until: deps.now() + ms, reason: 'resign-wait' });
    try {
      const track = await deps.backend.getSignTrack(v.token_id, i);
      const wait = msUntilResign(track, deps.now());
      if (wait > 0) {
        park(wait);
        deps.log.info('resign', `vault ${v.token_id} payout #${i} ${p.chain} failed; re-sign allowed in ${Math.ceil(wait / 1000)}s, waiting`);
        continue;
      }
      const n = deps.resigns.get(key) ?? 0;
      if (n >= MAX_RESIGNS) {
        park(RELAY_COOLDOWN.resignCap);
        continue;
      }
      deps.resigns.set(key, n + 1);
      const args = await stepArgsFor(deps, v, p.chain, i);
      const rtx = await deps.backend.resignForeign(v.token_id, i, args);
      out.push({ kind: 'step', tokenId: v.token_id, hash: rtx.hash, ok: !rtx.failure, detail: 'resign_foreign' });
      deps.log[rtx.failure ? 'err' : 'ok']('resign', `vault ${v.token_id} payout #${i} ${p.chain} resign_foreign${rtx.failure ? ` failed: ${rtx.failure}` : ''}  ${nearTxLink(rtx.hash)}`);
      if (rtx.failure) park(RELAY_COOLDOWN.other);
    } catch (e) {
      park(RELAY_COOLDOWN.other);
      deps.log.err('resign', `vault ${v.token_id} payout #${i}: ${errMsg(e)}`);
    }
  }
}

const MAX_ACTIONS_PER_VAULT = 25;

/** Perform every action currently due for one vault. Never throws. */
export async function driveVault(deps: KeeperDeps, initial: VaultView): Promise<ActionRecord[]> {
  const { backend, chains, log } = deps;
  const out: ActionRecord[] = [];
  let v = initial;
  const id = v.token_id;

  const noteState = (view: VaultView) => {
    const s = deriveState(view, deps.now());
    const prev = deps.lastState.get(id);
    if (prev !== s) {
      deps.lastState.set(id, s);
      if (prev) log.info('state', `vault ${id}: ${prev} → ${s}`);
    }
  };
  noteState(v);

  const failed = (tx: TxResult) => !!tx.failure;

  // SPEC 2.7: a `broadcast` payout whose hash is not on chain gets its stored signed_tx relayed again.
  const rebroadcastSet = await findUnlanded(deps, v);
  // `failed` payouts: wait until the re-sign cooldown is over, then sign again (never right away).
  await resignFailedPayouts(deps, v, out);
  if (out.some((a) => a.detail === 'resign_foreign' && a.ok)) v = await backend.getVault(id);

  for (let i = 0; i < MAX_ACTIONS_PER_VAULT; i++) {
    const action = nextAction(v, deps.now(), (idx) => (deps.relayBlock.get(`${id}:${idx}`)?.until ?? 0) > deps.now(), (idx) => rebroadcastSet.has(idx));
    if (!action) break;
    try {
      if (action.kind === 'poke') {
        let tx: TxResult;
        try {
          tx = await backend.poke(id);
        } catch (e) {
          if (/not_due/.test(errMsg(e))) {
            log.info('poke', `vault ${id} not due on-chain yet (clock skew); will retry`);
            out.push({ kind: 'poke', tokenId: id, ok: false, detail: 'not_due' });
            break;
          }
          throw e;
        }
        out.push({ kind: 'poke', tokenId: id, hash: tx.hash, ok: !failed(tx) });
        if (failed(tx)) {
          log.err('poke', `vault ${id} failed: ${tx.failure}  ${nearTxLink(tx.hash)}`);
          break;
        }
        log.ok('poke', `vault ${id} → Triggered  ${nearTxLink(tx.hash)}`);
      } else if (action.kind === 'step') {
        let args: StepArgs | undefined;
        if (action.chain && action.index !== undefined) args = await stepArgsFor(deps, v, action.chain, action.index);
        let tx = await backend.executeStep(id, args);
        out.push({ kind: 'step', tokenId: id, hash: tx.hash, ok: !failed(tx), detail: `step ${action.step}` });
        const label = action.chain ? `step ${action.step}/5 (${action.chain} #${action.index})` : `step ${action.step}/5`;
        if (failed(tx)) {
          log.err('step', `vault ${id} ${label} failed: ${tx.failure}  ${nearTxLink(tx.hash)}`);
          break;
        }
        log.ok('step', `vault ${id} ${label}  ${nearTxLink(tx.hash)}`);

        if (action.chain === 'solana' && action.index !== undefined) {
          // No "retry right away": a second signature over a live blockhash could double-pay (SECURITY_REVIEW C-1).
          // If the payout did not come out signed, the re-sign pass below waits for resign_allowed_after_ms.
          const after = await backend.getVault(id);
          if (after.state === 'Triggered' && after.step === 3 && after.foreign_index === action.index) {
            log.info('step', `vault ${id} solana sign has not advanced the payout yet; the keeper waits instead of retrying (in-flight guard / 5 min re-sign cooldown)`);
            break;
          }
        }
      } else if (action.kind === 'relay') {
        const p = v.foreign[action.index];
        const key = `${id}:${action.index}`;
        const label = `vault ${id} payout #${action.index} ${action.chain}`;
        let hash = deps.relayed.get(key);
        let alreadyLanded = false;
        if (!hash) {
          try {
            hash = action.chain !== 'solana' ? await chains.broadcastEvm(p.signed_tx!, action.chain) : await chains.broadcastSolana(p.signed_tx!);
          } catch (e) {
            const kind = classifyRelayError(action.chain, e);
            if (kind === 'stale') {
              const r = await handleStale(deps, v, action.index, action.chain, errMsg(e), out);
              if (r.kind === 'resigned') {
                v = await backend.getVault(id);
                continue;
              }
              if (r.kind === 'landed') {
                alreadyLanded = true;
                hash = r.hash; // the old signature is on chain: record it instead of signing again
              } else {
                out.push({ kind: 'broadcast', tokenId: id, ok: false, detail: 'stale' });
                if (r.kind === 'error') break;
                continue;
              }
            } else if (kind === 'unfunded') {
              const prev = deps.relayBlock.get(key);
              deps.relayBlock.set(key, { until: deps.now() + RELAY_COOLDOWN.unfunded, reason: 'unfunded' });
              const from = p.from_address || (await deps.chains.deriveAddresses(deps.contractId, id).then((a) => (action.chain === 'solana' ? a.solana : a[action.chain])).catch(() => 'the derived address'));
              if (prev?.reason === 'unfunded') log.info('relay', `${label} still unfunded; status stays ${p.status}, retry in ${RELAY_COOLDOWN.unfunded / 1000}s`);
              else log.warn('relay', `${label} NOT broadcast: source ${from} is unfunded (${errMsg(e)}). Status stays ${p.status}; fund it and the keeper will relay. Retry in ${RELAY_COOLDOWN.unfunded / 1000}s`);
              out.push({ kind: 'broadcast', tokenId: id, ok: false, detail: 'unfunded' });
              continue;
            } else {
              deps.relayBlock.set(key, { until: deps.now() + RELAY_COOLDOWN.other, reason: 'other' });
              log.err('relay', `${label} relay error: ${errMsg(e)} (status stays ${p.status}, retry in ${RELAY_COOLDOWN.other / 1000}s)`);
              out.push({ kind: 'broadcast', tokenId: id, ok: false, detail: errMsg(e) });
              continue;
            }
          }
          if (!alreadyLanded) {
            out.push({ kind: 'broadcast', tokenId: id, hash, ok: true, detail: action.chain });
            log.ok('relay', `${label} ${action.rebroadcast ? 're-sent (hash was not on chain)' : 'sent'}  ${foreignTxLink(action.chain, hash)}`);
          }
          deps.relayed.set(key, hash);
          deps.relayBlock.delete(key);
        }
        if (action.rebroadcast) {
          // Already `broadcast` on NEAR (mark_broadcast requires `signed`): nothing to mark. Re-verify later.
          deps.relayed.delete(key);
          deps.landedCheckAt.set(key, deps.now() + LANDED_RECHECK_MS);
          rebroadcastSet.delete(action.index);
        } else {
          const tx = await backend.markBroadcast(id, action.index, hash);
          out.push({ kind: 'mark', tokenId: id, hash: tx.hash, ok: !failed(tx) });
          if (failed(tx)) {
            log.err('mark', `vault ${id} mark_broadcast #${action.index} failed: ${tx.failure}  ${nearTxLink(tx.hash)}`);
            break;
          }
          deps.relayed.delete(key);
          log.ok('mark', `vault ${id} mark_broadcast #${action.index}  ${nearTxLink(tx.hash)}`);
        }
      }
      v = await backend.getVault(id);
      noteState(v);
    } catch (e) {
      log.err(action.kind, `vault ${id} ${describeAction(action)}: ${errMsg(e)}`);
      out.push({ kind: action.kind === 'relay' ? 'broadcast' : action.kind, tokenId: id, ok: false, detail: errMsg(e) });
      break;
    }
  }
  return out;
}

export interface TickResult {
  vaults: number;
  actions: ActionRecord[];
  error?: string;
}

export async function tickOnce(deps: KeeperDeps): Promise<TickResult> {
  let vaults: VaultView[];
  try {
    vaults = await deps.backend.getVaults();
  } catch (e) {
    deps.log.err('rpc', `get_vaults failed: ${errMsg(e)}`);
    return { vaults: 0, actions: [], error: errMsg(e) };
  }
  const actions: ActionRecord[] = [];
  if (deps.only) vaults = vaults.filter((x) => deps.only!.has(x.token_id));
  for (const v of vaults) actions.push(...(await driveVault(deps, v)));
  return { vaults: vaults.length, actions, error: actions.some((a) => !a.ok && a.detail !== 'not_due' && a.detail !== 'unfunded' && a.detail !== 'stale') ? 'action_failed' : undefined };
}

export async function runKeeper(
  deps: KeeperDeps,
  o: { pollS: number; once?: boolean; signal?: AbortSignal; sleepFn?: (ms: number) => Promise<void> },
): Promise<void> {
  const sl = o.sleepFn ?? sleep;
  let consecutiveErrors = 0;
  deps.log.info('keeper', `watching ${deps.contractId} via ${deps.backend.label}, poll every ${o.pollS}s`);
  while (!o.signal?.aborted) {
    try {
      const r = await tickOnce(deps);
      consecutiveErrors = r.error ? consecutiveErrors + 1 : 0;
    } catch (e) {
      // tickOnce should never throw; belt and braces so the loop survives anything.
      consecutiveErrors++;
      deps.log.err('keeper', `tick crashed: ${errMsg(e)}`);
    }
    if (o.once) return;
    const delay = Math.min(60_000, o.pollS * 1000 * 2 ** Math.min(consecutiveErrors, 4));
    if (consecutiveErrors) deps.log.warn('keeper', `errors in a row: ${consecutiveErrors}, next poll in ${Math.round(delay / 1000)}s`);
    await sl(delay);
  }
}
