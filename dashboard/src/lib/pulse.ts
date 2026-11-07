// Geometry for the pulse motif (DESIGN.md). The seal paths are copied verbatim from
// contracts/dmw/src/nft.rs so the client overlay lands exactly on the on-chain trace.
import type { VaultState } from "../types";

export const SEAL_BEAT = "h10q4-6 8 0h6l3 5l5-48l5 58l4-15h8q7-11 14 0h9";
export const SEAL_TRACE: Record<VaultState, string> = {
  Alive: `M92 200${SEAL_BEAT}${SEAL_BEAT}${SEAL_BEAT}`,
  Warning: "M92 200h46l3 4l4-26l4 32l3-10h52q4-4 8 0h18l2 3l3-14l3 17l2-6h68",
  Triggered: "M92 200h216",
  Settled: "M92 200h216",
};

export const STATE_COLOR: Record<VaultState, string> = {
  Alive: "var(--life)",
  Warning: "var(--warn)",
  Triggered: "var(--dead)",
  Settled: "var(--still)",
};

/** One beat as relative path segments: [command, ...numbers]. Width 72, R peak 48 above baseline. */
const BEAT: [string, ...number[]][] = [
  ["h", 10], ["q", 4, -6, 8, 0], ["h", 6], ["l", 3, 5], ["l", 5, -48], ["l", 5, 58], ["l", 4, -15], ["h", 8], ["q", 7, -11, 14, 0], ["h", 9],
];
const BEAT_W = 72;

function beat(k: number, ky = k): string {
  return BEAT.map(([c, ...n]) => c + n.map((v, i) => +(v * (c === "h" ? k : i % 2 ? ky : k)).toFixed(2)).join(" ")).join("");
}

export const STRIP_W = 760;
export const STRIP_H = 104;
export const STRIP_Y = 66;

/** Regular rhythm across the strip. */
export function aliveStrip(w = STRIP_W, y = STRIP_Y, gap = 74, k = 1.15): string {
  let d = `M0 ${y}`;
  let x = 0;
  const bw = BEAT_W * k;
  while (x + gap + bw <= w) {
    d += `h${gap}${beat(k)}`;
    x += gap + bw;
  }
  return d + `h${w - x}`;
}

/** Thinning, irregular beats: the stutter. */
export function warningStrip(w = STRIP_W, y = STRIP_Y): string {
  const parts: [number, number][] = [
    [70, 1], [150, 0.7], [210, 0.4], [140, 0.22], // [gap, amplitude]
  ];
  let d = `M0 ${y}`;
  let x = 0;
  for (const [g, a] of parts) {
    d += `h${g}${beat(1, a)}`;
    x += g + BEAT_W;
  }
  return d + `h${Math.max(0, w - x)}`;
}

export const FLAT_FROM = 116;

/** History (one fading beat and a stutter) then the flatline from `flatFrom` to the end. */
export function flatStrip(w = STRIP_W, y = STRIP_Y, flatFrom = FLAT_FROM): string {
  return `M0 ${y}h14${beat(0.8, 0.7)}h16l2 3l3-12l3 14l2-5h${(flatFrom - 14 - 57.6 - 16 - 10).toFixed(1)}H${w}`;
}
/** x of settlement step n (1..5) on the flatline. */
export function tickX(n: number, w = STRIP_W, from = FLAT_FROM): number {
  const left = from + 40;
  const right = w - 64;
  return left + ((n - 1) * (right - left)) / 4;
}
