import { describe, expect, it } from "vitest";
import { deriveFor } from "./derive";
import { CHAINS, CHAIN_ORDER } from "./chainmeta";
import { toSmallest, unitsFor } from "./format";

describe("Monad (chain id 10143)", () => {
  it("has its own derived EVM address on path monad-<id>", () => {
    const d = deriveFor("7", "dmw-x8cx.testnet");
    expect(d.monad).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(d.monad).not.toBe(d.base);
    expect(deriveFor("7", "dmw-x8cx.testnet").monad).toBe(d.monad);
    expect(deriveFor("8", "dmw-x8cx.testnet").monad).not.toBe(d.monad);
    expect(CHAINS.monad.path("7")).toBe("monad-7");
  });
  it("is in the picker with MON units and the Monad explorer", () => {
    expect(CHAIN_ORDER).toContain("monad");
    expect(CHAINS.monad.tx("0xabc")).toBe("https://testnet.monadexplorer.com/tx/0xabc");
    expect(toSmallest("monad", "0.25")).toBe("250000000000000000");
    expect(unitsFor("monad", "250000000000000000")).toBe("0.25 MON");
  });
});
