// The real NEAR backend of the chain port. It is built from ONE secret: the agent function-call key.
// The signer account is the dmw contract itself, because the contract adds the agent key to its own account
// (add_agent_key -> AddKey FunctionCall{receiver: contract, methods: [agent_pay]}). There is no other account.
import { Account, KeyPair, KeyPairSigner, providers } from 'near-api-js';
import type { AccessKeyInfo, TxResult, VaultChain, VaultView } from './types.js';
import { withRetry } from './util.js';

const TGAS = 10n ** 12n;
/** The key's allowance is charged for PREPAID gas, so keep it modest (SPEC 2.7). */
export const AGENT_PAY_GAS = 60n * TGAS;

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
    } else if ('Failure' in st) failure = JSON.stringify(st.Failure);
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

export class NearChain implements VaultChain {
  readonly label: string;
  readonly publicKey: string;
  private provider: InstanceType<typeof providers.JsonRpcProvider>;
  private account: Account;

  constructor(
    readonly contractId: string,
    agentKey: string,
    rpcUrl = 'https://rpc.testnet.near.org',
  ) {
    const kp = KeyPair.fromString(agentKey as `ed25519:${string}`);
    this.publicKey = kp.getPublicKey().toString();
    this.provider = new providers.JsonRpcProvider({ url: rpcUrl });
    this.account = new Account(contractId, this.provider, new KeyPairSigner(kp));
    this.label = `near:${contractId} (agent key ${this.publicKey.slice(0, 16)}…)`;
  }

  nowMs() {
    return Date.now();
  }

  async getVault(tokenId: string): Promise<VaultView> {
    const v = await withRetry(async () => (await this.provider.callFunction(this.contractId, 'get_vault', { token_id: tokenId })) as VaultView | null);
    if (!v) throw new Error(`vault ${tokenId} not found on ${this.contractId}`);
    return v;
  }

  async viewAccessKey(): Promise<AccessKeyInfo> {
    const k = await withRetry(() => this.provider.viewAccessKey(this.contractId, this.publicKey));
    const p = k.permission as unknown;
    if (p === 'FullAccess') return { kind: 'FullAccess' };
    const fc = (p as { FunctionCall?: { allowance?: string | null; receiver_id: string; method_names: string[] } }).FunctionCall;
    if (!fc) return { kind: 'FullAccess' }; // unknown shape: treat as the dangerous case
    return { kind: 'FunctionCall', receiver_id: fc.receiver_id, method_names: fc.method_names, allowance: fc.allowance == null ? null : String(fc.allowance) };
  }

  async agentPay(args: { token_id: string; receiver_id: string; amount: string; memo?: string }): Promise<TxResult> {
    // No retry: a signed transaction is sent once. A retry could double-spend within the allowlist.
    const outcome = await this.account.callFunctionRaw({
      contractId: this.contractId,
      methodName: 'agent_pay',
      args,
      gas: AGENT_PAY_GAS,
      deposit: 0n,
      waitUntil: 'EXECUTED',
    });
    return toTxResult(outcome);
  }
}
