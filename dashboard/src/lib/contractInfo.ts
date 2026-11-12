// Contract-level facts worth a line on the page (contract v3, SPEC 2.10): a pending keeper-admin proposal.
import type { ContractConfig } from "../types";

const WHAT = { keeper: "new contract keeper", mpc_signer: "new MPC signer", keeper_admin: "new keeper admin" } as const;

/**
 * One short line about a pending keeper-admin proposal, or null when there is none (or the contract is pre-v3).
 * `account_id` null means the role is cleared. Anyone may execute the proposal once `eta_ms` has passed.
 */
export function adminProposalNote(cfg: Pick<ContractConfig, "admin_proposal"> | null | undefined, now: number): string | null {
  const p = cfg?.admin_proposal;
  if (!p) return null;
  const what = WHAT[p.action] ?? p.action;
  const who = p.account_id ?? (p.action === "keeper_admin" ? "none (the admin role ends)" : "none (the role is cleared)");
  const when = new Date(p.eta_ms).toISOString().slice(0, 16).replace("T", " ") + " UTC";
  return now >= p.eta_ms ? `Pending admin proposal: ${what} ${who}; executable now (since ${when}).` : `Pending admin proposal: ${what} ${who}; executable from ${when}.`;
}
