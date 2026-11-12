import { describe, expect, it } from "vitest";
import { groupPayouts, listNames, payoutNames, payoutTxUrl } from "./payoutStatus";

const EVM = "0x" + "ab".repeat(32);
const SOL = "5".repeat(87);

describe("foreign payout status", () => {
  it("links a relayed payout to its chain's explorer", () => {
    expect(payoutTxUrl({ chain: "base", status: "broadcast", tx_hash: EVM })).toBe(`https://sepolia.basescan.org/tx/${EVM}`);
    expect(payoutTxUrl({ chain: "monad", status: "broadcast", tx_hash: EVM })).toBe(`https://testnet.monadexplorer.com/tx/${EVM}`);
    expect(payoutTxUrl({ chain: "solana", status: "broadcast", tx_hash: SOL })).toBe(`https://explorer.solana.com/tx/${SOL}?cluster=devnet`);
  });

  it("gives no link before a broadcast or for a hash that is not one for that chain", () => {
    expect(payoutTxUrl({ chain: "base", status: "signed", tx_hash: null })).toBeNull();
    expect(payoutTxUrl({ chain: "base", status: "signed", tx_hash: EVM })).toBeNull();
    expect(payoutTxUrl({ chain: "base", status: "broadcast", tx_hash: SOL })).toBeNull();
    expect(payoutTxUrl({ chain: "solana", status: "broadcast", tx_hash: EVM })).toBeNull();
    expect(payoutTxUrl({ chain: "solana", status: "broadcast", tx_hash: "dao-ratified" })).toBeNull();
  });

  it("groups payouts by their recorded status", () => {
    const g = groupPayouts([
      { chain: "base", status: "broadcast", tx_hash: EVM },
      { chain: "monad", status: "signed", tx_hash: null },
      { chain: "solana", status: "failed", tx_hash: null },
      { chain: "base", status: "pending", tx_hash: null },
    ]);
    expect(g.relayed.map((p) => p.chain)).toEqual(["base"]);
    expect(g.signed.map((p) => p.chain)).toEqual(["monad"]);
    expect(g.failed.map((p) => p.chain)).toEqual(["solana"]);
    expect(g.pending.map((p) => p.chain)).toEqual(["base"]);
  });

  it("names chains in a sentence", () => {
    expect(listNames([])).toBe("");
    expect(listNames(["Base"])).toBe("Base");
    expect(listNames(["Base", "Solana"])).toBe("Base and Solana");
    expect(payoutNames([{ chain: "base", status: "signed" }, { chain: "monad", status: "signed" }, { chain: "solana", status: "signed" }])).toBe("Base, Monad and Solana");
  });
});
