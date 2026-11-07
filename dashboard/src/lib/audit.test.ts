// docs/AUDIT_FINAL_OFFCHAIN.md F-11: the wallet error banner text comes from the query string.
import { describe, expect, it } from "vitest";
import { walletMessage } from "../components/TxBanner";

describe("walletMessage", () => {
  it("does not throw on a malformed %-sequence (would blank the page)", () => {
    expect(walletMessage("100% failed %E0%A4%A")).toBe("100% failed %E0%A4%A");
  });
  it("caps length and strips control characters", () => {
    expect(walletMessage("a\u0000b\nc")).toBe("a b c");
    expect(walletMessage("x".repeat(500)).length).toBe(161);
  });
});
