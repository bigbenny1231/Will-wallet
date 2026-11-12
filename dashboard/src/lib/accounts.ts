// Heir accounts that do not exist yet. At settlement a share sent to a named account that does not exist bounces back
// to the vault balance, and a Will NFT given to it can only be claimed once someone creates that account, so the
// dashboard warns before the owner saves heirs (v2 security review: validate_heirs follow-up). It is a warning, not a
// block: a sub-account can be created later.
import { useEffect, useState } from "react";
import { api } from "./near";
import { contractRecipients } from "./chains";
import type { ForeignPayout } from "../types";

const ACCOUNT_RE = /^[a-z0-9._-]{2,64}$/;

/** The ids among `ids` that the RPC reports as missing. Unknown answers (RPC down) raise no warning. */
export async function missingAccounts(ids: string[], exists: (id: string) => Promise<boolean | null> = (id) => api.accountExists(id)): Promise<string[]> {
  const unique = [...new Set(ids.map((s) => s.trim()).filter((s) => ACCOUNT_RE.test(s)))];
  const answers = await Promise.all(unique.map(async (id) => [id, await exists(id).catch(() => null)] as const));
  return answers.filter(([, ok]) => ok === false).map(([id]) => id);
}

/** React hook: missing accounts among `ids`, checked half a second after the list stops changing. */
export function useMissingAccounts(ids: string[]): string[] {
  const key = ids.map((s) => s.trim()).join(",");
  const [missing, setMissing] = useState<string[]>([]);
  useEffect(() => {
    let stop = false;
    const t = setTimeout(() => {
      missingAccounts(key ? key.split(",") : []).then((m) => !stop && setMissing(m));
    }, 500);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [key]);
  return missing;
}

/** React hook: EVM payout recipients that are contracts (lib/chains.ts contractRecipients), checked after a pause. */
export function useContractRecipients(payouts: Pick<ForeignPayout, "chain" | "to">[]): Pick<ForeignPayout, "chain" | "to">[] {
  const key = payouts.map((p) => `${p.chain}:${p.to.trim()}`).join(",");
  const [found, setFound] = useState<Pick<ForeignPayout, "chain" | "to">[]>([]);
  useEffect(() => {
    let stop = false;
    const list = key ? key.split(",").map((s) => ({ chain: s.split(":")[0] as ForeignPayout["chain"], to: s.slice(s.indexOf(":") + 1) })) : [];
    const t = setTimeout(() => {
      contractRecipients(list).then((m) => !stop && setFound(m)).catch(() => undefined);
    }, 500);
    return () => {
      stop = true;
      clearTimeout(t);
    };
  }, [key]);
  return found;
}

/** One sentence for the warning, or null when every heir exists. */
export function missingHeirsNote(missing: string[]): string | null {
  if (!missing.length) return null;
  const list = missing.join(", ");
  return missing.length === 1
    ? `No account named ${list} exists on this network yet. At settlement its share would bounce back to the vault, and a Will NFT given to it could not be claimed. Create the account before the vault settles, or check the spelling.`
    : `These accounts do not exist on this network yet: ${list}. At settlement their shares would bounce back to the vault, and a Will NFT given to one of them could not be claimed. Create them before the vault settles, or check the spelling.`;
}
