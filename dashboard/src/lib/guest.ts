// Guest mode: a throwaway NEAR testnet account made in this browser, so a visitor can run a whole estate
// (create, heartbeat, agent payments, silence, settlement, claim) without a wallet.
//
// What lives where:
//   - the guest account `dmw-guest-<hex>.testnet` is created by the public testnet faucet with a full-access key
//     generated here; that key signs create_vault, the owner calls, and later poke / execute_step (as a keeper);
//   - the heirs and the API provider are NEAR implicit accounts (the 64-hex form of an ed25519 public key), so they
//     need no faucet call: the first transfer creates them, and the key generated here controls them;
//   - the pulse key and the agent key are the same function-call keys every vault uses (SPEC 2.7).
// Everything is stored in localStorage under GUEST_STORE. It is testnet only and holds faucet funds only.
import { Account, KeyPair, KeyPairSigner, providers, transactions } from "near-api-js";
import { CONTRACT, NETWORK, RPC } from "../config";
import type { CallArgs, VaultView } from "../types";

export const GUEST_PREFIX = "dmw-guest-";
export const GUEST_STORE = "dmw-guest";
export const FAUCET_URL = "https://helper.nearprotocol.com/account";

/** The guest vault's clock: a beat is due every 30 s, and one missed beat is allowed. */
export const GUEST_INTERVAL_S = 30;
export const GUEST_GRACE = 1;
/** The browser beats this often while the guest is "alive" (2.5 beats per interval). */
export const GUEST_BEAT_MS = 12_000;

const NEAR = 10n ** 24n;
const tenths = (n: number) => (BigInt(n) * NEAR) / 10n;

/** Amounts of the guest plan, in yoctoNEAR. */
export const GUEST_PLAN = {
  /** A fresh faucet account holds about 10 NEAR. */
  deposit: tenths(60),
  /** A second run on the same account uses what is left. Below this the run needs a new account. */
  minDeposit: tenths(30),
  /** Kept on the guest account for gas (poke and the settlement steps). */
  keepForGas: tenths(12),
  bounty: tenths(1) / 2n, // 0.05
  perTxMax: tenths(5),
  dailyMax: NEAR,
  invoice: tenths(1) + tenths(1) / 5n, // 0.12
} as const;

export interface GuestHeir {
  name: string;
  accountId: string;
  secret: string;
  bps: number;
}

export interface GuestTx {
  ms: number;
  label: string;
  hash: string | null;
  /** Shown instead of a hash when the node or the contract said no. */
  note?: string;
}

export interface GuestSession {
  v: 1;
  /** A session belongs to the contract it was created for. */
  contract: string;
  accountId: string;
  secret: string;
  heirs: GuestHeir[];
  /** Implicit account the agent may pay (the vault's allowlist). */
  provider: string;
  pulseSecret: string;
  agentSecret: string;
  /** Vault id once create_vault has landed. */
  token: string | null;
  /** True once the pulse and agent keys are registered. */
  armed: boolean;
  createdMs: number;
  /** When the guest held to stop the heartbeat. */
  stoppedMs: number | null;
  txs: GuestTx[];
}

export const guestAvailable = (): boolean => NETWORK === "testnet";

export function isGuestAccount(id: string | null | undefined): boolean {
  return !!id && id.startsWith(GUEST_PREFIX);
}

const hex = (u: Uint8Array) => Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

/** NEAR implicit account id of an ed25519 key: the 64 hex characters of its public key. */
export function implicitIdOf(secret: string): string {
  return hex(KeyPair.fromString(secret as `ed25519:${string}`).getPublicKey().data);
}

export function publicKeyOf(secret: string): string {
  return KeyPair.fromString(secret as `ed25519:${string}`).getPublicKey().toString();
}

const newSecret = (): string => KeyPair.fromRandom("ed25519").toString();

function randomHex(bytes: number): string {
  const u = new Uint8Array(bytes);
  crypto.getRandomValues(u);
  return hex(u);
}

