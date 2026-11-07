import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { POLL_TIMEOUT_MS, withTimeout } from "./usePoll";
import { fmtNear, humanizeYocto } from "./format";

describe("withTimeout", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("rejects and aborts the signal when the request hangs", async () => {
    let signal!: AbortSignal;
    const p = withTimeout((s) => {
      signal = s;
      return new Promise<never>(() => {}); // never settles
    });
    const assertion = expect(p).rejects.toThrow(/timed out after 8 s/);
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS);
    await assertion;
    expect(signal.aborted).toBe(true);
  });

  it("resolves normally and clears its timer", async () => {
    await expect(withTimeout(async () => 42)).resolves.toBe(42);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a later call succeeds after a timeout (polling can continue)", async () => {
    const hung = withTimeout(() => new Promise<never>(() => {}));
    const a = expect(hung).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(POLL_TIMEOUT_MS);
    await a;
    await expect(withTimeout(async () => "ok")).resolves.toBe("ok");
  });
});

describe("yocto formatting", () => {
  it("fmtNear gives 2 to 4 decimals", () => {
    expect(fmtNear("50000000000000000000000")).toBe("0.05");
    expect(fmtNear("1000000000000000000000000")).toBe("1.00");
    expect(fmtNear("1234567000000000000000000")).toBe("1.2345");
    expect(fmtNear("0")).toBe("0.00");
  });
  it("humanizeYocto rewrites the triggered detail", () => {
    expect(humanizeYocto("by keeper.testnet, bounty 50000000000000000000000")).toBe("by keeper.testnet, bounty 0.05 NEAR");
    expect(humanizeYocto("nft -> sarah.testnet")).toBe("nft -> sarah.testnet");
  });
});
