import { useEffect, useRef, useState } from "react";

/**
 * Press and hold for `ms` to fire `onDone`. Releasing early cancels. Works with touch, mouse and keyboard
 * (hold Space or Enter). The ring fills as you hold; nothing happens on a tap, so a pocket touch cannot stop the pulse.
 */
export default function HoldToStop({ ms = 2000, onDone, label = "Hold to stop", disabled }: { ms?: number; onDone: () => void; label?: string; disabled?: boolean }) {
  const [p, setP] = useState(0);
  const start = useRef<number | null>(null);
  const raf = useRef<number | null>(null);
  const done = useRef(onDone);
  done.current = onDone;

  const stop = () => {
    start.current = null;
    if (raf.current) cancelAnimationFrame(raf.current);
    raf.current = null;
    setP(0);
  };
  const frame = () => {
    if (start.current === null) return;
    const k = Math.min(1, (performance.now() - start.current) / ms);
    setP(k);
    if (k >= 1) {
      stop();
      navigator.vibrate?.(60);
      done.current();
      return;
    }
    raf.current = requestAnimationFrame(frame);
  };
  const begin = () => {
    if (disabled || start.current !== null) return;
    start.current = performance.now();
    navigator.vibrate?.(12);
    raf.current = requestAnimationFrame(frame);
  };
  useEffect(() => stop, []);

  const R = 46;
  const C = 2 * Math.PI * R;
  const secs = Math.max(0, (ms * (1 - p)) / 1000);
  return (
    <button
      type="button"
      className="hold"
      disabled={disabled}
      aria-label={`${label}: press and hold for ${ms / 1000} seconds`}
      onPointerDown={(e) => {
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        begin();
      }}
      onPointerUp={stop}
      onPointerCancel={stop}
      onLostPointerCapture={stop}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter") && !e.repeat) {
          e.preventDefault();
          begin();
        }
      }}
      onKeyUp={(e) => {
        if (e.key === " " || e.key === "Enter") stop();
      }}
      onContextMenu={(e) => e.preventDefault()}
    >
      <svg viewBox="0 0 100 100" aria-hidden className="hold-ring">
        <circle cx="50" cy="50" r={R} fill="none" stroke="var(--text-2)" strokeOpacity={0.45} strokeWidth="1" />
        <circle cx="50" cy="50" r={R} fill="none" stroke="var(--dead)" strokeWidth="2" strokeDasharray={C} strokeDashoffset={C * (1 - p)} transform="rotate(-90 50 50)" strokeLinecap="round" />
      </svg>
      <span className="hold-label">
        <span className="block text-[17px] font-medium">{p > 0 ? `${secs.toFixed(1)} s` : label}</span>
        <span className="mt-0.5 block text-[12.5px] text-text-2">{p > 0 ? "keep holding" : "2 seconds"}</span>
      </span>
    </button>
  );
}
