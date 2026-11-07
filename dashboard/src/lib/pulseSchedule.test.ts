import { describe, expect, it } from "vitest";
import { beatPeriodS, idle, secondsUntil, settled, shouldBeat, tick, type Scheduler } from "./pulseSchedule";

describe("beat period", () => {
  it("is a third of the interval, at most 20 s", () => {
    expect(beatPeriodS(30)).toBe(10);
    expect(beatPeriodS(60)).toBe(20);
    expect(beatPeriodS(86400 * 30)).toBe(20);
    expect(beatPeriodS(20)).toBe(6.7);
  });
  it("never goes below 3 s, even for the shortest 10 s interval", () => {
    expect(beatPeriodS(10)).toBe(3.3);
    expect(beatPeriodS(10, 1)).toBe(3);
  });
  it("honours an override, capped at half the interval", () => {
    expect(beatPeriodS(60, 5)).toBe(5);
    expect(beatPeriodS(60, 45)).toBe(30);
    expect(beatPeriodS(3600, 120)).toBe(120);
    expect(beatPeriodS(60, null)).toBe(20);
    expect(beatPeriodS(60, 0)).toBe(20);
  });
});

describe("when to beat", () => {
  const base = { stopped: false, visible: true, keepAlive: false, state: "Alive" };
  it("beats while visible and alive", () => expect(shouldBeat(base)).toBe(true));
  it("stops when held to stop", () => expect(shouldBeat({ ...base, stopped: true })).toBe(false));
  it("pauses when hidden unless keep-alive", () => {
    expect(shouldBeat({ ...base, visible: false })).toBe(false);
    expect(shouldBeat({ ...base, visible: false, keepAlive: true })).toBe(true);
  });
  it("keeps beating in Warning (that is what restores the vault)", () => expect(shouldBeat({ ...base, state: "Warning" })).toBe(true));
  it("never beats a triggered or settled vault", () => {
    expect(shouldBeat({ ...base, state: "Triggered" })).toBe(false);
    expect(shouldBeat({ ...base, state: "Settled", keepAlive: true })).toBe(false);
  });
});

describe("scheduler", () => {
  it("fires at once from idle, then every period, never overlapping", () => {
    let s: Scheduler = idle();
    let r = tick(s, 0, true);
    expect(r.fire).toBe(true);
    s = r.s;
    expect(secondsUntil(s, 0)).toBe(0);
    // in flight: no second beat however long the RPC takes
    for (const t of [250, 5000, 30000]) {
      r = tick(s, t, true);
      expect(r.fire).toBe(false);
    }
    s = settled(1000, 10, true);
    expect(secondsUntil(s, 1000)).toBe(10);
    expect(tick(s, 10_999, true).fire).toBe(false);
    expect(secondsUntil(s, 10_999)).toBe(1);
    r = tick(s, 11_000, true);
    expect(r.fire).toBe(true);
  });

  it("goes idle when not allowed, and beats immediately on resume", () => {
    let s = settled(0, 10, true);
    const r = tick(s, 2000, false);
    expect(r.fire).toBe(false);
    expect(r.s.nextAt).toBeNull();
    expect(secondsUntil(r.s, 2000)).toBeNull();
    s = r.s;
    expect(tick(s, 2500, true).fire).toBe(true);
  });

  it("retries a failed beat sooner, but not in a tight loop", () => {
    const s = settled(0, 20, false);
    expect(s.nextAt).toBe(5000);
    expect(settled(0, 3.3, false).nextAt).toBe(3300);
  });

  it("counts 96 beats over 16 minutes at a 10 s period with 0.5 s RPC latency", () => {
    let s = idle();
    let beats = 0;
    let inflightUntil = -1;
    for (let t = 0; t < 16 * 60_000; t += 250) {
      if (s.inflight && t >= inflightUntil) s = settled(t, 10, true);
      const r = tick(s, t, true);
      s = r.s;
      if (r.fire) {
        beats++;
        inflightUntil = t + 500;
      }
    }
    expect(beats).toBeGreaterThanOrEqual(91);
    expect(beats).toBeLessThanOrEqual(96);
  });
});
