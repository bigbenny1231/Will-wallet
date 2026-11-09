import { describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import {
  FaucetError,
  GUEST_PLAN,
  GUEST_PREFIX,
  createGuestAccount,
  guestAlias,
  guestError,
  guestStage,
  implicitIdOf,
  isGuestAccount,
  newGuestSession,
  parseGuest,
  planDeposit,
  publicKeyOf,
} from "./guest";
import { agentPayCall } from "./calls";
import { describe as describeEvent, recordRows } from "../components/Record";

const NEAR = 10n ** 24n;
const C = "dmw-test.testnet";

describe("guest session", () => {
  it("names the account with the guest prefix and binds it to the contract", () => {
    const s = newGuestSession(C, 1000);
    expect(s.accountId).toMatch(/^dmw-guest-[0-9a-f]{8}\.testnet$/);
    expect(isGuestAccount(s.accountId)).toBe(true);
    expect(s.accountId.startsWith(GUEST_PREFIX)).toBe(true);
    expect(s.contract).toBe(C);
    expect(s.token).toBeNull();
    expect(s.armed).toBe(false);
    expect(s.createdMs).toBe(1000);
  });

  it("makes two heirs whose shares add up, as implicit accounts it holds the keys for", () => {
    const s = newGuestSession(C);
    expect(s.heirs.map((h) => h.name)).toEqual(["Sarah", "Ben"]);
    expect(s.heirs.reduce((n, h) => n + h.bps, 0)).toBe(10_000);
    for (const h of s.heirs) {
      expect(h.accountId).toMatch(/^[0-9a-f]{64}$/);
      expect(implicitIdOf(h.secret)).toBe(h.accountId);
    }
    expect(s.provider).toMatch(/^[0-9a-f]{64}$/);
    // five different keys: owner, two heirs, pulse, agent
    expect(new Set([s.secret, s.pulseSecret, s.agentSecret, ...s.heirs.map((h) => h.secret)]).size).toBe(5);
  });

  it("derives the implicit id as the hex of the public key", () => {
    const kp = KeyPair.fromRandom("ed25519");
    const id = implicitIdOf(kp.toString());
    expect(id).toBe(Array.from(kp.getPublicKey().data, (b) => b.toString(16).padStart(2, "0")).join(""));
    expect(publicKeyOf(kp.toString())).toBe(kp.getPublicKey().toString());
  });

  it("round-trips through storage and rejects anything malformed or made for another contract", () => {
    const s = newGuestSession(C);
    const raw = JSON.stringify({ ...s, token: "7", armed: true });
    expect(parseGuest(raw, C)).toMatchObject({ accountId: s.accountId, token: "7", armed: true });
    expect(parseGuest(raw, "other.testnet")).toBeNull();
    expect(parseGuest(null, C)).toBeNull();
    expect(parseGuest("{", C)).toBeNull();
    expect(parseGuest(JSON.stringify({ ...s, accountId: "alice.testnet" }), C)).toBeNull();
    expect(parseGuest(JSON.stringify({ ...s, accountId: "dmw-guest-x.near" }), C)).toBeNull();
    expect(parseGuest(JSON.stringify({ ...s, secret: "ed25519:short" }), C)).toBeNull();
    expect(parseGuest(JSON.stringify({ ...s, token: "1; drop" }), C)).toBeNull();
    // an heir id that does not match its key is a tampered session
    expect(parseGuest(JSON.stringify({ ...s, heirs: [{ ...s.heirs[0], accountId: "0".repeat(64) }] }), C)).toBeNull();
  });

  it("gives display names only to accounts the session made", () => {
    const s = newGuestSession(C);
    expect(guestAlias(s, s.accountId)).toBe("You");
    expect(guestAlias(s, s.heirs[0].accountId)).toBe("Sarah");
    expect(guestAlias(s, s.heirs[1].accountId)).toBe("Ben");
    expect(guestAlias(s, s.provider)).toBe("API provider");
    expect(guestAlias(s, "stranger.testnet")).toBeNull();
    expect(guestAlias(null, s.accountId)).toBeNull();
  });
});

describe("planDeposit", () => {
  it("uses the full plan on a fresh faucet account and keeps gas money back", () => {
    expect(planDeposit(10n * NEAR)).toBe(GUEST_PLAN.deposit);
    expect(planDeposit(GUEST_PLAN.deposit + GUEST_PLAN.keepForGas)).toBe(GUEST_PLAN.deposit);
  });
  it("shrinks to whole tenths when less is left, never below the minimum", () => {
    expect(planDeposit(5n * NEAR + 37n)).toBe((38n * NEAR) / 10n);
    expect(planDeposit(GUEST_PLAN.minDeposit + GUEST_PLAN.keepForGas)).toBe(GUEST_PLAN.minDeposit);
    expect(planDeposit(GUEST_PLAN.minDeposit + GUEST_PLAN.keepForGas - 1n)).toBeNull();
    expect(planDeposit(0n)).toBeNull();
  });
  it("always leaves room for two key allowances, the invoice and the bounty", () => {
    const afterStorage = GUEST_PLAN.minDeposit - NEAR / 10n;
    expect(afterStorage - 2n * NEAR - GUEST_PLAN.invoice - GUEST_PLAN.bounty).toBeGreaterThan(NEAR / 10n);
  });
});

describe("guestStage", () => {
  const v = (state: "Alive" | "Warning" | "Triggered" | "Settled", trigger_at_ms = 10_000) => ({ state, trigger_at_ms });
  it("follows the chain first, then the local stop", () => {
    expect(guestStage(v("Alive"), null, 1)).toBe("alive");
    expect(guestStage(v("Warning"), null, 1)).toBe("alive"); // a late beat: still beating
    expect(guestStage(v("Alive"), 5, 6)).toBe("silence");
    expect(guestStage(v("Warning"), 5, 9_999)).toBe("silence");
    expect(guestStage(v("Warning"), 5, 10_000)).toBe("due");
    expect(guestStage(v("Warning"), null, 10_000)).toBe("due"); // away long enough: due even without a stop
    expect(guestStage(v("Triggered"), 5, 1)).toBe("settling");
    expect(guestStage(v("Settled"), null, 1)).toBe("settled");
  });
});

describe("faucet", () => {
  const s = newGuestSession(C);
  it("posts the new account id and public key, and never the secret", async () => {
    let body = "";
    const f = (async (_url: unknown, init?: RequestInit) => {
      body = String(init?.body);
      return { ok: false, status: 500 } as Response;
    }) as typeof fetch;
    await expect(createGuestAccount(s, f)).rejects.toBeInstanceOf(FaucetError);
    expect(JSON.parse(body)).toEqual({ newAccountId: s.accountId, newAccountPublicKey: publicKeyOf(s.secret) });
    expect(body).not.toContain(s.secret.slice(8));
  });
  it("explains a rate limit and an unreachable faucet", async () => {
    const limited = (async () => ({ ok: false, status: 429 }) as Response) as typeof fetch;
    await expect(createGuestAccount(s, limited)).rejects.toThrow(/rate-limiting/);
    const down = (async () => {
      throw new TypeError("Failed to fetch");
    }) as typeof fetch;
    await expect(createGuestAccount(s, down)).rejects.toThrow(/could not be reached/);
  });
  it("turns node errors into one sentence", () => {
    expect(guestError(new Error("Failed to fetch"))).toMatch(/did not answer/);
    expect(guestError(new Error("NotEnoughBalance: ..."))).toMatch(/run out of test NEAR/);
    expect(guestError(new FaucetError("x"))).toBe("x");
    expect(guestError(new Error("z".repeat(500))).length).toBeLessThan(210);
  });
});

describe("agentPayCall", () => {
  it("builds agent_pay with no deposit (a function-call key cannot attach one)", () => {
    expect(agentPayCall("3", "api.testnet", "120000000000000000000000", "INV-1")).toEqual({
      method: "agent_pay",
      args: { token_id: "3", receiver_id: "api.testnet", amount: "120000000000000000000000", memo: "INV-1" },
      gas: "60000000000000",
    });
    expect(agentPayCall("3", "api.testnet", "1").args).toEqual({ token_id: "3", receiver_id: "api.testnet", amount: "1" });
    expect(agentPayCall("3", "api.testnet", "1").deposit).toBeUndefined();
  });
});

describe("the record", () => {
  const sarah = "7ce3f60c33c163cee4fec8cd4947019238e694f6c26dbf783ceb4ddc1b0d7f3e";
  const alias = (id: string) => (id === sarah ? "Sarah" : null);
  // Detail strings as the deployed contract writes them (a real guest run on testnet, Nov 9 2026).
  const log = [
    { ms: 1, event: "vault_created", detail: "dmw-guest-786d660b.testnet" },
    { ms: 2, event: "key_add_requested", detail: "heartbeat ed25519:HQKCWt3LJNmw2zkRannoFC7D36dJNcv3NKFRGZZ1sGo9" },
    { ms: 2, event: "foreign_set", detail: "2 payouts" },
    { ms: 3, event: "key_added", detail: "heartbeat ed25519:HQKCWt3LJNmw2zkRannoFC7D36dJNcv3NKFRGZZ1sGo9" },
    { ms: 4, event: "agent_pay_allowed", detail: `${sarah} 120000000000000000000000` },
    { ms: 5, event: "heartbeat", detail: "pulse_key" },
    { ms: 6, event: "heartbeat", detail: "pulse_key" },
    { ms: 7, event: "agent_pay_denied", detail: "receiver_not_allowlisted stranger.testnet 3780000000000000000000000" },
    { ms: 8, event: "heartbeat", detail: "pulse_key" },
    { ms: 9, event: "triggered", detail: "by dmw-guest-786d660b.testnet, bounty 50000000000000000000000" },
    { ms: 10, event: "step_1", detail: `${sarah} 2.178 NEAR, b292c83dfbfe4fe637d69abc99ea169c76df4131673c555f1a44003a3af040bb 1.452 NEAR` },
    { ms: 11, event: "step_2", detail: "2 keys deleted" },
    { ms: 12, event: "foreign_signed", detail: "#0 signed 0x704002fbb43b57df00190efb2be2e31deef9b1802c809d83355adf4b639ffa4a" },
    { ms: 13, event: "step_3", detail: "foreign payouts done" },
    { ms: 14, event: "step_4", detail: "no dao; skipped" },
    { ms: 15, event: "step_5", detail: `will nft -> ${sarah}` },
    { ms: 15, event: "settled", detail: sarah },
  ];
  const rows = recordRows(log, alias);

  it("is newest first and folds runs of heartbeats", () => {
    expect(rows[0].title).toBe("Settled");
    expect(rows[rows.length - 1].title).toBe("Vault created, Will NFT minted");
    const beats = rows.filter((r) => /heartbeat/i.test(r.title));
    expect(beats.map((r) => r.title)).toEqual(["Heartbeat", "2 heartbeats"]);
    expect(beats[1]).toMatchObject({ ms: 5, untilMs: 6, detail: "by a pulse key" });
  });
  it("drops a key request once the key has arrived", () => {
    expect(rows.filter((r) => /Key/.test(r.title)).map((r) => r.title)).toEqual(["Key added"]);
    expect(rows.find((r) => r.title === "Key added")!.detail).toMatch(/^pulse key ed25519:HQKCWt3LJN…/);
  });
  it("names the people, the amounts and the reason", () => {
    expect(rows.find((r) => r.title === "Settled")!.detail).toBe("held by Sarah");
    expect(rows.find((r) => r.title.startsWith("Step I:"))!.detail).toBe("2.178 NEAR to Sarah, 1.452 NEAR to b292c83d…f040bb");
    expect(rows.find((r) => r.title === "Agent payment denied")).toMatchObject({ tone: "dead", detail: "3.78 NEAR to stranger.testnet: receiver not allowlisted" });
    expect(rows.find((r) => r.title === "Agent payment allowed")!.detail).toBe("0.12 NEAR to Sarah");
    expect(rows.find((r) => r.title === "Triggered")!.detail).toBe("poked by dmw-guest-786d660b.testnet, bounty 0.05 NEAR");
    expect(rows.find((r) => r.title.startsWith("Step V"))!.detail).toBe("to Sarah");
    expect(rows.find((r) => r.title.startsWith("Step III: payout 1"))!.detail).toBe("tx 0x704002fb…9ffa4a");
  });
  it("reads the claim line: who claimed, and how much", () => {
    expect(describeEvent({ ms: 1, event: "claim", detail: `${sarah} 100000000000000000000000` }, alias)).toEqual({ tone: "plain", title: "Remaining balance claimed", detail: "0.1 NEAR by Sarah" });
  });
  it("falls back to the raw event for anything it does not know", () => {
    expect(describeEvent({ ms: 1, event: "something_new", detail: "x" })).toEqual({ tone: "plain", title: "something new", detail: "x" });
  });
});
