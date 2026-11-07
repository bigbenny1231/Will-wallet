// Mock backend: a fake vault cycling Alive -> Warning -> Triggered -> Settled, 20 s per phase.
import type { CallArgs, ForeignPayout, LogEntry, NftToken, VaultState, VaultView } from "../types";
import { CONTRACT } from "../config";

export const MOCK_ACCOUNT = "demo.testnet";
const PHASE_MS = 20_000;
const CYCLE_MS = PHASE_MS * 4;
const INTERVAL_S = 20; // heartbeat_interval_s: Alive lasts one interval
const GRACE = 1; //       one missed interval of grace -> Warning lasts 20 s
const NEAR = 10n ** 24n;

let cycleStart = Date.now();
let ownerExtras: VaultView[] = [];
const extraLog: LogEntry[] = [];
let nextId = 10;
const extraPulse: string[] = [];
const extraAgent: string[] = [];

const HEIRS = [
  { account_id: "sarah.testnet", bps: 6000 },
  { account_id: "ben.testnet", bps: 4000 },
];

const STATIC_FOREIGN: Omit<ForeignPayout, "status" | "tx_hash" | "signed_tx">[] = [
  { chain: "base", to: "0x7a3f1c9d5e2b48a6f0c1d3e5b7a9c2d4e6f80123", amount: "20000000000000000", from_address: "0x3b5C0d41e2A9F6c7d8E1b2A3c4D5e6F708192a3b" },
  { chain: "solana", to: "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin", amount: "50000000", from_address: "F7Zk3xq2nWb8PpVd1sA9mYtRu6HcLe4JgNvQoXiK2BaT" },
];

function ringColor(state: VaultState) {
  return { Alive: "#2ecc71", Warning: "#f39c12", Triggered: "#e74c3c", Settled: "#7f8c8d" }[state];
}

/** SPEC 2.5: 400x400 SVG, dark background, state-coloured ring, vault id, state word, next beat / settled, heir count. */
export function willSvgDataUri(id: string, state: VaultState, nextBeatS: number | null, heirs: number): string {
  const sub = state === "Settled" ? "settled" : nextBeatS === null ? "" : `next beat in ${nextBeatS}s`;
  const c = ringColor(state);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400" viewBox="0 0 400 400">` +
    `<rect width="400" height="400" fill="#0b0f14"/>` +
    `<circle cx="200" cy="190" r="120" fill="none" stroke="#1b232d" stroke-width="14"/>` +
    `<circle cx="200" cy="190" r="120" fill="none" stroke="${c}" stroke-width="14" stroke-linecap="round"/>` +
    `<text x="200" y="120" text-anchor="middle" font-family="monospace" font-size="20" fill="#8b98a5">vault #${id}</text>` +
    `<text x="200" y="205" text-anchor="middle" font-family="sans-serif" font-size="42" font-weight="700" fill="${c}">${state}</text>` +
    `<text x="200" y="245" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#c9d1d9">${sub}</text>` +
    `<text x="200" y="360" text-anchor="middle" font-family="sans-serif" font-size="18" fill="#8b98a5">${heirs} heir${heirs === 1 ? "" : "s"}</text>` +
    `</svg>`;
  return `data:image/svg+xml;base64,${btoa(svg)}`;
}

function phaseOf(now: number): { state: VaultState; t: number } {
  const t = (now - cycleStart) % CYCLE_MS;
  const idx = Math.floor(t / PHASE_MS);
  return { state: (["Alive", "Warning", "Triggered", "Settled"] as VaultState[])[idx], t };
}

