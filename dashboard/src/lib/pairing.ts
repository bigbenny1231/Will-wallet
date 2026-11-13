// Pairing a phone as a pulse key. The owner's browser makes an ed25519 key, registers it with add_pulse_key,
// and hands the private half to the phone in one of two equivalent forms:
//   dmw://pulse?c=<contract>&t=<token>&k=<secret>     (app link, for a future native app)
//   https://<origin>/pulse#c=<contract>&t=<token>&k=<secret>  (web link; the fragment never reaches a server)
// The key can only call `heartbeat` on the contract (function-call access key, SPEC 2.7).

export interface Pairing {
  /** Lastword contract account; the pulse key is an access key on this account. */
  contract: string;
  /** Vault id. */
  token: string;
  /** "ed25519:<base58 64-byte secret>" */
  secret: string;
}

const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
const TOKEN_RE = /^\d{1,20}$/;
const SECRET_RE = /^ed25519:[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export class PairingError extends Error {}

export function validatePairing(p: Partial<Pairing>): Pairing {
  const contract = (p.contract ?? "").trim();
  const token = (p.token ?? "").trim();
  const secret = (p.secret ?? "").trim();
  if (!contract || contract.length < 2 || contract.length > 64 || !ACCOUNT_RE.test(contract)) throw new PairingError("The link has no valid contract account.");
  if (!TOKEN_RE.test(token)) throw new PairingError("The link has no valid vault number.");
  if (!SECRET_RE.test(secret)) throw new PairingError("The link has no valid ed25519 pulse key.");
  return { contract, token, secret };
}

function query(p: Pairing): string {
  const q = new URLSearchParams();
  q.set("c", p.contract);
  q.set("t", p.token);
  q.set("k", p.secret);
  return q.toString();
}

/** dmw://pulse?c=…&t=…&k=… */
export function pairingAppLink(p: Pairing): string {
  return `dmw://pulse?${query(validatePairing(p))}`;
}

/** <origin>/pulse#c=…&t=…&k=… */
export function pairingWebLink(origin: string, p: Pairing): string {
  return `${origin.replace(/\/+$/, "")}/pulse#${query(validatePairing(p))}`;
}

/**
 * Reads either link form, a bare fragment ("#c=…" or "c=…"), or a pasted string with spaces around it.
 * Throws PairingError with a sentence the page can show.
 */
export function parsePairing(input: string): Pairing {
  const s = input.trim();
  if (!s) throw new PairingError("Paste the pairing link from the vault page.");
  let params: string;
  if (/^dmw:\/\//i.test(s)) {
    const rest = s.slice("dmw://".length);
    if (!/^pulse(\/)?\?/i.test(rest)) throw new PairingError("This is not a pulse pairing link.");
    params = rest.slice(rest.indexOf("?") + 1);
  } else if (/^https?:\/\//i.test(s)) {
    let u: URL;
    try {
      u = new URL(s);
    } catch {
      throw new PairingError("The link could not be read.");
    }
    if (!/\/pulse\/?$/.test(u.pathname)) throw new PairingError("This is not a pulse pairing link.");
    params = u.hash.replace(/^#/, "") || u.search.replace(/^\?/, "");
  } else {
    params = s.replace(/^#/, "");
  }
  const q = new URLSearchParams(params);
  return validatePairing({ contract: q.get("c") ?? "", token: q.get("t") ?? "", secret: q.get("k") ?? "" });
}

/** localStorage key and value shape for the paired phone. */
export const PULSE_STORE = "dmw-pulse-key";

export interface StoredPulse extends Pairing {
  pairedMs: number;
  /** Beat period override in seconds (null = automatic). */
  periodS: number | null;
  keepAlive: boolean;
}

export function loadPulse(storage: Pick<Storage, "getItem"> = localStorage): StoredPulse | null {
  try {
    const raw = storage.getItem(PULSE_STORE);
    if (!raw) return null;
    const v = JSON.parse(raw) as StoredPulse;
    validatePairing(v);
    return { ...v, periodS: v.periodS ?? null, keepAlive: !!v.keepAlive };
  } catch {
    return null;
  }
}

/**
 * What to do with a pairing that arrives on a phone (a link that was opened, or pasted text). SECURITY_REVIEW_3 D-1:
 * a link is one tap, so it must not be able to point the phone at another contract, or silently replace the key the
 * phone already holds (the owner's real vault would then go quiet and settle).
 *  - "refuse":  the link is for another contract than the one this page serves
 *  - "same":    the phone already holds exactly this pairing
 *  - "confirm": the phone holds a different pairing; ask before replacing it
 *  - "store":   nothing stored yet
 */
export type PairingDecision = { kind: "refuse"; message: string } | { kind: "same" } | { kind: "confirm"; message: string } | { kind: "store" };

export function decidePairing(incoming: Pairing, current: Pairing | null, contract: string): PairingDecision {
  if (incoming.contract !== contract) {
    return { kind: "refuse", message: `This link is for another contract (${incoming.contract}). This page only pairs with ${contract}. Nothing was changed.` };
  }
  if (!current) return { kind: "store" };
  if (current.secret === incoming.secret && current.token === incoming.token && current.contract === incoming.contract) return { kind: "same" };
  return {
    kind: "confirm",
    message: `This phone already sends the heartbeat for vault ${current.token}. Replace that key with the one in this link (vault ${incoming.token})? Vault ${current.token} will stop receiving heartbeats from this phone.`,
  };
}

export function savePulse(v: StoredPulse, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(PULSE_STORE, JSON.stringify(v));
}
