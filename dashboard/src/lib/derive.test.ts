import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { deriveFor, deriveForVault, legacyPaths, sourceAddressFor, vaultPaths } from "./derive";
import { CHAINS, CHAIN_ORDER } from "./chainmeta";
import { toSmallest, unitsFor } from "./format";

describe("Monad (chain id 10143)", () => {
  it("has its own derived EVM address on its own path", () => {
    const d = deriveFor(legacyPaths("7"), "dmw-x8cx.testnet");
    expect(d.monad).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(d.monad).not.toBe(d.base);
    expect(deriveFor(legacyPaths("7"), "dmw-x8cx.testnet").monad).toBe(d.monad);
    expect(deriveFor(legacyPaths("8"), "dmw-x8cx.testnet").monad).not.toBe(d.monad);
    expect(legacyPaths("7").monad).toBe("monad-7");
    expect(CHAINS.monad.pathShape).toBe("monad-<vault id>-<salt>");
  });
  it("is in the picker with MON units and the Monad explorer", () => {
    expect(CHAIN_ORDER).toContain("monad");
    expect(CHAINS.monad.tx("0xabc")).toBe("https://testnet.monadexplorer.com/tx/0xabc");
    expect(toSmallest("monad", "0.25")).toBe("250000000000000000");
    expect(unitsFor("monad", "250000000000000000")).toBe("0.25 MON");
  });
});

describe("v2 salted derivation paths", () => {
  const salted = { base: "base-7-1a2b3c4d5e6f7081", monad: "monad-7-1a2b3c4d5e6f7081", solana: "sol-7-1a2b3c4d5e6f7081" };
  it("derives from the paths in the vault view, not from the token id", () => {
    const v2 = deriveForVault({ token_id: "7", derivation_paths: salted }, "dmw-x8cx.testnet");
    const v1 = deriveForVault({ token_id: "7" }, "dmw-x8cx.testnet");
    expect(v2.base).not.toBe(v1.base);
    expect(v2.monad).not.toBe(v1.monad);
    expect(v2.solana).not.toBe(v1.solana);
    expect(v2).toEqual(deriveFor(salted, "dmw-x8cx.testnet"));
    // another salt, another address: nobody can predict it before create_vault draws the salt
    const other = { base: "base-7-ffffffffffffffff", monad: "monad-7-ffffffffffffffff", solana: "sol-7-ffffffffffffffff" };
    expect(deriveFor(other, "dmw-x8cx.testnet").base).not.toBe(v2.base);
  });
  it("falls back to the unsalted v1 paths only when the view has none", () => {
    expect(vaultPaths({ token_id: "3" })).toEqual({ base: "base-3", monad: "monad-3", solana: "sol-3" });
    expect(vaultPaths({ token_id: "3", derivation_paths: salted })).toBe(salted);
  });
  it("the contract builds the same path shape", () => {
    const foreign = readFileSync(resolve(__dirname, "../../../contracts/dmw/src/foreign.rs"), "utf8");
    expect(foreign).toContain('format!("{prefix}-{token_id}-{salt}")');
    expect(foreign).toContain('None => "sol"');
  });
});

describe("source address shown and used for a payout (Vault.tsx, stepArgsFor)", () => {
  it("is the derived address, never the owner-typed from_address", () => {
    const salted = { base: "base-9-0011223344556677", monad: "monad-9-0011223344556677", solana: "sol-9-0011223344556677" };
    const v = { token_id: "9", derivation_paths: salted, foreign: [{ chain: "base" as const, from_address: "0x3b5C0d41e2A9F6c7d8E1b2A3c4D5e6F708192a3b" }] };
    const shown = sourceAddressFor(v, "base", "dmw-x8cx.testnet");
    expect(shown).toBe(deriveFor(salted, "dmw-x8cx.testnet").base);
    expect(shown.toLowerCase()).not.toBe(v.foreign[0].from_address.toLowerCase());
  });
});
