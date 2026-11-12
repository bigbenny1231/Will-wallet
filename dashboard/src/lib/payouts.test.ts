import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { MAX_FOREIGN, U64_MAX, assertValidPayouts, isSolanaAddress, payoutProblems } from "./payouts";

const SOL = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const EVM = "0x7a3f1c9d5e2b48a6f0c1d3e5b7a9c2d4e6f80123";
const FOREIGN = readFileSync(resolve(__dirname, "../../../contracts/dmw/src/foreign.rs"), "utf8");
const LIB = readFileSync(resolve(__dirname, "../../../contracts/dmw/src/lib.rs"), "utf8");

describe("Solana address (foreign.rs is_solana_address)", () => {
  it("accepts base58 of exactly 32 bytes, at most 44 characters", () => {
    expect(isSolanaAddress(SOL)).toBe(true);
    expect(isSolanaAddress("11111111111111111111111111111112")).toBe(true); // 31 zero bytes + 1
    expect(isSolanaAddress("HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr")).toBe(true); // the guest run's example
  });
  it("refuses other lengths and non-base58 characters, even when they look like an address", () => {
    expect(isSolanaAddress(SOL.slice(0, 40))).toBe(false); // valid base58, 29-30 bytes
    expect(isSolanaAddress("1".repeat(33))).toBe(false); // 33 zero bytes
    expect(isSolanaAddress("0" + SOL.slice(1))).toBe(false);
    expect(isSolanaAddress(SOL + "1")).toBe(false); // 45 characters
    expect(isSolanaAddress("")).toBe(false);
    expect(FOREIGN).toMatch(/s\.len\(\) <= 44\s+&& near_sdk::bs58::decode\(s\)[\s\S]{0,60}b\.len\(\) == 32/);
  });
});

describe("payoutProblems (set_foreign_payouts, contract v3)", () => {
  it("passes a valid set: Base x2, Monad, Solana", () => {
    expect(
      payoutProblems([
        { chain: "base", to: EVM, amount: "1" },
        { chain: "base", to: EVM, amount: "2" },
        { chain: "monad", to: EVM, amount: "3" },
        { chain: "solana", to: SOL, amount: String(U64_MAX) },
      ]),
    ).toEqual([]);
  });
  it("at most one Solana payout per vault, with a clear reason", () => {
    const p = payoutProblems([{ chain: "solana", to: SOL, amount: "1" }, { chain: "solana", to: SOL, amount: "2" }]);
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(/^Only one Solana payout per vault/);
    expect(LIB).toContain("too many {} payouts (max {max} per vault)");
    expect(FOREIGN).toMatch(/SOLANA_MAX_PAYOUTS: usize = 1;/);
  });
  it("one Monad payout, four in all", () => {
    expect(payoutProblems([{ chain: "monad", to: EVM, amount: "1" }, { chain: "monad", to: EVM, amount: "1" }])).toEqual(["At most 1 Monad payout per vault (this has 2)."]);
    const five = Array.from({ length: 5 }, () => ({ chain: "base" as const, to: EVM, amount: "1" }));
    expect(payoutProblems(five)[0]).toBe(`At most ${MAX_FOREIGN} foreign payouts per vault (this has 5).`);
    expect(LIB).toContain(`pub const MAX_FOREIGN: usize = ${MAX_FOREIGN};`);
  });
  it("Solana amount within u64 lamports; any amount above 0 and an integer", () => {
    expect(payoutProblems([{ chain: "solana", to: SOL, amount: (U64_MAX + 1n).toString() }])).toEqual([
      "Payout 1: a Solana amount must fit in 64 bits of lamports (at most about 18.4 billion SOL).",
    ]);
    expect(payoutProblems([{ chain: "base", to: EVM, amount: (U64_MAX + 1n).toString() }])).toEqual([]); // EVM wei: u128
    expect(payoutProblems([{ chain: "base", to: EVM, amount: "0" }])).toEqual(["Payout 1: enter an amount above 0."]);
    expect(payoutProblems([{ chain: "base", to: EVM, amount: "" }])).toEqual(["Payout 1: enter an amount above 0."]);
    expect(payoutProblems([{ chain: "base", to: EVM, amount: "1.5" }])).toEqual(["Payout 1: enter an amount above 0."]);
  });
  it("EVM to is 0x + 40 hex; Solana to is checked per payout, numbered as on the form", () => {
    expect(payoutProblems([{ chain: "base", to: "0x7a3f", amount: "1" }, { chain: "solana", to: EVM, amount: "1" }])).toEqual([
      "Payout 1: a Base address is 0x followed by 40 hex characters.",
      "Payout 2: a Solana address is a base58 public key of 32 bytes (32 to 44 characters, no 0, O, I or l).",
    ]);
    expect(payoutProblems([{ chain: "monad", to: EVM.slice(2), amount: "1" }])[0]).toMatch(/Monad address is 0x/);
  });
  it("assertValidPayouts throws every reason at once", () => {
    expect(() => assertValidPayouts([{ chain: "solana", to: "x", amount: "0" }])).toThrow(/32 bytes[\s\S]*above 0/);
    expect(() => assertValidPayouts([{ chain: "solana", to: SOL, amount: "1" }])).not.toThrow();
  });
});
