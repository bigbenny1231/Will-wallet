import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as C from "./calls";
import { parseAgentLog, parseStep1Detail, step1AmountFor } from "./logparse";
import { currentForeign } from "./chains";
import type { ForeignPayout, VaultView } from "../types";

const TGAS = 10n ** 12n;
const gas = (n: number) => (BigInt(n) * TGAS).toString();
const NEAR = 10n ** 24n;
const PK = "ed25519:GvJMaRQJAYFvdPH91PqiHThKJcVehVf1vFtLG3bHHWXm";

// ---- the contract's own signatures, parsed from lib.rs, so a drifting arg name fails the test ----
const LIB = readFileSync(resolve(__dirname, "../../../contracts/dmw/src/lib.rs"), "utf8");
const NFT = readFileSync(resolve(__dirname, "../../../contracts/dmw/src/nft.rs"), "utf8");

function sig(src: string, name: string): { all: string[]; required: string[] } {
  const m = src.match(new RegExp(`pub fn ${name}\\(([^)]*)\\)`, "s"));
  if (!m) throw new Error(`method ${name} not found`);
  const params = m[1]
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith("&"))
    .map((s) => {
      const [n, t] = s.split(/:\s*/);
      return { n, optional: t.startsWith("Option<") };
    });
  return { all: params.map((p) => p.n), required: params.filter((p) => !p.optional).map((p) => p.n) };
}

function expectMatchesContract(c: { method: string; args: Record<string, unknown> }, src = LIB) {
  const s = sig(src, c.method);
  const keys = Object.keys(c.args);
  for (const k of keys) expect(s.all, `${c.method}: unknown arg ${k}`).toContain(k);
  for (const r of s.required) expect(keys, `${c.method}: missing required arg ${r}`).toContain(r);
}

const heirs = [
  { account_id: "dmw-heir-cdeb.testnet", bps: 6000 },
  { account_id: "heir-kvo.testnet", bps: 4000 },
];
const policy = { per_tx_max: "500000000000000000000000", daily_max: "800000000000000000000000", allowlist: ["heir-kvo.testnet"] };
const payout: ForeignPayout = {
  chain: "base",
  to: "0x7a3f1c9d5e2b48a6f0c1d3e5b7a9c2d4e6f80123",
  amount: "20000000000000000",
  from_address: "0x3b5C0d41e2A9F6c7d8E1b2A3c4D5e6F708192a3b",
  status: "pending",
  signed_tx: null,
  tx_hash: null,
};

describe("gas table", () => {
  it("matches the agreed budget", () => {
    expect(C.GAS.heartbeat).toBe(gas(10));
    expect(C.GAS.addKey).toBe(gas(50));
    expect(C.GAS.executeStep).toBe(gas(300));
    expect(C.GAS.create).toBe(gas(100));
    expect(C.GAS.other).toBe(gas(30));
  });
});

describe("create_vault", () => {
  const draft: C.CreateDraft = {
    heartbeat_interval_s: 120,
    grace_missed: 1,
    heirs,
    policy,
    bounty: "50000000000000000000000",
    depositYocto: (6n * NEAR + C.STORAGE_FEE_YOCTO).toString(),
    foreign: [],
    dao_id: null,
  };
  it("exact args, 100 TGas, deposit passed through", () => {
    const c = C.createVaultCall(draft);
    expect(c).toEqual({
      method: "create_vault",
      args: { heartbeat_interval_s: 120, grace_missed: 1, heirs, policy, bounty: "50000000000000000000000" },
      deposit: "6100000000000000000000000",
      gas: gas(100),
    });
    expectMatchesContract(c);
  });
  it("sends a zero bounty instead of silently falling back to the 0.01 NEAR default", () => {
    expect(C.createVaultCall({ ...draft, bounty: "0" }).args.bounty).toBe("0");
  });
  it("omits bounty only when undefined", () => {
    expect("bounty" in C.createVaultCall({ ...draft, bounty: undefined }).args).toBe(false);
  });
  it("storage fee constant is 0.1 NEAR and key allowance is 1 NEAR", () => {
    expect(C.STORAGE_FEE_YOCTO).toBe(NEAR / 10n);
    expect(C.KEY_ALLOWANCE_YOCTO).toBe(NEAR);
    expect(LIB).toContain("pub const STORAGE_FEE: u128 = near(100)");
    expect(LIB).toContain("pub const KEY_ALLOWANCE: u128 = near(1000)");
  });
});

