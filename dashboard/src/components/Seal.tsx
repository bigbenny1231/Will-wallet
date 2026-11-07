import type { VaultState } from "../types";
import { SEAL_TRACE, STATE_COLOR } from "../lib/pulse";
import { sealDataUri } from "../lib/seal";

/**
 * The Will seal at `size` px. The image is the contract's on-chain `media` SVG (truth); the overlay adds what
 * an image cannot: a breathing glow, a sweep along the trace, and a flash on every real heartbeat
 * (keyed on `lastBeatMs`, so it fires when the chain reports a new beat).
 */
export default function Seal({
  media,
  id,
  state,
  heirs,
  lastBeatMs,
  size = 360,
}: {
  media?: string | null;
  id: string;
  state: VaultState;
  heirs: number;
  lastBeatMs: number;
  size?: number;
}) {
  const src = media || sealDataUri(id, state, "", heirs);
  const color = STATE_COLOR[state];
  const live = state === "Alive" || state === "Warning";
  const d = SEAL_TRACE[state];
  return (
    <figure className="relative mx-auto select-none" style={{ width: size, maxWidth: "100%", aspectRatio: "1 / 1" }} aria-label={`Will seal for vault ${id}, ${state}`}>
      <img src={src} alt={`Will NFT for vault ${id}: ${state}`} width={size} height={size} className="block h-full w-full rounded-full" draggable={false} />
      <svg viewBox="0 0 400 400" className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
        <defs>
          <radialGradient id={`seal-glow-${id}`}>
            <stop offset="0" stopColor={color} stopOpacity={0.28} />
            <stop offset="1" stopColor={color} stopOpacity={0} />
          </radialGradient>
        </defs>
        {live && <circle cx="200" cy="200" r="146" fill={`url(#seal-glow-${id})`} className="breathe" style={{ animationDuration: state === "Warning" ? "2.6s" : undefined }} />}
        {live && (
          <path
            d={d}
            pathLength={1000}
            fill="none"
            stroke="#fff"
            strokeOpacity={0.85}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="sweep"
            style={{ ["--len" as string]: 1000, ["--seg" as string]: 90, ["--dur" as string]: state === "Warning" ? "5.4s" : "3.2s", filter: `drop-shadow(0 0 3px ${color})` }}
          />
        )}
        {lastBeatMs > 0 && live && (
          <path key={lastBeatMs} d={d} fill="none" stroke={color} strokeWidth={3.4} strokeLinecap="round" strokeLinejoin="round" className="beat" style={{ filter: `drop-shadow(0 0 6px ${color})` }} />
        )}
      </svg>
    </figure>
  );
}
