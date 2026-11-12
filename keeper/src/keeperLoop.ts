// The keeper poll loop (SPEC §3): poke overdue vaults, drive settlement, relay signed foreign txs.
import type { Backend } from './backend.js';
import type { Chains } from './chainsApi.js';
import { deriveState, describeAction, matchesFilter, needsSettlement, nextAction } from './machine.js';
import type { Notifier } from './notify.js';
import type { ChainName, StepArgs, TxResult, VaultView } from './types.js';
import { MAX_RESIGNS, RELAY_COOLDOWN, classifyRelayError } from './relay.js';
import { bumpedEvmArgs, clampEvm, msUntilResign, payoutTxId } from './resign.js';
import { vaultPaths } from './chains/derive.js';
import type { Funder, SourceSet, TopUp } from './funder.js';
import { STEP3_MARGIN_MS, STEP3_UNKNOWN_PARK_MS, STEP3_WINDOW_PANIC, isOperator, step3OpensAt } from './step3.js';
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
  /** When set, only vaults whose `owner_id` starts with this are driven (`--owner-prefix`). Combines with `only`. */
  ownerPrefix?: string;
  /** When set, a vault entering Warning or Triggered is reported to the owner's webhook (DMW_NOTIFY_WEBHOOK). */
  notifier?: Notifier;
  /** Checked before every action; true means "start nothing new" (time limit reached, or the process is stopping). */
  shouldStop?: () => boolean;
  /**
   * `--fund-sources`: tops up a vault's foreign source addresses right before each step-III signature, and once more
   * when a relay reports the source unfunded (then the relay is retried at once). Caps live in the funder.
   */
  funder?: Pick<Funder, 'fundVault'>;
  /** token -> time before which step III is not attempted (this account is not an operator inside the window). */
  step3Park: Map<string, number>;
  /** "token:index:txid" of unfunded relays already topped up once (a second unfunded result parks as before). */
  fundAttempts: Set<string>;
}

export function makeDeps(p: Pick<KeeperDeps, 'backend' | 'chains' | 'contractId'> & Partial<KeeperDeps>): KeeperDeps {
  return { now: Date.now, log: consoleLogger, relayed: new Map(), lastState: new Map(), relayBlock: new Map(), resigns: new Map(), landed: new Set(), landedCheckAt: new Map(), step3Park: new Map(), fundAttempts: new Set(), ...p };
}

export interface ActionRecord {
  kind: 'poke' | 'step' | 'broadcast' | 'mark';
  tokenId: string;
  hash?: string;
  detail?: string;
  ok: boolean;
}

/** Before signing, `from_address` is free text the owner wrote; contract v2 overwrites it with the derived address. */
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;

/**
 * The address an EVM payout is sent from: the address derived from the vault's own `derivation_paths`
 * (authoritative). The stored `from_address` is only a fallback when derivation fails, and only when it is a
 * well-formed EVM address, so a bad value cannot make `eth_getTransactionCount` fail and leave the vault stuck in
 * step 3 (SECURITY_REVIEW_3 K-1).
 */
export async function evmSourceAddress(deps: Pick<KeeperDeps, 'chains' | 'contractId'>, v: VaultView, chain: 'base' | 'monad', index: number): Promise<string> {
  try {
    return (await deps.chains.deriveAddresses(deps.contractId, vaultPaths(v)))[chain];
  } catch (e) {
    const stored = v.foreign[index]?.from_address ?? '';
    if (EVM_ADDRESS.test(stored)) return stored;
    throw e;
  }
}

