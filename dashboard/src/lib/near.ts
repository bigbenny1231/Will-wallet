import { providers } from "near-api-js";
import { CONTRACT, MOCK, RPC } from "../config";
import type { NftToken, VaultView } from "../types";
import { mockApi } from "./mock";

const provider = new providers.JsonRpcProvider({ url: RPC });

async function view<T>(method: string, args: Record<string, unknown> = {}, contract = CONTRACT): Promise<T> {
  return (await provider.callFunction(contract, method, args)) as T;
}

const PAGE = 50;

/** NEAR implicit accounts (ed25519: 64 hex; eth-implicit: 0x + 40 hex) exist as soon as something is sent to them. */
export const isImplicitAccount = (a: string) => /^[0-9a-f]{64}$/.test(a) || /^0x[0-9a-f]{40}$/.test(a);
const MAX_VAULTS = 1000;

export const api = {
  async getVault(id: string): Promise<VaultView | null> {
    if (MOCK) return mockApi.getVault(id);
    const v = await view<VaultView | null>("get_vault", { token_id: id });
    return v ?? null;
  },
  async nftToken(id: string): Promise<NftToken | null> {
    if (MOCK) return mockApi.nftToken(id);
    const t = await view<NftToken | null>("nft_token", { token_id: id });
    return t ?? null;
  },
  async getVaultsForOwner(account: string): Promise<VaultView[]> {
    if (MOCK) return mockApi.getVaultsForOwner(account);
    return (await view<VaultView[]>("get_vaults_for_owner", { account_id: account })) ?? [];
  },
  /** Pages through get_vaults until a short page comes back. */
  async getAllVaults(): Promise<VaultView[]> {
    if (MOCK) return mockApi.getAllVaults();
    const out: VaultView[] = [];
    for (let from = 0; from < MAX_VAULTS; from += PAGE) {
      const page = (await view<VaultView[]>("get_vaults", { from_index: from, limit: PAGE })) ?? [];
      out.push(...page);
      if (page.length < PAGE) break;
    }
    return out;
  },
  /** The id the next create_vault will mint: get_config().next_id (falls back to nft_total_supply + 1). */
  async nextTokenId(): Promise<string> {
    if (MOCK) return String((await mockApi.getAllVaults()).length + 1);
    try {
      const c = await view<{ next_id: number | string }>("get_config");
      return String(BigInt(c.next_id));
    } catch {
      const n = await view<string | number>("nft_total_supply");
      return String(BigInt(n) + 1n);
    }
  },
  /** The contract's per-chain max_fee_per_gas (get_config().chains[]); Base 100 gwei, Monad 1000 gwei. */
  async getChainFeeCap(chain: string): Promise<bigint> {
    const fallback = chain === "monad" ? 1_000_000_000_000n : 100_000_000_000n;
    if (MOCK) return fallback;
    try {
      const c = await view<{ chains: { chain: string; max_fee_per_gas?: string }[] }>("get_config");
      const e = c.chains.find((x) => x.chain === chain);
      return e?.max_fee_per_gas ? BigInt(e.max_fee_per_gas) : fallback;
    } catch {
      return fallback;
    }
  },
  /**
   * Whether a NEAR account exists (RPC view_account). true/false when the node answered, null when it could not be
   * asked. Implicit accounts (64 hex, or 0x + 40 hex) are created by the first transfer, so they count as existing.
   */
  async accountExists(account: string): Promise<boolean | null> {
    if (isImplicitAccount(account)) return true;
    if (MOCK) return !account.startsWith("missing");
    try {
      await provider.viewAccount(account, { finality: "final" });
      return true;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return /does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(msg) ? false : null;
    }
  },
  async getHeirVaults(account: string): Promise<VaultView[]> {
    const all = await this.getAllVaults();
    return all.filter((v) => v.heirs.some((h) => h.account_id === account));
  },
};
