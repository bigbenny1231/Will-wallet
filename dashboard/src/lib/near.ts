import { providers } from "near-api-js";
import { CONTRACT, MOCK, RPC } from "../config";
import type { NftToken, VaultView } from "../types";
import { mockApi } from "./mock";

const provider = new providers.JsonRpcProvider({ url: RPC });

async function view<T>(method: string, args: Record<string, unknown> = {}, contract = CONTRACT): Promise<T> {
  return (await provider.callFunction(contract, method, args)) as T;
}

const PAGE = 50;
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
  async getHeirVaults(account: string): Promise<VaultView[]> {
    const all = await this.getAllVaults();
    return all.filter((v) => v.heirs.some((h) => h.account_id === account));
  },
};