export async function stepArgsFor(deps: KeeperDeps, v: VaultView, chain: ChainName, index: number): Promise<StepArgs> {
  if (chain === 'base' || chain === 'monad') {
    const from = await evmSourceAddress(deps, v, chain, index);
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
 *  - EVM: as a keeper (contract or vault keeper), fresh honest fees (contract v2 second review G1: a keeper may re-sign at
 *    any fee, the nonce is pinned); otherwise both fees = max(fresh, 1.1 x last), held at the chain cap;
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
    if (oldId) {
      let landed: boolean;
      try {
        landed = await chains.txLanded(chain, oldId);
      } catch (e) {
        // Unknown is not "no": signing again while the old tx may be on chain could pay a Solana heir twice
        // (AUDIT_FINAL_OFFCHAIN F-08). Park the payout and look again later.
        park(RELAY_COOLDOWN.other, 'landed-check');
        log.warn('resign', `${label}: could not check whether ${oldId} landed (${errMsg(e)}); not signing again, retry in ${RELAY_COOLDOWN.other / 1000}s`);
        return { kind: 'wait' };
      }
      if (landed) {
        log.ok('resign', `${label}: the old tx ${oldId} is on chain, not signing again`);
        deps.landed.add(`${key}:${oldId}`);
        return { kind: 'landed', hash: oldId };
      }
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
      // A keeper re-signs at the fresh (honest) fees, even below the last request: an heir or a stranger who signed first
      // cannot lock the payout above an honest fee (second review G1). A non-keeper must bump: max(fresh, 1.1 x last),
      // held at the chain cap (the contract takes a fee at the cap as a bump, F4).
      const keeper = backend.isKeeperFor ? await backend.isKeeperFor(v).catch(() => false) : false;
      args = { evm: keeper ? clampEvm(args.evm, chain) : bumpedEvmArgs(args.evm, track, chain) };
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

/**
 * Step III window (report item 4A): a keeper that is not an operator of this vault may not sign a payout during the
 * first `step3_open_after_ms` after step 3 (or the previous payout) began; the contract panics. Park the vault until
 * the window opens instead of failing every poll, and say once when it will be retried. True = parked, skip it.
 */
export async function step3Parked(deps: KeeperDeps, v: VaultView): Promise<boolean> {
  const id = v.token_id;
  const until = deps.step3Park.get(id);
  if (until !== undefined) {
    if (until > deps.now()) return true;
    deps.step3Park.delete(id);
  }
  const { backend } = deps;
  if (!backend.accountId || !backend.getConfig) return false;
  const cfg = await backend.getConfig().catch(() => null);
  if (!cfg || !(Number(cfg.step3_open_after_ms) > 0)) return false; // unknown or no window: the contract decides
  if (isOperator(backend.accountId, v, cfg, deps.contractId)) return false;
  const opens = step3OpensAt(v, cfg);
  if (opens === null || deps.now() >= opens + STEP3_MARGIN_MS) return false;
  parkStep3(deps, v, opens + STEP3_MARGIN_MS);
  return true;
}

function parkStep3(deps: KeeperDeps, v: VaultView, until: number): void {
  deps.step3Park.set(v.token_id, until);
  const mins = Math.ceil((until - deps.now()) / 60_000);
  deps.log.info(
    'step',
    `vault ${v.token_id} step III: ${deps.backend.accountId ?? 'this account'} is not an operator of this vault (contract keeper, vault keeper, owner or heir), so it may not sign a payout yet; the contract opens signing to anyone at ${new Date(until).toISOString().slice(0, 19)}Z, retrying then (in ${mins} min)`,
  );
}

/** Source addresses of a vault (from its own derivation paths). */
async function sourcesOf(deps: KeeperDeps, v: VaultView): Promise<SourceSet> {
  return deps.chains.deriveAddresses(deps.contractId, vaultPaths(v));
}

/** `--fund-sources`: top up the vault's sources; never throws. */
async function fundSources(deps: KeeperDeps, v: VaultView, only?: Set<number>): Promise<TopUp[]> {
  if (!deps.funder) return [];
  try {
    return await deps.funder.fundVault(v, await sourcesOf(deps, v), only);
  } catch (e) {
    deps.log.err('fund', `vault ${v.token_id}: ${errMsg(e)}`);
    return [];
  }
}

const MAX_ACTIONS_PER_VAULT = 25;

/** Perform every action currently due for one vault. Never throws. */
export async function driveVault(deps: KeeperDeps, initial: VaultView): Promise<ActionRecord[]> {
  return (await driveVaultView(deps, initial)).actions;
}

/** `driveVault`, plus the last view of the vault that was read (its state after the actions). */
export async function driveVaultView(deps: KeeperDeps, initial: VaultView): Promise<{ actions: ActionRecord[]; vault: VaultView }> {
  const { backend, chains, log } = deps;
  const out: ActionRecord[] = [];
  let v = initial;
  const id = v.token_id;
  // A vault outside the filter is not touched at all: no state tracking, no chain lookups, no transactions.
  if (!matchesFilter(v, deps)) return { actions: out, vault: v };

  const noteState = (view: VaultView) => {
    const s = deriveState(view, deps.now());
    const prev = deps.lastState.get(id);
    if (prev !== s) {
      deps.lastState.set(id, s);
      if (prev) {
        log.info('state', `vault ${id}: ${prev} → ${s}`);
        // Only a change this process watched happen is reported, so a restart never repeats a notice.
        if (prev === 'Alive' && s === 'Warning') deps.notifier?.notify('vault_warning', view, deps.now());
        else if (s === 'Triggered') deps.notifier?.notify('vault_triggered', view, deps.now());
      }
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
    if (deps.shouldStop?.()) break;
    // The filter is checked against the view each action is based on. Step 5 hands the NFT to the primary heir,
    // so a vault selected by owner prefix leaves the filter once it is Settled.
    if (!matchesFilter(v, deps)) {
      log.info('filter', `vault ${id} no longer matches the filter (owner is now ${v.owner_id}); not doing: ${describeAction(action)}`);
      break;
    }
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
        if (action.chain && action.index !== undefined) {
          if (await step3Parked(deps, v)) break;
          // Fund before the signature exists: a Solana signature goes stale in ~60-90 s, and a late top-up would need
          // a resign_foreign (keeper only, 5 min cooldown).
          await fundSources(deps, v);
          args = await stepArgsFor(deps, v, action.chain, action.index);
        }
        let tx: TxResult;
        try {
          tx = await backend.executeStep(id, args);
        } catch (e) {
          if (action.chain && STEP3_WINDOW_PANIC.test(errMsg(e))) tx = { hash: 'unknown', logs: [], returnValue: null, failure: errMsg(e) };
          else throw e;
        }
        const label = action.chain ? `step ${action.step}/5 (${action.chain} #${action.index})` : `step ${action.step}/5`;
        if (failed(tx) && action.chain && STEP3_WINDOW_PANIC.test(tx.failure!)) {
          // The contract says the window is still closed for this account (the local check could not tell).
          const cfg = backend.getConfig ? await backend.getConfig().catch(() => null) : null;
          const opens = cfg ? step3OpensAt(v, cfg) : null;
          const until = opens !== null && opens + STEP3_MARGIN_MS > deps.now() ? opens + STEP3_MARGIN_MS : deps.now() + STEP3_UNKNOWN_PARK_MS;
          out.push({ kind: 'step', tokenId: id, hash: tx.hash, ok: false, detail: 'step3_window' });
          parkStep3(deps, v, until);
          break;
        }
        out.push({ kind: 'step', tokenId: id, hash: tx.hash, ok: !failed(tx), detail: `step ${action.step}` });
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
              // --fund-sources: top the source up once for this signed tx and relay again right away.
              const attempt = `${key}:${payoutTxId(p) ?? p.signed_tx}`;
              if (deps.funder && !deps.fundAttempts.has(attempt)) {
                deps.fundAttempts.add(attempt);
                log.warn('relay', `${label} source is unfunded (${errMsg(e)}); topping it up`);
                const r = await fundSources(deps, v);
                if (r.some((t) => t.chain === action.chain && t.indexes.includes(action.index) && (t.status === 'funded' || t.status === 'enough'))) {
                  out.push({ kind: 'broadcast', tokenId: id, ok: false, detail: 'unfunded' });
                  continue; // the same relay action comes next
                }
              }
              const prev = deps.relayBlock.get(key);
              deps.relayBlock.set(key, { until: deps.now() + RELAY_COOLDOWN.unfunded, reason: 'unfunded' });
              // Report the address that really has to be funded: the derived one. The owner-written `from_address` is shown only if derivation fails.
              const from = await deps.chains.deriveAddresses(deps.contractId, vaultPaths(v)).then((a) => (action.chain === 'solana' ? a.solana : a[action.chain])).catch(() => p.from_address || 'the derived address');
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
  return { actions: out, vault: v };
}

export interface TickResult {
  vaults: number;
  actions: ActionRecord[];
  error?: string;
  /**
   * Token ids of matching vaults that still need settlement after this pass (past the deadline, or Triggered).
   * Undefined when the vault list could not be read. Signed payouts waiting for a relay do not count.
   */
  pending?: string[];
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
  const pending: string[] = [];
  vaults = vaults.filter((x) => matchesFilter(x, deps));
  for (const v of vaults) {
    let last = v;
    if (!deps.shouldStop?.()) {
      const r = await driveVaultView(deps, v);
      actions.push(...r.actions);
      last = r.vault;
    }
    if (matchesFilter(last, deps) && needsSettlement(last, deps.now())) pending.push(v.token_id);
  }
  await deps.notifier?.flush();
  return { vaults: vaults.length, actions, pending, error: actions.some((a) => !a.ok && a.detail !== 'not_due' && a.detail !== 'unfunded' && a.detail !== 'stale' && a.detail !== 'step3_window') ? 'action_failed' : undefined };
}

export interface RunOpts {
  pollS: number;
  /** One pass, then return. */
  once?: boolean;
  /** Sweep: return as soon as a pass ends with no matching vault past its deadline or Triggered. */
  untilIdle?: boolean;
  /** Return once this many seconds have passed. No action is started after the limit. */
  maxSeconds?: number;
  signal?: AbortSignal;
  sleepFn?: (ms: number) => Promise<void>;
}

export interface RunResult {
  reason: 'once' | 'idle' | 'time_limit' | 'aborted';
  /** passes run */
  ticks: number;
  /** passes that read the vault list */
  listed: number;
  /** vaults that still needed settlement after the last pass that read the list */
  pending: string[];
}

export async function runKeeper(deps: KeeperDeps, o: RunOpts): Promise<RunResult> {
  const sl = o.sleepFn ?? sleep;
  const { log } = deps;
  const deadline = o.maxSeconds !== undefined ? deps.now() + o.maxSeconds * 1000 : Infinity;
  const timeUp = () => deps.now() >= deadline;
  const d: KeeperDeps = { ...deps, shouldStop: () => !!o.signal?.aborted || timeUp() || !!deps.shouldStop?.() };
  let consecutiveErrors = 0;
  let ticks = 0;
  let listed = 0;
  let pending: string[] = [];
  const done = (reason: RunResult['reason']): RunResult => ({ reason, ticks, listed, pending });
  const stopAtLimit = (): RunResult => {
    log.warn('keeper', `time limit of ${o.maxSeconds}s reached${pending.length ? `; still to settle: vault ${pending.join(', ')} (the next run continues)` : ''}`);
    return done('time_limit');
  };

  log.info('keeper', `watching ${deps.contractId} via ${deps.backend.label}, poll every ${o.pollS}s`);
  if (deps.ownerPrefix !== undefined) log.info('keeper', `only vaults whose owner starts with "${deps.ownerPrefix}"`);
  if (deps.only) log.info('keeper', `only vault ${[...deps.only].join(', ')}`);
  if (o.untilIdle && !o.once) log.info('keeper', `sweep: exits when nothing is left to settle${o.maxSeconds !== undefined ? `, or after ${o.maxSeconds}s` : ''}`);

  while (!o.signal?.aborted) {
    let r: TickResult | undefined;
    try {
      r = await tickOnce(d);
      consecutiveErrors = r.error ? consecutiveErrors + 1 : 0;
    } catch (e) {
      // tickOnce should never throw; belt and braces so the loop survives anything.
      consecutiveErrors++;
      log.err('keeper', `tick crashed: ${errMsg(e)}`);
    }
    ticks++;
    if (r?.pending) {
      listed++;
      pending = r.pending;
    }
    if (o.once) return done('once');
    if (o.untilIdle && r?.pending && r.pending.length === 0) {
      log.ok('keeper', ticks === 1 && r.actions.length === 0 ? 'nothing to settle' : 'nothing left to settle');
      return done('idle');
    }
    if (timeUp()) return stopAtLimit();
    const delay = Math.min(60_000, o.pollS * 1000 * 2 ** Math.min(consecutiveErrors, 4), deadline - deps.now());
    if (consecutiveErrors) log.warn('keeper', `errors in a row: ${consecutiveErrors}, next poll in ${Math.round(delay / 1000)}s`);
    await sl(delay);
    if (timeUp()) return stopAtLimit();
  }
  return done('aborted');
}