function cycleVault(now = Date.now()): VaultView {
  const { state, t } = phaseOf(now);
  const cycleBase = now - t; // start of this cycle
  const last = cycleBase;
  const warning = last + INTERVAL_S * 1000;
  const trigger = last + INTERVAL_S * 1000 * (GRACE + 1);
  const inTrig = t - 2 * PHASE_MS; // ms into Triggered phase
  let step = 0;
  if (state === "Triggered") step = 1 + Math.min(4, Math.floor(inTrig / 4000)); // 5 steps across 20 s
  if (state === "Settled") step = 6;
  const settled = state === "Settled";
  const foreign: ForeignPayout[] = STATIC_FOREIGN.map((f, i) => {
    let status: ForeignPayout["status"] = "pending";
    let tx: string | null = null;
    if (step > 3 || settled) {
      status = "broadcast";
      tx = i === 0 ? "0x" + "ab12".repeat(16) : "5Zr".padEnd(88, "k9x");
    } else if (step === 3) status = i === 0 ? "signed" : "pending";
    return { ...f, status, signed_tx: status === "pending" ? null : "0xdeadbeef", tx_hash: tx };
  });
  const log: LogEntry[] = [
    { ms: last, event: "heartbeat", detail: "owner" },
    { ms: last + 4000, event: "agent_pay_allowed", detail: `api.provider.testnet ${(NEAR / 5n).toString()}` },
    { ms: last + 9000, event: "agent_pay_denied", detail: `over_per_tx_max api.provider.testnet ${(3n * NEAR).toString()}` },
    { ms: last + 12000, event: "agent_pay_denied", detail: `receiver_not_allowlisted unknown.testnet ${(NEAR / 10n).toString()}` },
    ...extraLog.filter((e) => e.ms >= last),
  ];
  if (state === "Triggered" || settled) {
    log.push({ ms: trigger, event: "triggered", detail: "bounty paid to keeper.testnet" });
    for (let s = 1; s <= Math.min(5, step - 1 + (settled ? 1 : 0)); s++) log.push({ ms: trigger + s * 3500, event: `step_${s}`, detail: s === 1 ? "sarah.testnet 5.7 NEAR, ben.testnet 3.8 NEAR" : "ok" });
  }
  if (settled) log.push({ ms: trigger + 20000, event: "settled", detail: "nft -> sarah.testnet" });
  log.sort((a, b) => a.ms - b.ms);
  return {
    token_id: "1",
    owner_id: MOCK_ACCOUNT,
    state,
    heartbeat_interval_s: INTERVAL_S,
    grace_missed: GRACE,
    last_beat_ms: last,
    warning_at_ms: warning,
    trigger_at_ms: trigger,
    balance: (settled ? 2n * NEAR / 10n : step >= 2 ? 3n * NEAR / 10n : 10n * NEAR).toString(),
    bounty: (NEAR / 20n).toString(),
    heirs: HEIRS,
    foreign,
    pulse_keys: step >= 3 ? [] : ["ed25519:6vSEtQxrQj6txUMh33WC4ERyCWmNMRTdufDWAaDY3Un2", ...extraPulse],
    agent_keys: step >= 3 ? [] : ["ed25519:GbSpP1GVyvXVRuNcKYaDerCeW3QwMudqzkDL5T3yPxe8", ...extraAgent],
    policy: { per_tx_max: (NEAR).toString(), daily_max: (5n * NEAR).toString(), allowlist: ["api.provider.testnet"] },
    daily_spent: (NEAR / 5n).toString(),
    daily_window_start_ms: last,
    dao_id: "estate-1.sputnik-v2.testnet",
    dao_proposal_id: step >= 5 || settled ? 7 : null,
    step,
    foreign_index: step > 3 ? foreign.length : step === 3 ? 1 : 0,
    log,
  };
}

function staticVault(id: string, owner: string, state: VaultState, heirs: { account_id: string; bps: number }[]): VaultView {
  const now = Date.now();
  const settled = state === "Settled";
  return {
    ...cycleVault(now),
    token_id: id,
    owner_id: owner,
    state,
    heirs,
    last_beat_ms: now - (settled ? 86_400_000 : 30_000),
    warning_at_ms: now + 3_600_000,
    trigger_at_ms: now + 7_200_000,
    balance: (settled ? NEAR / 5n : 25n * NEAR).toString(),
    step: settled ? 6 : 0,
    foreign: settled ? cycleVault(now + CYCLE_MS).foreign : [],
    dao_id: null,
    dao_proposal_id: null,
    pulse_keys: [],
    agent_keys: [],
    log: settled
      ? [
          { ms: now - 90000, event: "triggered", detail: "" },
          { ms: now - 80000, event: "step_1", detail: heirs.map((h) => `${h.account_id} ${(25 * h.bps) / 10000} NEAR`).join(", ") },
          { ms: now - 60000, event: "settled", detail: "" },
        ]
      : [],
  };
}

