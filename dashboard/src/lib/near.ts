import { providers } from "near-api-js";
import { CONTRACT, MOCK, RPC } from "../config";
import type { ContractConfig, NftToken, VaultView } from "../types";
import { mockApi } from "./mock";

const provider = new providers.JsonRpcProvider({ url: RPC });

async function view<T>(method: string, args: Record<string, unknown> = {}, contract = CONTRACT): Promise<T> {
  return (await provider.callFunction(contract, method, args)) as T;
}

const PAGE = 50;

/** NEAR implicit accounts (ed25519: 64 hex; eth-implicit: 0x + 40 hex) exist as soon as something is sent to them. */
export const isImplicitAccount = (a: string) => /^[0-9a-f]{64}$/.test(a) || /^0x[0-9a-f]{40}$/.test(a);
const MAX_VAULTS = 1000;
/** get_vaults_for_owner page size: the contract's maximum (v3, L-5: default 50, at most 100). */
export const OWNER_PAGE = 100;

/**
 * Every vault of an owner from the paged get_vaults_for_owner (v3). Pages until a short page. A pre-v3 contract
 * ignores from_index/limit and returns the whole list every time, so a page that brings no new token id (or is
 * longer than asked) ends the loop too, and duplicates are dropped.
 */
export async function pageOwnerVaults<T extends { token_id: string }>(fetchPage: (fromIndex: number, limit: number) => Promise<T[] | null>, max = MAX_VAULTS): Promise<T[]> {
  const out: T[] = [];
  const seen = new Set<string>();
  for (let from = 0; from < max; from += OWNER_PAGE) {
    const page = (await fetchPage(from, OWNER_PAGE)) ?? [];
    let added = 0;
    for (const v of page) {
      if (seen.has(v.token_id)) continue;
      seen.add(v.token_id);
      out.push(v);
      added++;
    }
    if (page.length < OWNER_PAGE || page.length > OWNER_PAGE || added === 0) break;
  }
  return out;
}

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
  /** All of the owner's vaults: get_vaults_for_owner is paged on v3 (default 50, at most 100 a call). */
  async getVaultsForOwner(account: string): Promise<VaultView[]> {
    if (MOCK) return mockApi.getVaultsForOwner(account);
    return pageOwnerVaults((from_index, limit) => view<VaultView[]>("get_vaults_for_owner", { account_id: account, from_index, limit }));
  },
  /** get_config, or null when it cannot be read. */
  async getConfig(): Promise<ContractConfig | null> {
    if (MOCK) return null;
    try {
      return await view<ContractConfig>("get_config");
    } catch {
      return null;
    }
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
