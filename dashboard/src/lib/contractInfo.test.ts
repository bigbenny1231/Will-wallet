import { describe, expect, it, vi } from "vitest";
import { adminProposalNote } from "./contractInfo";
import { OWNER_PAGE, pageOwnerVaults } from "./near";

describe("admin proposal note (contract v3 get_config)", () => {
  const eta = Date.UTC(2026, 10, 14, 9, 30);
  it("says nothing without a proposal or on a pre-v3 config", () => {
    expect(adminProposalNote(null, 0)).toBeNull();
    expect(adminProposalNote({ admin_proposal: null }, 0)).toBeNull();
    expect(adminProposalNote({}, 0)).toBeNull();
  });
  it("names the action, the account and when anyone may execute it", () => {
    const cfg = { admin_proposal: { action: "keeper" as const, account_id: "k2.testnet", proposed_ms: eta - 172_800_000, eta_ms: eta } };
    expect(adminProposalNote(cfg, eta - 1)).toBe("Pending admin proposal: new contract keeper k2.testnet; executable from 2026-11-14 09:30 UTC.");
    expect(adminProposalNote(cfg, eta)).toBe("Pending admin proposal: new contract keeper k2.testnet; executable now (since 2026-11-14 09:30 UTC).");
    expect(adminProposalNote({ admin_proposal: { ...cfg.admin_proposal, action: "keeper", account_id: null } }, 0)).toContain("none (the role is cleared)");
    expect(adminProposalNote({ admin_proposal: { ...cfg.admin_proposal, action: "mpc_signer", account_id: "v2.signer.testnet" } }, 0)).toContain("new MPC signer v2.signer.testnet");
  });
});

describe("get_vaults_for_owner paging (contract v3: default 50, at most 100)", () => {
  const vaults = (from: number, n: number) => Array.from({ length: n }, (_, i) => ({ token_id: String(from + i) }));
  it("pages by 100 until a short page", async () => {
    const all = vaults(0, 250);
    const fetch = vi.fn(async (from: number, limit: number) => all.slice(from, from + limit));
    const got = await pageOwnerVaults(fetch);
    expect(got).toHaveLength(250);
    expect(fetch.mock.calls).toEqual([[0, OWNER_PAGE], [100, OWNER_PAGE], [200, OWNER_PAGE]]);
  });
  it("an exact multiple ends on the empty page", async () => {
    const all = vaults(0, 200);
    const fetch = vi.fn(async (from: number, limit: number) => all.slice(from, from + limit));
    expect(await pageOwnerVaults(fetch)).toHaveLength(200);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
  it("a pre-v3 contract that ignores paging (same full list every time) is read once, without duplicates", async () => {
    const all = vaults(0, 100);
    const fetch = vi.fn(async () => all);
    expect(await pageOwnerVaults(fetch)).toHaveLength(100);
    expect(fetch).toHaveBeenCalledTimes(2); // the second page brings nothing new
    const big = vaults(0, 130);
    const fetchBig = vi.fn(async () => big);
    expect(await pageOwnerVaults(fetchBig)).toHaveLength(130);
    expect(fetchBig).toHaveBeenCalledTimes(1); // longer than asked: not paged
  });
  it("null is an empty page", async () => {
    expect(await pageOwnerVaults(async () => null)).toEqual([]);
  });
});
