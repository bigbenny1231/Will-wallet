// Heir sign-in with Google through NEAR Auth (FastAuth). See docs/near-auth.md.
//
// NEAR Auth keys are held by the MPC network. For a login identity `sub`, the key is
//   v1.signer-prod.testnet.derived_public_key({ path: "jwt#https://<auth0 domain>/#<sub>", predecessor: "fast-auth.testnet", domain_id: 1 })
// (this is what @fast-auth-near/browser-sdk's FastAuthSigner.getPublicKey() calls). The NEAR implicit account for
// that ed25519 key is the hex of its 32 bytes, so a Google identity maps to one NEAR account id with no wallet,
// no relayer and nothing on chain. NEAR sent to it at settlement creates the account.
import bs58 from "bs58";
import { sha256 } from "@noble/hashes/sha2.js";
import { providers } from "near-api-js";
import { MOCK, NEAR_AUTH, NETWORK, RPC, SIGNER_CONTRACT } from "../config";
import { mockApi } from "./mock";

export interface HeirIdentity {
  /** Auth0 subject, e.g. "google-oauth2|1067…" */
  sub: string;
  email?: string;
  /** ed25519:<base58> derived by the MPC network for this identity. */
  publicKey: string;
  /** 64-hex implicit account controlled by that key. */
  implicitId: string;
  /** Named accounts that hold the key as an access key (best effort, via nearblocks). */
  named: string[];
}

export const fastAuthPath = (domain: string, sub: string) => `jwt#https://${domain}/#${sub}`;

/** "ed25519:<base58 32 bytes>" -> 64 lowercase hex characters (a NEAR implicit account id). */
export function implicitAccountId(publicKey: string): string {
  const m = /^ed25519:([1-9A-HJ-NP-Za-km-z]+)$/.exec(publicKey.trim());
  if (!m) throw new Error("Not an ed25519 public key");
  const bytes = bs58.decode(m[1]);
  if (bytes.length !== 32) throw new Error("An ed25519 public key has 32 bytes");
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export const isImplicitAccount = (id: string) => /^[0-9a-f]{64}$/.test(id);

/** NEAR Auth works only from origins registered as callback URLs on the Auth0 client. */
export function nearAuthAvailable(origin = typeof window === "undefined" ? "" : window.location.origin): boolean {
  if (MOCK) return true;
  return !!NEAR_AUTH.clientId && NEAR_AUTH.origins.includes(origin);
}

const provider = new providers.JsonRpcProvider({ url: RPC });

export async function derivedPublicKey(sub: string): Promise<string> {
  const pk = await provider.callFunction(SIGNER_CONTRACT, "derived_public_key", {
    path: fastAuthPath(NEAR_AUTH.domain, sub),
    predecessor: NEAR_AUTH.fastAuthContract,
    domain_id: 1,
  });
  return String(pk);
}

/** Accounts holding `publicKey` (nearblocks v3; rate limited, so failures return []). */
export async function accountsForKey(publicKey: string): Promise<string[]> {
  const base = NETWORK === "mainnet" ? "https://api.nearblocks.io" : "https://api-testnet.nearblocks.io";
  try {
    const r = await fetch(`${base}/v3/keys/${encodeURIComponent(publicKey)}`);
    if (!r.ok) return [];
    const j = (await r.json()) as { data?: { account_id?: string }[] | { keys?: { account_id?: string }[] } };
    const rows = Array.isArray(j.data) ? j.data : j.data?.keys ?? [];
    return [...new Set(rows.map((x) => x.account_id).filter((x): x is string => !!x && !isImplicitAccount(x)))];
  } catch {
    return [];
  }
}

const STORE = "dmw-heir-auth";

export function loadIdentity(): HeirIdentity | null {
  try {
    return JSON.parse(sessionStorage.getItem(STORE) || "null");
  } catch {
    return null;
  }
}

async function auth0() {
  const { createAuth0Client } = await import("@auth0/auth0-spa-js");
  return createAuth0Client({
    domain: NEAR_AUTH.domain,
    clientId: NEAR_AUTH.clientId,
    authorizationParams: { redirect_uri: window.location.origin },
    cacheLocation: "localstorage",
  });
}

/** Google popup through NEAR Auth's Auth0 tenant, then the MPC-derived key and its implicit account. */
export async function continueWithGoogle(): Promise<HeirIdentity> {
  let sub: string;
  let email: string | undefined;
  if (MOCK) {
    sub = "google-oauth2|104857600000000000001";
    email = "sarah@example.com";
  } else {
    const client = await auth0();
    await client.loginWithPopup({ authorizationParams: { connection: "google-oauth2", prompt: "select_account" } });
    const claims = await client.getIdTokenClaims();
    if (!claims?.sub) throw new Error("Google sign-in finished without an identity");
    sub = claims.sub;
    email = claims.email;
  }
  const publicKey = MOCK ? `ed25519:${bs58.encode(sha256(new TextEncoder().encode(sub)))}` : await derivedPublicKey(sub);
  const implicitId = implicitAccountId(publicKey);
  const named = MOCK ? [] : await accountsForKey(publicKey);
  if (MOCK) mockApi.nameImplicitHeir(implicitId);
  const id: HeirIdentity = { sub, email, publicKey, implicitId, named };
  sessionStorage.setItem(STORE, JSON.stringify(id));
  return id;
}

export async function signOutGoogle(): Promise<void> {
  sessionStorage.removeItem(STORE);
  if (MOCK || !nearAuthAvailable()) return;
  try {
    const client = await auth0();
    await client.logout({ openUrl: false });
  } catch {
    /* the local session is already gone */
  }
}
