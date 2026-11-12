import { describe, expect, it } from "vitest";
import { missingAccounts, missingHeirsNote } from "./accounts";
import { isImplicitAccount } from "./near";

describe("heir accounts that do not exist (view_account)", () => {
  it("reports only the accounts the RPC says are missing; unknown answers raise no warning", async () => {
    const answers: Record<string, boolean | null> = { "sarah.testnet": true, "tom.testnet": false, "flaky.testnet": null };
    const asked: string[] = [];
    const exists = async (id: string) => {
      asked.push(id);
      if (id === "boom.testnet") throw new Error("rpc down");
      return answers[id] ?? null;
    };
    const m = await missingAccounts(["sarah.testnet", " tom.testnet ", "tom.testnet", "flaky.testnet", "boom.testnet", "", "Not An Id"], exists);
    expect(m).toEqual(["tom.testnet"]);
    expect(asked.sort()).toEqual(["boom.testnet", "flaky.testnet", "sarah.testnet", "tom.testnet"]);
  });
  it("words the warning for one or several accounts, and stays quiet when all exist", () => {
    expect(missingHeirsNote([])).toBeNull();
    expect(missingHeirsNote(["tom.testnet"])).toMatch(/^No account named tom\.testnet exists/);
    expect(missingHeirsNote(["a.testnet", "b.testnet"])).toMatch(/a\.testnet, b\.testnet/);
  });
  it("treats implicit accounts as existing (the first transfer creates them)", () => {
    expect(isImplicitAccount("a".repeat(64))).toBe(true);
    expect(isImplicitAccount("0x" + "b".repeat(40))).toBe(true);
    expect(isImplicitAccount("sarah.testnet")).toBe(false);
  });
});

describe("EVM payout recipients that are contracts (eth_getCode, contract v2 second review G1)", () => {
  it("flags only EVM recipients with code, once each; Solana, bad addresses and RPC errors raise no warning", async () => {
    const { contractRecipients, contractRecipientsNote } = await import("./chains");
    const safe = "0x" + "ab".repeat(20);
    const eoa = "0x" + "cd".repeat(20);
    const boom = "0x" + "ef".repeat(20);
    const asked: string[] = [];
    const getCode = async (chain: string, to: string) => {
      asked.push(`${chain}:${to}`);
      if (to === boom) throw new Error("rpc down");
      return to === safe ? "0x6080" : "0x";
    };
    const found = await contractRecipients(
      [
        { chain: "base", to: safe },
        { chain: "base", to: ` ${safe} ` },
        { chain: "monad", to: eoa },
        { chain: "base", to: boom },
        { chain: "solana", to: "8opHzTAnfzRpPEx21XtnrVTX28YQuCpAjcn1PczScKh" },
        { chain: "base", to: "0x123" },
      ],
      getCode,
    );
    expect(found).toEqual([{ chain: "base", to: safe }]);
    expect(asked.length).toBe(3);
    expect(contractRecipientsNote([])).toBeNull();
    expect(contractRecipientsNote(found)).toMatch(/^This payout recipient is a contract: 0xabab…abab \(base\)\. .*50,000 gas/);
  });
});
