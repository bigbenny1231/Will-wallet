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
      <div className="mb-6 flex items-start justify-between gap-4">
        <ErrorNote>Wallet reported: {decodeURIComponent(err)}</ErrorNote>
        <button className="btn" onClick={clear}>Dismiss</button>
      </div>
    );
  }
  return (
    <div className="mb-6 flex items-center justify-between gap-4 rounded-xl border border-accent/40 bg-accent/10 px-4 py-3">
      <div>
        Transaction sent:{" "}
        {hashes!.split(",").map((h) => (
          <span key={h} className="mr-3"><ExtLink href={links.nearTx(h)}>{h.slice(0, 10)}…</ExtLink></span>
        ))}
      </div>
      <button className="btn !py-1.5" onClick={clear}>Dismiss</button>
    </div>
  );
}