describe("simple calls", () => {
  const cases: [string, ReturnType<typeof C.heartbeatCall>, { args: Record<string, unknown>; gas: string; deposit?: string }][] = [
    ["deposit", C.depositCall("4", "1000"), { args: { token_id: "4" }, gas: gas(30), deposit: "1000" }],
    ["heartbeat", C.heartbeatCall("4"), { args: { token_id: "4" }, gas: gas(10) }],
    ["add_pulse_key", C.addPulseKeyCall("4", PK), { args: { token_id: "4", public_key: PK }, gas: gas(50), deposit: "1" }],
    ["add_agent_key", C.addAgentKeyCall("4", PK), { args: { token_id: "4", public_key: PK }, gas: gas(50), deposit: "1" }],
    ["remove_key", C.removeKeyCall("4", PK), { args: { token_id: "4", public_key: PK }, gas: gas(30), deposit: "1" }],
    ["set_heirs", C.setHeirsCall("4", heirs), { args: { token_id: "4", heirs }, gas: gas(30), deposit: "1" }],
    ["set_policy", C.setPolicyCall("4", policy), { args: { token_id: "4", policy }, gas: gas(30), deposit: "1" }],
    ["set_foreign_payouts", C.setForeignPayoutsCall("4", [payout]), { args: { token_id: "4", payouts: [payout] }, gas: gas(30), deposit: "1" }],
    ["set_dao", C.setDaoCall("4", "estate-4.sputnik-v2.testnet"), { args: { token_id: "4", dao_id: "estate-4.sputnik-v2.testnet" }, gas: gas(30), deposit: "1" }],
    ["set_timing", C.setTimingCall("4", 20, 1), { args: { token_id: "4", heartbeat_interval_s: 20, grace_missed: 1 }, gas: gas(30), deposit: "1" }],
    ["poke", C.pokeCall("4"), { args: { token_id: "4" }, gas: gas(30) }],
    ["execute_step", C.executeStepCall("4"), { args: { token_id: "4" }, gas: gas(300) }],
    ["mark_broadcast", C.markBroadcastCall("4", 0, "0xabc"), { args: { token_id: "4", index: 0, tx_hash: "0xabc" }, gas: gas(30) }],
    ["claim", C.claimCall("4"), { args: { token_id: "4" }, gas: gas(30) }],
  ];
  for (const [name, call, want] of cases) {
    it(`${name}: exact args, gas and deposit, and the arg names exist in lib.rs`, () => {
      expect(call.method).toBe(name);
      expect(call.args).toEqual(want.args);
      expect(call.gas).toBe(want.gas);
      expect(call.deposit).toBe(want.deposit); // undefined = no attached deposit
      expectMatchesContract(call);
    });
  }
  it("1 yocto exactly where lib.rs asserts it (review 2 M-6): owner mutators and pause, not heartbeat/claim", () => {
    const owner = ["add_pulse_key", "add_agent_key", "remove_key", "set_heirs", "set_policy", "set_foreign_payouts", "set_dao", "set_timing", "set_guardian", "pause"];
    for (const m of owner) expect(LIB).toMatch(new RegExp(`#\\[payable\\]\\s+pub fn ${m}\\(`));
    expect(LIB).toMatch(/fn require_owner_mutable\(&self, v: &Vault\) \{\s+assert_one_yocto\(\);/);
    expect(LIB).toMatch(/pub fn pause\(&mut self, token_id: TokenRef\) -> u64 \{\s+(\/\/.*\s+)*assert_one_yocto\(\);/);
    for (const m of ["heartbeat", "poke", "execute_step", "mark_broadcast", "claim"]) expect(LIB).not.toMatch(new RegExp(`#\\[payable\\]\\s+pub fn ${m}\\(`));
    expect(C.setGuardianCall("4", null).deposit).toBe("1");
  });
  it("set_dao null clears the DAO", () => {
    expect(C.setDaoCall("4", null).args).toEqual({ token_id: "4", dao_id: null });
  });
});

describe("execute_step args", () => {
  const evm = { nonce: 3, max_fee_per_gas: "1500000000", max_priority_fee_per_gas: "1000000", gas_limit: "21000" };
  it("passes StepArgs under `args` for step 3", () => {
    const c = C.executeStepCall("4", { evm });
    expect(c.args).toEqual({ token_id: "4", args: { evm } });
    expect(c.gas).toBe(gas(300));
    expectMatchesContract(c);
    expect(C.executeStepCall("4", { solana: { recent_blockhash: "abc" } }).args).toEqual({ token_id: "4", args: { solana: { recent_blockhash: "abc" } } });
  });
  it("omits args when empty", () => {
    expect(C.executeStepCall("4", {}).args).toEqual({ token_id: "4" });
  });
  it("EvmArgs / SolanaArgs field names match foreign.rs", () => {
    const foreign = readFileSync(resolve(__dirname, "../../../contracts/dmw/src/foreign.rs"), "utf8");
    for (const f of ["nonce", "max_fee_per_gas", "max_priority_fee_per_gas", "gas_limit"]) expect(foreign).toContain(`pub ${f}:`);
    expect(foreign).toContain("pub recent_blockhash: String");
    for (const f of Object.keys(evm)) expect(foreign).toContain(`pub ${f}:`);
  });
});

describe("nft_transfer", () => {
  it("needs exactly 1 yoctoNEAR, string token id, no approval_id", () => {
    const c = C.nftTransferCall("dmw-heir-cdeb.testnet", "4");
    expect(c).toEqual({ method: "nft_transfer", args: { receiver_id: "dmw-heir-cdeb.testnet", token_id: "4" }, deposit: "1", gas: gas(30) });
    expectMatchesContract(c, NFT);
    expect(NFT).toContain("assert_one_yocto()");
  });
  it("adds memo only when given", () => {
    expect(C.nftTransferCall("a.testnet", "4", "gift").args).toEqual({ receiver_id: "a.testnet", token_id: "4", memo: "gift" });
  });
});

describe("create follow-ups", () => {
  it("toPayouts forces pending/null and keeps from_address a string", () => {
    const [p] = C.toPayouts([{ chain: "solana", to: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", amount: "50000000", from_address: "" }], ["F7Zk3xq2nWb8PpVd1sA9mYtRu6HcLe4JgNvQoXiK2BaT"]);
    expect(p).toEqual({
      chain: "solana",
      to: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin",
      amount: "50000000",
      from_address: "F7Zk3xq2nWb8PpVd1sA9mYtRu6HcLe4JgNvQoXiK2BaT",
      status: "pending",
      signed_tx: null,
      tx_hash: null,
    });
  });
  it("followUpCalls: set_foreign_payouts then set_dao, 30 TGas and 1 yocto each, nothing when empty", () => {
    const calls = C.followUpCalls("7", [payout], "estate-7.sputnik-v2.testnet");
    expect(calls.map((c) => c.method)).toEqual(["set_foreign_payouts", "set_dao"]);
    expect(calls.every((c) => c.gas === gas(30) && c.deposit === "1")).toBe(true);
    expect(C.followUpCalls("7", [], null)).toEqual([]);
  });
});

describe("log parsing against the contract's formats", () => {
  it("step_1 detail: '<account> <amount> NEAR, ...' (real vault 4 output)", () => {
    const d = "dmw-heir-cdeb.testnet 1.29 NEAR, heir-kvo.testnet 0.86 NEAR";
    expect(parseStep1Detail(d)).toEqual([
      { account: "dmw-heir-cdeb.testnet", amount: "1.29" },
      { account: "heir-kvo.testnet", amount: "0.86" },
    ]);
    expect(step1AmountFor(d, "heir-kvo.testnet")).toBe("0.86");
    expect(step1AmountFor(d, "nobody.testnet")).toBeNull();
    expect(parseStep1Detail("")).toEqual([]);
    expect(parseStep1Detail(undefined)).toEqual([]);
  });
  it("does not confuse an account that is a suffix of another", () => {
    expect(step1AmountFor("my-heir.testnet 2 NEAR, heir.testnet 1 NEAR", "heir.testnet")).toBe("1");
  });
  it("agent_pay_allowed / denied details", () => {
    expect(parseAgentLog({ ms: 1, event: "agent_pay_allowed", detail: "heir-kvo.testnet 300000000000000000000000" })).toMatchObject({
      allowed: true,
      receiver: "heir-kvo.testnet",
      amount: "300000000000000000000000",
      reason: "",
    });
    expect(parseAgentLog({ ms: 2, event: "agent_pay_denied", detail: "over_per_tx_max heir-kvo.testnet 900000000000000000000000" })).toMatchObject({
      allowed: false,
      reason: "over_per_tx_max",
      receiver: "heir-kvo.testnet",
      amount: "900000000000000000000000",
    });
    expect(parseAgentLog({ ms: 3, event: "agent_pay_denied", detail: "receiver_not_allowlisted dmw-owner-cdeb.testnet 100000000000000000000000" }).reason).toBe("receiver_not_allowlisted");
  });
  it("record() detail formats still look like this in lib.rs", () => {
    expect(LIB).toContain('format!("{r} {receiver_id} {}", amount.0)');
    expect(LIB).toContain('format!("{receiver_id} {}", amount.0)');
    expect(LIB).toContain('format!("{a} {} NEAR", fmt_near(*amt))');
  });
});

describe("step 3 current payout", () => {
  const base = { step: 3, foreign: [payout, { ...payout, chain: "solana" as const }], foreign_index: 1 } as unknown as VaultView;
  it("is foreign[foreign_index] during step 3 only", () => {
    expect(currentForeign(base)?.chain).toBe("solana");
    expect(currentForeign({ ...base, step: 2 })).toBeNull();
    expect(currentForeign({ ...base, foreign_index: 2 })).toBeNull();
  });
});

describe("guardian calls (SPEC 2.8)", () => {
  it("set_guardian names a guardian with a pause length", () => {
    const c = C.setGuardianCall("4", "ana.testnet", 3600);
    expect(c).toEqual({ method: "set_guardian", args: { token_id: "4", guardian_id: "ana.testnet", max_pause_s: 3600 }, deposit: "1", gas: gas(30) });
    expectMatchesContract(c);
  });
  it("set_guardian with null clears it and sends no pause length", () => {
    const c = C.setGuardianCall("4", null);
    expect(c.args).toEqual({ token_id: "4", guardian_id: null });
    expectMatchesContract(c);
  });
  it("pause takes only the token", () => {
    const c = C.pauseCall("4");
    expect(c).toEqual({ method: "pause", args: { token_id: "4" }, deposit: "1", gas: gas(30) });
    expectMatchesContract(c);
  });
  it("pause range matches the contract constants", () => {
    expect(LIB).toMatch(new RegExp(`MIN_PAUSE_S: u64 = ${C.PAUSE_RANGE_S.min};`));
    expect(LIB).toMatch(/MAX_PAUSE_S: u64 = 90 \* 24 \* 3600;/);
    expect(C.PAUSE_RANGE_S.max).toBe(90 * 24 * 3600);
  });
});
