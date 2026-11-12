import { useEffect, useState } from "react";
import { api } from "../lib/near";
import { adminProposalNote } from "../lib/contractInfo";

/** A small line under the footer when the keeper admin has a proposal pending (contract v3). Silent otherwise. */
export default function ContractNotice() {
  const [note, setNote] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.getConfig().then((c) => live && setNote(adminProposalNote(c, Date.now())));
    return () => {
      live = false;
    };
  }, []);
  if (!note) return null;
  return <p className="w-full text-[12.5px] text-warn">{note}</p>;
}
