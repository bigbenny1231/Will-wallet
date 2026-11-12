// The keeper talks to a vault through this interface; NearBackend is the real one, MockBackend lives in mock.ts.
import { Account, KeyPair, KeyPairSigner, providers } from 'near-api-js';
import type { AdminProposal, ChainConfig, ContractConfig } from './step3.js';
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
  /**
   * Whether this backend's account is a keeper for `v` (the contract keeper or the vault keeper). Contract v2 second
   * review G1: a keeper may re-sign a signed EVM payout at any fee, so it sends honest fees instead of a 1.1x bump.
   * Optional: a backend without it is treated as a non-keeper.
   */
  isKeeperFor?(v: VaultView): Promise<boolean>;
  /** The NEAR account this backend signs with (optional: without it the step III window is not checked locally). */
  readonly accountId?: string;
  /** `get_config` fields the keeper uses (keeper, owner_id, step3_open_after_ms, v3 chains clamps). Optional, like `accountId`. */
  getConfig?(): Promise<ContractConfig>;
}

type RpcProvider = InstanceType<typeof providers.JsonRpcProvider>;
const TGAS = 10n ** 12n;
export const GAS = {
  // The access-key allowance is charged on PREPAID gas, so keep heartbeat small (contract notes, SPEC 2.7).
  heartbeat: 10n * TGAS,
  // Contract v3 (SECURITY_FIXES_V3 M-2): poke pays the bounty with a transfer plus a 10 TGas callback, 29.7 TGas of
  // host gas on a maximal vault; callers must attach >= 50 TGas.
  poke: 60n * TGAS,
  // Step 1 / step 5 with 10 heirs: about 253 TGas of host gas (each heir transfer 14.8 TGas of fees + 10 TGas callback).
  executeStep: 300n * TGAS,
  // One vault read and write, no promise.
  markBroadcast: 30n * TGAS,
  // MPC derived-key call, then the sign call and a 30 TGas callback.
  resignForeign: 300n * TGAS,
  // AddKey + 15 TGas on_key_added callback (v3): under 40 TGas.
  addKey: 50n * TGAS,
  // One transfer with its callback: about 30 TGas.
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

const str = (x: unknown): string | null => (typeof x === 'string' ? x : null);
const optNum = (x: unknown): number | undefined => (x === undefined || x === null || !Number.isFinite(Number(x)) ? undefined : Number(x));

/** `get_sign_track` JSON -> SignTrack. `keeper_resigns*` stay undefined on a v2 contract (no cap there). */
export function parseSignTrack(t: Record<string, unknown>): SignTrack {
  const out: SignTrack = {
    last_request_ms: Number(t?.last_request_ms ?? 0),
    inflight: !!t?.inflight,
    max_fee_per_gas: String(t?.max_fee_per_gas ?? '0'),
    max_priority_fee_per_gas: String(t?.max_priority_fee_per_gas ?? '0'),
    resign_allowed_after_ms: Number(t?.resign_allowed_after_ms ?? 0),
  };
  const used = optNum(t?.keeper_resigns);
  const left = optNum(t?.keeper_resigns_left);
  if (used !== undefined) out.keeper_resigns = used;
  if (left !== undefined) out.keeper_resigns_left = left;
  return out;
}

/** `get_config` JSON -> the fields the keeper reads (v1/v2 contracts simply lack the v3 ones). */
export function parseConfig(c: Record<string, unknown>): ContractConfig {
  const p = c?.admin_proposal as Record<string, unknown> | null | undefined;
  const proposal: AdminProposal | null =
    p && typeof p === 'object'
      ? { action: String(p.action) as AdminProposal['action'], account_id: str(p.account_id), proposed_ms: Number(p.proposed_ms ?? 0), eta_ms: Number(p.eta_ms ?? 0) }
      : null;
  const chains = Array.isArray(c?.chains)
    ? (c.chains as Record<string, unknown>[]).map((e): ChainConfig => {
        const out: ChainConfig = { chain: String(e.chain) };
        if (typeof e.kind === 'string') out.kind = e.kind;
        for (const k of ['max_fee_per_gas', 'non_keeper_max_fee_per_gas', 'min_gas_limit'] as const) if (e[k] !== undefined && e[k] !== null) out[k] = String(e[k]);
        const mp = optNum(e.max_payouts);
        const mk = optNum(e.max_keeper_resigns);
        if (mp !== undefined) out.max_payouts = mp;
        if (mk !== undefined) out.max_keeper_resigns = mk;
        return out;
      })
    : undefined;
  return {
    owner_id: str(c?.owner_id),
    keeper: str(c?.keeper),
    // absent on a v1 contract: no window
    step3_open_after_ms: Number(c?.step3_open_after_ms ?? 0) || 0,
    pending_keeper: str(c?.pending_keeper),
    keeper_admin: str(c?.keeper_admin),
    admin_timelock_ms: optNum(c?.admin_timelock_ms),
    admin_proposal: proposal,
    keeper_epoch: optNum(c?.keeper_epoch),
    max_keeper_solana_resigns: optNum(c?.max_keeper_solana_resigns),
    sale_min_interval_s: optNum(c?.sale_min_interval_s),
    sale_min_grace: optNum(c?.sale_min_grace),
    chains,
  };
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

  private async send(method: string, args: Record<string, unknown>, gas: bigint, deposit = 0n): Promise<TxResult> {
    const outcome = await this.account.callFunctionRaw({
      contractId: this.contractId,
      methodName: method,
      args,
      gas,
      deposit,
      waitUntil: 'EXECUTED',
    });
    return toTxResult(outcome);
  }

  /**
   * State-changing call, retried on transport errors. Only for methods where a duplicate execution is harmless
   * because the contract's state machine rejects or ignores it (heartbeat, poke, execute_step, mark_broadcast,
   * resign_foreign). A timeout can mean "sent and executed", so a retry is a second transaction.
   */
  private call(method: string, args: Record<string, unknown>, gas: bigint, deposit = 0n): Promise<TxResult> {
    return withRetry(() => this.send(method, args, gas, deposit));
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
    // Signed by a pulse key on the contract account: no deposit (a function-call key cannot attach one). Signed by
    // the vault owner directly: exactly 1 yoctoNEAR (contract v2, finding F).
    const deposit = this.account.accountId === this.contractId ? 0n : 1n;
    return this.call('heartbeat', { token_id: tokenId }, GAS.heartbeat, deposit);
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
  get accountId(): string {
    return this.account.accountId;
  }
  private config?: { at: number; p: Promise<ContractConfig> };
  /** get_config, cached for a minute (the contract keeper can be handed over; a failed read is retried next time). */
  async getConfig(): Promise<ContractConfig> {
    if (!this.config || Date.now() - this.config.at > 60_000) {
      const p = this.view<Record<string, unknown>>('get_config', {}).then(parseConfig);
      this.config = { at: Date.now(), p };
      p.catch(() => {
        if (this.config?.p === p) this.config = undefined;
      });
    }
    return this.config.p;
  }
  async isKeeperFor(v: VaultView): Promise<boolean> {
    const me = this.account.accountId;
    if (v.keeper_id === me) return true;
    try {
      return (await this.getConfig()).keeper === me;
    } catch {
      return false;
    }
  }
  async getSignTrack(tokenId: string, index: number): Promise<SignTrack> {
    return parseSignTrack(await this.view<Record<string, unknown>>('get_sign_track', { token_id: tokenId, index }));
  }
  agentPay(a: AgentPayArgs) {
    // Never retried: agent_pay moves money, and a retry after an ambiguous timeout would pay twice
    // within the policy (AUDIT_FINAL_OFFCHAIN F-03; agent/src/near.ts already sends it once).
    return this.send('agent_pay', a as unknown as Record<string, unknown>, GAS.agentPay);
  }
}
