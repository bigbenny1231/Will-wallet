import { useSearchParams } from "react-router-dom";
import { links } from "../config";
import { ErrorNote, ExtLink } from "./ui";

/** Shows the result of a redirect-wallet (MyNearWallet) transaction from the query string. */
export default function TxBanner() {
  const [params, setParams] = useSearchParams();
  const hashes = params.get("transactionHashes");
  const err = params.get("errorMessage") || params.get("errorCode");
  if (!hashes && !err) return null;
  const clear = () => {
    const p = new URLSearchParams(params);
    ["transactionHashes", "errorCode", "errorMessage"].forEach((k) => p.delete(k));
    setParams(p, { replace: true });
  };
  if (err) {
    return (
      <div className="flex items-baseline justify-between gap-6">
        <ErrorNote>Wallet reported: {walletMessage(err)}</ErrorNote>
        <button className="tl" onClick={clear}>Dismiss</button>
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-6 border-l border-brass py-1 pl-4 text-[15px]">
      <div>
        Transaction sent:{" "}
        {hashes!.split(",").filter((h) => /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(h)).slice(0, 10).map((h) => (
          <span key={h} className="mr-3"><ExtLink href={links.nearTx(h)}>{h.slice(0, 10)}…</ExtLink></span>
        ))}
      </div>
      <button className="tl" onClick={clear}>Dismiss</button>
    </div>
  );
}

/**
 * The query string is attacker-controllable (anyone can send a crafted link), so the message is shown as plain text,
 * capped, and a malformed %-sequence cannot throw and blank the page (AUDIT_FINAL_OFFCHAIN F-11).
 */
export function walletMessage(raw: string): string {
  let s = raw;
  try {
    s = decodeURIComponent(raw);
  } catch {
    /* already decoded by URLSearchParams */
  }
  s = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").trim();
  return s.length > 160 ? s.slice(0, 160) + "…" : s;
}