/** A new session: keys only. Nothing is sent anywhere until `createGuestAccount`. */
export function newGuestSession(contract = CONTRACT, now = Date.now()): GuestSession {
  const heir = (name: string, bps: number): GuestHeir => {
    const secret = newSecret();
    return { name, accountId: implicitIdOf(secret), secret, bps };
  };
  return {
    v: 1,
    contract,
    accountId: `${GUEST_PREFIX}${randomHex(4)}.testnet`,
    secret: newSecret(),
    heirs: [heir("Sarah", 6000), heir("Ben", 4000)],
    provider: implicitIdOf(newSecret()),
    pulseSecret: newSecret(),
    agentSecret: newSecret(),
    token: null,
    armed: false,
    createdMs: now,
    stoppedMs: null,
    txs: [],
  };
}

const SECRET_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{64,90}$/;
const IMPLICIT_RE = /^[0-9a-f]{64}$/;

/** Reads a stored session; anything malformed, or made for another contract, reads as "no session". */
export function parseGuest(raw: string | null, contract = CONTRACT): GuestSession | null {
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as GuestSession;
    if (s?.v !== 1 || s.contract !== contract) return null;
    if (!isGuestAccount(s.accountId) || !/^[a-z0-9-]+\.testnet$/.test(s.accountId)) return null;
    if (![s.secret, s.pulseSecret, s.agentSecret].every((k) => SECRET_RE.test(k))) return null;
    if (!Array.isArray(s.heirs) || s.heirs.length === 0) return null;
    for (const h of s.heirs) if (!IMPLICIT_RE.test(h.accountId) || !SECRET_RE.test(h.secret) || implicitIdOf(h.secret) !== h.accountId) return null;
    if (!IMPLICIT_RE.test(s.provider)) return null;
    if (s.token !== null && !/^\d{1,20}$/.test(s.token)) return null;
    return { ...s, armed: !!s.armed, stoppedMs: s.stoppedMs ?? null, txs: Array.isArray(s.txs) ? s.txs.slice(-60) : [] };
  } catch {
    return null;
  }
}

export function loadGuest(storage: Pick<Storage, "getItem"> = localStorage): GuestSession | null {
  try {
    return parseGuest(storage.getItem(GUEST_STORE));
  } catch {
    return null;
  }
}

export function saveGuest(s: GuestSession | null, storage: Pick<Storage, "setItem" | "removeItem"> = localStorage): void {
  try {
    if (s) storage.setItem(GUEST_STORE, JSON.stringify(s));
    else storage.removeItem(GUEST_STORE);
  } catch {
    /* private mode: the run still works until the tab closes */
  }
}

/** Display name for an account the guest session made ("Sarah", "Ben", "the API provider"), else null. */
export function guestAlias(s: GuestSession | null, accountId: string): string | null {
  if (!s) return null;
  if (accountId === s.accountId) return "You";
  if (accountId === s.provider) return "API provider";
  return s.heirs.find((h) => h.accountId === accountId)?.name ?? null;
}

/**
 * How much the vault gets from an account holding `available` yocto: the full plan when it fits, a smaller vault
 * when the account has already paid for one run, null when a new account is needed.
 */
export function planDeposit(available: bigint): bigint | null {
  const room = available - GUEST_PLAN.keepForGas;
  if (room >= GUEST_PLAN.deposit) return GUEST_PLAN.deposit;
  if (room >= GUEST_PLAN.minDeposit) return (room / tenths(1)) * tenths(1);
  return null;
}

export type GuestStage = "alive" | "silence" | "due" | "settling" | "settled";

/** Where the run stands, from the chain view and the one local fact (did the guest stop the pulse). */
export function guestStage(v: Pick<VaultView, "state" | "trigger_at_ms">, stoppedMs: number | null, now: number): GuestStage {
  if (v.state === "Settled") return "settled";
  if (v.state === "Triggered") return "settling";
  if (now >= v.trigger_at_ms) return "due";
  return stoppedMs ? "silence" : "alive";
}

