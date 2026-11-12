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