function all(): VaultView[] {
  return [
    cycleVault(),
    staticVault("2", "mom.testnet", "Alive", [
      { account_id: MOCK_ACCOUNT, bps: 7000 },
      { account_id: "sarah.testnet", bps: 3000 },
    ]),
    staticVault("3", "dad.testnet", "Settled", [
      { account_id: MOCK_ACCOUNT, bps: 5000 },
      { account_id: "ben.testnet", bps: 5000 },
    ]),
    ...ownerExtras,
  ];
}

export const mockApi = {
  async getVault(id: string): Promise<VaultView | null> {
    return all().find((v) => v.token_id === id) ?? null;
  },
  async getVaultsForOwner(account: string): Promise<VaultView[]> {
    return all().filter((v) => v.owner_id === account);
  },
  async getAllVaults(): Promise<VaultView[]> {
    return all();
  },
  async nftToken(id: string): Promise<NftToken | null> {
    const v = all().find((x) => x.token_id === id);
    if (!v) return null;
    const next = v.state === "Alive" ? Math.max(0, Math.ceil((v.warning_at_ms - Date.now()) / 1000)) : v.state === "Warning" ? Math.max(0, Math.ceil((v.trigger_at_ms - Date.now()) / 1000)) : null;
    // After settlement the NFT belongs to the primary heir.
    const owner = v.state === "Settled" ? v.heirs.slice().sort((a, b) => b.bps - a.bps)[0].account_id : v.owner_id;
    return {
      token_id: id,
      owner_id: owner,
      metadata: {
        title: `Will #${id}`,
        media: willSvgDataUri(id, v.state, next, v.heirs.length),
        extra: JSON.stringify({ state: v.state, trigger_at_ms: v.trigger_at_ms, heirs: v.heirs.length }),
      },
    };
  },
  async call(account: string, c: CallArgs): Promise<void> {
    const id = String(c.args.token_id ?? "1");
    const now = Date.now();
    console.info("[mock] call", c.method, c.args);
    if (c.method === "heartbeat" && id === "1") {
      cycleStart = now;
      extraLog.push({ ms: now, event: "heartbeat", detail: "owner" });
    } else if (c.method === "poke" || c.method === "execute_step" || c.method === "deposit" || c.method === "claim" || c.method === "nft_transfer") {
      // Mock mode follows the fixed cycle; these calls are accepted but change nothing.
    } else if (c.method === "add_pulse_key") {
      extraPulse.push(String(c.args.public_key));
    } else if (c.method === "add_agent_key") {
      extraAgent.push(String(c.args.public_key));
    } else if (c.method === "create_vault") {
      const a = c.args as unknown as { heartbeat_interval_s: number; grace_missed: number; heirs: { account_id: string; bps: number }[] };
      const base = cycleVault(now);
      ownerExtras.push({
        ...base,
        token_id: String(nextId++),
        owner_id: account,
        state: "Alive",
        heartbeat_interval_s: a.heartbeat_interval_s,
        grace_missed: a.grace_missed,
        heirs: a.heirs,
        step: 0,
        foreign: [],
        log: [],
        dao_id: null,
        dao_proposal_id: null,
        pulse_keys: [],
        agent_keys: [],
        last_beat_ms: now,
        warning_at_ms: now + a.heartbeat_interval_s * 1000,
        trigger_at_ms: now + a.heartbeat_interval_s * 1000 * (a.grace_missed + 1),
      });
    }
  },
  reset() {
    cycleStart = Date.now();
    ownerExtras = [];
  },
  /** Jump the demo cycle to a given phase (used for screenshots). */
  jumpTo(state: VaultState, intoPhaseMs = 3000) {
    const idx = ["Alive", "Warning", "Triggered", "Settled"].indexOf(state);
    cycleStart = Date.now() - idx * PHASE_MS - intoPhaseMs;
  },
  contract: CONTRACT,
};

if (typeof window !== "undefined") (window as unknown as { __dmwMock: typeof mockApi }).__dmwMock = mockApi;