// ---------------------------------------------------------------------------------------------- chain

const provider = new providers.JsonRpcProvider({ url: RPC });

export function accountFor(accountId: string, secret: string): Account {
  return new Account(accountId, provider, new KeyPairSigner(KeyPair.fromString(secret as `ed25519:${string}`)));
}

export class FaucetError extends Error {}

/** Asks the public testnet faucet to create the account with this session's key. Resolves once it exists. */
export async function createGuestAccount(s: GuestSession, fetchImpl: typeof fetch = fetch): Promise<void> {
  let res: Response;
  try {
    res = await fetchImpl(FAUCET_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ newAccountId: s.accountId, newAccountPublicKey: publicKeyOf(s.secret) }),
    });
  } catch {
    throw new FaucetError("The testnet faucet could not be reached. Check the connection and try again.");
  }
  if (!res.ok) {
    throw new FaucetError(
      res.status === 429
        ? "The testnet faucet is rate-limiting this address. Try again in a minute, or connect a testnet wallet."
        : `The testnet faucet answered ${res.status}. Try again in a minute, or connect a testnet wallet.`,
    );
  }
  // The faucet answers before every node has the account.
  for (let i = 0; i < 12; i++) {
    if ((await guestBalance(s.accountId)) !== null) return;
    await new Promise((r) => setTimeout(r, 700));
  }
  throw new FaucetError("The faucet accepted the request but the account has not appeared yet. Try again.");
}

/** Available balance in yocto, or null when the account does not exist. */
export async function guestBalance(accountId: string): Promise<bigint | null> {
  try {
    const st = await new Account(accountId, provider).getState();
    return st.balance.available;
  } catch (e) {
    if (/does not exist|UNKNOWN_ACCOUNT|doesn't exist/i.test(e instanceof Error ? e.message : String(e))) return null;
    throw e;
  }
}

export interface SentTx {
  hash: string | null;
  /** Decoded JSON return value of the last call, when there is one. */
  value: unknown;
}

function decodeValue(outcome: unknown): unknown {
  const st = (outcome as { status?: { SuccessValue?: string } } | undefined)?.status;
  const b64 = st && typeof st === "object" ? st.SuccessValue : undefined;
  if (!b64) return undefined;
  try {
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))));
  } catch {
    return undefined;
  }
}

/**
 * Signs one transaction to the contract carrying every call as an action. `quick` returns as soon as the
 * transaction is in a block (used for the MPC step, whose callback can take longer than an RPC request).
 */
export async function sendAs(signer: Account, calls: CallArgs[], opts: { quick?: boolean; contract?: string } = {}): Promise<SentTx> {
  const out = await signer.signAndSendTransaction({
    receiverId: opts.contract ?? CONTRACT,
    actions: calls.map((c) => transactions.functionCall(c.method, c.args, BigInt(c.gas ?? "100000000000000"), BigInt(c.deposit ?? "0"))),
    waitUntil: opts.quick ? "INCLUDED" : "EXECUTED_OPTIMISTIC",
  });
  return { hash: out?.transaction?.hash ?? (out as { transaction_outcome?: { id?: string } })?.transaction_outcome?.id ?? null, value: decodeValue(out) };
}

/** Short sentence for the errors a guest run can meet. */
export function guestError(e: unknown): string {
  const m = e instanceof Error ? e.message : String(e);
  if (e instanceof FaucetError) return m;
  if (/NotEnoughBalance|LackBalance|not enough balance/i.test(m)) return "The guest account has run out of test NEAR. Start a new run.";
  if (/Failed to fetch|NetworkError|timed out|timeout|408|503/i.test(m)) return "The NEAR node did not answer in time. Try again.";
  if (/does not exist while viewing|UNKNOWN_ACCOUNT/i.test(m)) return "This guest account no longer exists on testnet. Start a new run.";
  return m.length > 200 ? m.slice(0, 200) + "…" : m;
}
