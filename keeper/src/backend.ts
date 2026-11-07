// The keeper talks to a vault through this interface; NearBackend is the real one, MockBackend lives in mock.ts.
import { Account, KeyPair, KeyPairSigner, providers } from 'near-api-js';
import type { AgentPayArgs, SignTrack, StepArgs, TxResult, VaultView } from './types.js';
import { withRetry } from './util.js';

export interface Backend {
  readonly label: string;
  getVaults(): Promise<VaultView[]>;
  getVault(tokenId: string): Promise<VaultView>;
  heartbeat(tokenId: string): Promise<TxResult>;
  poke(tokenId: string): Promise<TxResult>;
  executeStep(tokenId: string, args?: StepArgs): Promise<TxResult>;
  markBroadcast(tokenId: string, index: number, txHash: string): Promise<TxResult>;
  /** Re-request a signature for a signed/failed payout (expired Solana blockhash, stale EVM nonce). */
  resignForeign(tokenId: string, index: number, args: StepArgs): Promise<TxResult>;
  agentPay(args: AgentPayArgs): Promise<TxResult>;
  /** View: last signing request, last EVM fees and when a re-sign becomes legal. */
  getSignTrack(tokenId: string, index: number): Promise<SignTrack>;
}

type RpcProvider = InstanceType<typeof providers.JsonRpcProvider>;
const TGAS = 10n ** 12n;
export const GAS = {
  // The access-key allowance is charged on PREPAID gas, so keep heartbeat small (contract notes, SPEC 2.7).
  heartbeat: 10n * TGAS,
  poke: 60n * TGAS,
  executeStep: 300n * TGAS,
  markBroadcast: 30n * TGAS,
  resignForeign: 300n * TGAS,
  addKey: 50n * TGAS,
  agentPay: 60n * TGAS,
  daoCreate: 150n * TGAS,
};

export function makeProvider(rpcUrl: string): RpcProvider {
  return new providers.JsonRpcProvider({ url: rpcUrl });
}

export function makeAccount(provider: RpcProvider, accountId: string, privateKey: string): Account {
  const signer = new KeyPairSigner(KeyPair.fromString(privateKey as `ed25519:${string}`));
  return new Account(accountId, provider, signer);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function toTxResult(outcome: any): TxResult {
  const hash: string = outcome?.transaction_outcome?.id ?? outcome?.transaction?.hash ?? 'unknown';
  const all = [outcome?.transaction_outcome, ...(outcome?.receipts_outcome ?? [])];
  const logs: string[] = all.flatMap((o) => o?.outcome?.logs ?? []);
  let returnValue: unknown = null;
  let failure: string | undefined;
  const st = outcome?.status;
  if (st && typeof st === 'object') {
    if ('SuccessValue' in st && st.SuccessValue) {
      const raw = Buffer.from(st.SuccessValue, 'base64').toString('utf8');
      try {
        returnValue = JSON.parse(raw);
      } catch {
        returnValue = raw;
      }
    } else if ('Failure' in st) {
      failure = JSON.stringify(st.Failure);
    }
  }
  if (!failure) {
    for (const o of outcome?.receipts_outcome ?? []) {
      const s = o?.outcome?.status;
      if (s && typeof s === 'object' && 'Failure' in s) {
        failure = JSON.stringify(s.Failure);
        break;
      }
    }
  }
  return { hash, logs, returnValue, failure };
}

export class NearBackend implements Backend {
  readonly label: string;
  constructor(
    private provider: RpcProvider,
    private contractId: string,
    private account: Account,
  ) {
    this.label = `near:${account.accountId}→${contractId}`;
  }

  private view<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return withRetry(async () => (await this.provider.callFunction(this.contractId, method, args)) as T);
  }

  private async call(method: string, args: Record<string, unknown>, gas: bigint, deposit = 0n): Promise<TxResult> {
    return withRetry(async () => {
      const outcome = await this.account.callFunctionRaw({
        contractId: this.contractId,
        methodName: method,
        args,
        gas,
        deposit,
        waitUntil: 'EXECUTED',
      });
      return toTxResult(outcome);
    });
  }

  async getVaults(): Promise<VaultView[]> {
    const limit = 50;
    const out: VaultView[] = [];
    for (let from = 0; ; from += limit) {
      const page = await this.view<VaultView[]>('get_vaults', { from_index: from, limit });
      out.push(...(page ?? []));
      if (!page || page.length < limit) break;
    }
    return out;
  }
  async getVault(tokenId: string): Promise<VaultView> {
    const v = await this.view<VaultView | null>('get_vault', { token_id: tokenId });
    if (!v) throw new Error(`vault ${tokenId} not found on ${this.contractId}`);
    return v;
  }
  heartbeat(tokenId: string) {
    return this.call('heartbeat', { token_id: tokenId }, GAS.heartbeat);
  }
  poke(tokenId: string) {
    return this.call('poke', { token_id: tokenId }, GAS.poke);
  }
  executeStep(tokenId: string, args?: StepArgs) {
    return this.call('execute_step', args ? { token_id: tokenId, args } : { token_id: tokenId }, GAS.executeStep);
  }
  markBroadcast(tokenId: string, index: number, txHash: string) {
    return this.call('mark_broadcast', { token_id: tokenId, index, tx_hash: txHash }, GAS.markBroadcast);
  }
  resignForeign(tokenId: string, index: number, args: StepArgs) {
    return this.call('resign_foreign', { token_id: tokenId, index, args }, GAS.resignForeign);
  }
  async getSignTrack(tokenId: string, index: number): Promise<SignTrack> {
    const t = await this.view<Record<string, unknown>>('get_sign_track', { token_id: tokenId, index });
    return {
      last_request_ms: Number(t.last_request_ms ?? 0),
      inflight: !!t.inflight,
      max_fee_per_gas: String(t.max_fee_per_gas ?? '0'),
      max_priority_fee_per_gas: String(t.max_priority_fee_per_gas ?? '0'),
      resign_allowed_after_ms: Number(t.resign_allowed_after_ms ?? 0),
    };
  }
  agentPay(a: AgentPayArgs) {
    return this.call('agent_pay', a, GAS.agentPay);
  }
}
