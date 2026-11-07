import { describe, expect, it } from "vitest";
import { fastAuthPath, implicitAccountId, isImplicitAccount } from "./nearAuth";
import { capFees, MAX_EVM_FEE } from "./chains";

describe("NEAR Auth identity -> account", () => {
  it("builds the FastAuth derivation path from the Auth0 subject", () => {
    expect(fastAuthPath("login.testnet.fast-auth.com", "google-oauth2|123")).toBe("jwt#https://login.testnet.fast-auth.com/#google-oauth2|123");
  });
  it("maps an ed25519 key to its implicit account", () => {
    // all-zero key: base58 of 32 zero bytes is 32 "1"s
    expect(implicitAccountId("ed25519:" + "1".repeat(32))).toBe("0".repeat(64));
    // a key observed from v1.signer-prod.testnet.derived_public_key on 2026-11-07
    const id = implicitAccountId("ed25519:FeXV6VWByvcDGiSExszyoo2SPaRBoFu1X9VD6u2rUcJW");
    expect(isImplicitAccount(id)).toBe(true);
  });
  it("rejects non-ed25519 keys", () => {
    expect(() => implicitAccountId("secp256k1:abc")).toThrow();
    expect(() => implicitAccountId("ed25519:111")).toThrow(/32 bytes/);
  });
});

describe("EVM fee caps (Base and Monad)", () => {
  it("keeps max_fee within the contract's 100 gwei cap and priority <= max", () => {
    const gwei = 1_000_000_000n;
    expect(capFees(1n * gwei, 2n * gwei)).toEqual({ max_fee_per_gas: (4n * gwei).toString(), max_priority_fee_per_gas: (2n * gwei).toString() });
    const monad = capFees(100n * gwei, 2n * gwei);
    expect(BigInt(monad.max_fee_per_gas)).toBe(MAX_EVM_FEE);
    const silly = capFees(10n * gwei, 500n * gwei);
    expect(BigInt(silly.max_priority_fee_per_gas)).toBeLessThanOrEqual(BigInt(silly.max_fee_per_gas));
  });
});
