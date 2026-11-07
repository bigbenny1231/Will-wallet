import { describe, expect, it } from "vitest";
import { KeyPair } from "near-api-js";
import { PairingError, loadPulse, pairingAppLink, pairingWebLink, parsePairing, savePulse, validatePairing, PULSE_STORE } from "./pairing";

const secret = KeyPair.fromRandom("ed25519").toString();
const P = { contract: "dmw-x8cx.testnet", token: "12", secret };

describe("pairing links", () => {
  it("app link round-trips", () => {
    const link = pairingAppLink(P);
    expect(link.startsWith("dmw://pulse?c=dmw-x8cx.testnet&t=12&k=ed25519%3A")).toBe(true);
    expect(parsePairing(link)).toEqual(P);
  });

  it("web link puts the key in the fragment, never the query", () => {
    const link = pairingWebLink("https://dmw.example/", P);
    const u = new URL(link);
    expect(u.pathname).toBe("/pulse");
    expect(u.search).toBe("");
    expect(u.hash).toContain("k=ed25519%3A");
    expect(parsePairing(link)).toEqual(P);
  });

  it("accepts a bare fragment, with or without #, and surrounding whitespace", () => {
    const frag = new URL(pairingWebLink("https://x.y", P)).hash;
    expect(parsePairing(frag)).toEqual(P);
    expect(parsePairing(`  ${frag.slice(1)}\n`)).toEqual(P);
  });

  it("accepts a web link with the params in the query (some scanners drop fragments)", () => {
    const q = new URL(pairingWebLink("https://x.y", P)).hash.slice(1);
    expect(parsePairing(`https://x.y/pulse?${q}`)).toEqual(P);
  });

  it("the decoded secret is a usable key whose public half matches", () => {
    const back = parsePairing(pairingAppLink(P));
    expect(KeyPair.fromString(back.secret as `ed25519:${string}`).getPublicKey().toString()).toBe(KeyPair.fromString(secret as `ed25519:${string}`).getPublicKey().toString());
  });

  it("rejects bad input with a readable error", () => {
    expect(() => parsePairing("")).toThrow(PairingError);
    expect(() => parsePairing("dmw://vault?c=a.testnet&t=1&k=x")).toThrow(/not a pulse pairing link/);
    expect(() => parsePairing("https://x.y/vault/1#c=a.testnet&t=1")).toThrow(/not a pulse pairing link/);
    expect(() => parsePairing("c=Bad_Account!&t=1&k=" + encodeURIComponent(secret))).toThrow(/contract/);
    expect(() => parsePairing("c=a.testnet&t=one&k=" + encodeURIComponent(secret))).toThrow(/vault number/);
    expect(() => parsePairing("c=a.testnet&t=1&k=secp256k1:abc")).toThrow(/ed25519/);
    expect(() => validatePairing({ contract: "a.testnet", token: "1", secret: "ed25519:short" })).toThrow(/ed25519/);
  });

  it("refuses to build a link from invalid parts", () => {
    expect(() => pairingAppLink({ ...P, token: "-1" })).toThrow(PairingError);
  });

  it("stores and loads the paired key, ignoring garbage", () => {
    const m = new Map<string, string>();
    const st = { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v) };
    expect(loadPulse(st)).toBeNull();
    savePulse({ ...P, pairedMs: 1, periodS: null, keepAlive: false }, st);
    expect(loadPulse(st)).toMatchObject({ ...P, periodS: null, keepAlive: false });
    m.set(PULSE_STORE, "{not json");
    expect(loadPulse(st)).toBeNull();
    m.set(PULSE_STORE, JSON.stringify({ ...P, secret: "nope" }));
    expect(loadPulse(st)).toBeNull();
  });
});
