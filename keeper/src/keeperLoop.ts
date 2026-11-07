// The keeper poll loop (SPEC §3): poke overdue vaults, drive settlement, relay signed foreign txs.
import type { Backend } from './backend.js';
import type { Chains } from './chainsApi.js';
import { deriveState, describeAction, nextAction } from './machine.js';
import type { StepArgs, TxResult, VaultView } from './types.js';
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
}

export function makeDeps(p: Pick<KeeperDeps, 'backend' | 'chains' | 'contractId'> & Partial<KeeperDeps>): KeeperDeps {
  return { now: Date.now, log: consoleLogger, relayed: new Map(), lastState: new Map(), ...p };
}

export interface ActionRecord {
  kind: 'poke' | 'step' | 'broadcast' | 'mark';
  tokenId: string;
  hash?: string;
  detail?: string;
  ok: boolean;
}

export async function stepArgsFor(deps: KeeperDeps, v: VaultView, chain: 'base' | 'solana', index: number): Promise<StepArgs> {
  if (chain === 'base') {
    const from = v.foreign[index].from_address || (await deps.chains.deriveAddresses(deps.contractId, v.token_id)).base;
    return { evm: await deps.chains.evmParams(from) };
  }
  return { solana: await deps.chains.solanaParams() };
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

  for (let i = 0; i < MAX_ACTIONS_PER_VAULT; i++) {
    const action = nextAction(v, deps.now());
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
          // Blockhashes expire fast: if the sign callback did not advance the payout, retry once with a fresh one.
          const after = await backend.getVault(id);
          if (after.state === 'Triggered' && after.step === 3 && after.foreign_index === action.index) {
            log.warn('step', `vault ${id} solana sign did not advance; retrying once with a fresh blockhash`);
            args = await stepArgsFor(deps, after, 'solana', action.index);
            tx = await backend.executeStep(id, args);
            out.push({ kind: 'step', tokenId: id, hash: tx.hash, ok: !failed(tx), detail: 'step 3 retry' });
            log[failed(tx) ? 'err' : 'ok']('step', `vault ${id} ${label} retry  ${nearTxLink(tx.hash)}`);
          }
        }
      } else if (action.kind === 'relay') {
        const p = v.foreign[action.index];
        const key = `${id}:${action.index}`;
        let hash = deps.relayed.get(key);
        if (!hash) {
          hash = action.chain === 'base' ? await chains.broadcastEvm(p.signed_tx!) : await chains.broadcastSolana(p.signed_tx!);
          deps.relayed.set(key, hash);
          out.push({ kind: 'broadcast', tokenId: id, hash, ok: true, detail: action.chain });
          log.ok('relay', `vault ${id} payout #${action.index} ${action.chain} sent  ${foreignTxLink(action.chain, hash)}`);
        }
        const tx = await backend.markBroadcast(id, action.index, hash);
        out.push({ kind: 'mark', tokenId: id, hash: tx.hash, ok: !failed(tx) });
        if (failed(tx)) {
          log.err('mark', `vault ${id} mark_broadcast #${action.index} failed: ${tx.failure}  ${nearTxLink(tx.hash)}`);
          break;
        }
        deps.relayed.delete(key);
        log.ok('mark', `vault ${id} mark_broadcast #${action.index}  ${nearTxLink(tx.hash)}`);
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
  for (const v of vaults) actions.push(...(await driveVault(deps, v)));
  return { vaults: vaults.length, actions, error: actions.some((a) => !a.ok && a.detail !== 'not_due') ? 'action_failed' : undefined };
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
