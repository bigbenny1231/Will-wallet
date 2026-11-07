// TypeScript port of contracts/dmw/src/nft.rs `render_svg` (the Will seal). Used by mock mode and as a
// fallback while the on-chain `media` loads. The chain's SVG is the source of truth.
import type { VaultState } from "../types";
import { SEAL_TRACE } from "./pulse";

export const HEX: Record<VaultState, string> = { Alive: "#3DDC84", Warning: "#F5B942", Triggered: "#FF4D4D", Settled: "#7A7F87" };
const GLOW: Record<VaultState, string> = { Alive: "0.22", Warning: "0.22", Triggered: "0.14", Settled: "0" };

export function fmtSecs(s: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${p(s % 60)}s`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ${p(Math.floor((s % 3600) / 60))}m`;
  return `${Math.floor(s / 86400)}d ${p(Math.floor((s % 86400) / 3600))}h`;
}

export interface SealDrawing {
  id: string;
  /** Word in the rim inscription. */
  rim: string;
  color: string;
  glow: string;
  trace: string;
  word: string;
  status: string;
  heirs: number;
}

export function drawSeal(d: SealDrawing): string {
  const c = d.color;
  const rim = `DEAD MAN’S WALLET · VAULT ${d.id} · ${d.rim.toUpperCase()}`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="400" height="400" viewBox="0 0 400 400">` +
    `<defs><radialGradient id="g"><stop offset="0" stop-color="${c}" stop-opacity="${d.glow}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>` +
    `<path id="t" d="M37 200a163 163 0 0 1 326 0"/><path id="b" d="M28 200a172 172 0 0 0 344 0"/></defs>` +
    `<rect width="400" height="400" fill="#0B0C0F"/><circle cx="200" cy="200" r="150" fill="url(#g)"/>` +
    `<g fill="none" stroke="#C8A96A"><circle cx="200" cy="200" r="186" stroke-width="1.5"/><circle cx="200" cy="200" r="180" stroke-width=".75"/></g>` +
    `<circle cx="200" cy="200" r="148" fill="none" stroke="#8C7446" stroke-width=".75"/>` +
    `<g font-family="Inter Tight,Helvetica,Arial,sans-serif" font-size="12.5" letter-spacing="3.2" text-anchor="middle" fill="#C8A96A"><text><textPath xlink:href="#t" startOffset="50%">${rim}</textPath></text>` +
    `<text><textPath xlink:href="#b" startOffset="50%">${d.heirs} HEIR${d.heirs === 1 ? "" : "S"} · NEAR</textPath></text></g>` +
    `<path d="${d.trace}" fill="none" stroke="${c}" stroke-width="2.25" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<text x="200" y="266" text-anchor="middle" font-family="Instrument Serif,Georgia,serif" font-style="italic" font-size="36" fill="#EDE7DC">${d.word}</text>` +
    `<text x="200" y="292" text-anchor="middle" font-family="JetBrains Mono,Menlo,monospace" font-size="11" fill="#A9A399">${d.status}</text></svg>`
  );
}

export function sealSvg(id: string, state: VaultState, status: string, heirs: number): string {
  return drawSeal({ id, rim: state, color: HEX[state], glow: GLOW[state], trace: SEAL_TRACE[state], word: state, status, heirs });
}

export function svgDataUri(svg: string): string {
  const bytes = new TextEncoder().encode(svg);
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return `data:image/svg+xml;base64,${btoa(bin)}`;
}

export function sealDataUri(id: string, state: VaultState, status: string, heirs: number): string {
  return svgDataUri(sealSvg(id, state, status, heirs));
}
