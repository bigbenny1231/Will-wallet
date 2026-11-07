import { useEffect, useMemo, useState } from "react";
import QRCode from "qrcode";
import { PUBLIC_ORIGIN } from "../config";
import { pairingAppLink, pairingWebLink } from "../lib/pairing";
import { shortKey } from "../lib/format";
import { CopyBox } from "./ui";

/**
 * The pairing slip: a QR code the phone's camera can open, and the same link as text. The code carries the
 * pulse key's private half, so it is shown once, in this tab only.
 */
export default function PhonePairing({ contract, token, secret, publicKey, onDone }: { contract: string; token: string; secret: string; publicKey: string; onDone: () => void }) {
  const origin = PUBLIC_ORIGIN || window.location.origin;
  const web = useMemo(() => pairingWebLink(origin, { contract, token, secret }), [origin, contract, token, secret]);
  const app = useMemo(() => pairingAppLink({ contract, token, secret }), [contract, token, secret]);
  const [form, setForm] = useState<"web" | "app">("web");
  const [svg, setSvg] = useState("");
  const local = /^https?:\/\/(localhost|127\.|0\.0\.0\.0)/.test(origin);

  useEffect(() => {
    let live = true;
    QRCode.toString(form === "web" ? web : app, { type: "svg", errorCorrectionLevel: "M", margin: 2, color: { dark: "#0B0C0FFF", light: "#EDE7DCFF" } })
      .then((s) => live && setSvg(s))
      .catch(() => live && setSvg(""));
    return () => {
      live = false;
    };
  }, [form, web, app]);

  return (
    <div className="grid gap-10 border-l-2 border-life pl-6 md:grid-cols-[minmax(0,300px)_1fr]">
      <figure className="w-full max-w-[300px]">
        <div className="aspect-square w-full rounded-sm bg-bone p-2 [&_svg]:h-full [&_svg]:w-full" role="img" aria-label={`QR code: ${form === "web" ? "web pairing link" : "dmw app link"} for vault ${token}`} dangerouslySetInnerHTML={{ __html: svg }} />
        <figcaption className="mt-3 flex items-baseline justify-between gap-4 text-[13px] text-text-2">
          <span>{form === "web" ? "Opens /pulse in the phone’s browser" : "dmw:// app link"}</span>
          <button className="tl !text-[13px]" onClick={() => setForm(form === "web" ? "app" : "web")}>{form === "web" ? "Show app link" : "Show web link"}</button>
        </figcaption>
      </figure>
      <div className="min-w-0 space-y-6">
        <div>
          <div className="display text-[32px]">Scan with your phone.</div>
          <p className="mt-2 max-w-[56ch] text-[15px] leading-relaxed text-text-2">
            The phone stores the key and beats while the page is open. Hold to stop on the phone and the heartbeats end. The key can only call{" "}
            <span className="mono !text-[13px]">heartbeat</span>; it cannot move funds. The code is shown once, in this tab only.
          </p>
        </div>
        {local && (
          <p className="border-l border-warn pl-3 text-[14px] text-warn">
            This dashboard runs on {origin}, which a phone cannot open. Start it with VITE_PUBLIC_ORIGIN set to an address the phone can reach, or open the vault from the public dashboard.
          </p>
        )}
        <CopyBox label="Web link, if the camera will not scan" value={web} />
        <CopyBox label="App link" value={app} />
        <p className="mono !text-[12px] text-text-2">Pulse key {shortKey(publicKey, 12)} registered</p>
        <button className="pill" onClick={onDone}>Paired, hide the code</button>
      </div>
    </div>
  );
}
