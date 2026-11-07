// Call builders for every write method of the dmw contract (contracts/dmw/src/lib.rs).
// Each builder returns the exact method, JSON args, gas and attached deposit. calls.test.ts pins them.
import type { CallArgs, ForeignChain, ForeignPayout, Heir, Policy, StepArgs } from "../types";

export interface ForeignDraft {
  chain: ForeignChain;
  to: string;
  amount: string; // smallest unit
  from_address: string;
}

export interface CreateDraft {
  heartbeat_interval_s: number;
  grace_missed: number;
  heirs: Heir[];
  policy: Policy;
  bounty?: string; // yocto
  depositYocto: string;
  foreign: ForeignDraft[];
  dao_id: string | null;
}

const T = 1_000_000_000_000n; // 1 TGas
const tgas = (n: number) => (BigInt(n) * T).toString();

/** Gas per method (raw gas units as strings). */
export const GAS = {
  heartbeat: tgas(10),
  addKey: tgas(50),
  executeStep: tgas(300),
  create: tgas(100),
  other: tgas(30),
  /** kept for older call sites */
  set: tgas(30),
};

/** add_pulse_key / add_agent_key reserve this much of the vault balance as the key's gas allowance. */
export const KEY_ALLOWANCE_YOCTO = 10n ** 24n;
/** create_vault keeps this flat fee out of the deposit for storage. */
export const STORAGE_FEE_YOCTO = 10n ** 23n;

/** Owner mutators, `pause` and `nft_transfer` require exactly 1 yoctoNEAR (SPEC §2.3, review 2 M-6): a
 *  function-call access key cannot attach a deposit, so these always go through a wallet prompt. */
const ONE_YOCTO = "1";

export function createVaultCall(d: CreateDraft): CallArgs {
  const args: Record<string, unknown> = {
    heartbeat_interval_s: d.heartbeat_interval_s,
    grace_missed: d.grace_missed,
    heirs: d.heirs.map((h) => ({ account_id: h.account_id, bps: h.bps })),
    policy: { per_tx_max: d.policy.per_tx_max, daily_max: d.policy.daily_max, allowlist: d.policy.allowlist },
  };
  // "0" is a real value (no bounty); only an undefined bounty falls back to the contract default of 0.01 NEAR.
  if (d.bounty !== undefined) args.bounty = d.bounty;
  return { method: "create_vault", args, deposit: d.depositYocto, gas: GAS.create };
}

export const depositCall = (tokenId: string, yocto: string): CallArgs => ({
  method: "deposit",
  args: { token_id: tokenId },
  deposit: yocto,
  gas: GAS.other,
});

export const heartbeatCall = (tokenId: string): CallArgs => ({ method: "heartbeat", args: { token_id: tokenId }, gas: GAS.heartbeat });

export const addPulseKeyCall = (tokenId: string, publicKey: string): CallArgs => ({
  method: "add_pulse_key",
  args: { token_id: tokenId, public_key: publicKey },
  gas: GAS.addKey,
  deposit: ONE_YOCTO,
});

export const addAgentKeyCall = (tokenId: string, publicKey: string): CallArgs => ({
  method: "add_agent_key",
  args: { token_id: tokenId, public_key: publicKey },
  gas: GAS.addKey,
  deposit: ONE_YOCTO,
});

export const removeKeyCall = (tokenId: string, publicKey: string): CallArgs => ({
  method: "remove_key",
  args: { token_id: tokenId, public_key: publicKey },
  gas: GAS.other,
  deposit: ONE_YOCTO,
});

export const setHeirsCall = (tokenId: string, heirs: Heir[]): CallArgs => ({
  method: "set_heirs",
  args: { token_id: tokenId, heirs: heirs.map((h) => ({ account_id: h.account_id, bps: h.bps })) },
  gas: GAS.other,
  deposit: ONE_YOCTO,
});

export const setPolicyCall = (tokenId: string, policy: Policy): CallArgs => ({
  method: "set_policy",
  args: { token_id: tokenId, policy: { per_tx_max: policy.per_tx_max, daily_max: policy.daily_max, allowlist: policy.allowlist } },
  gas: GAS.other,
  deposit: ONE_YOCTO,
});

export const setForeignPayoutsCall = (tokenId: string, payouts: ForeignPayout[]): CallArgs => ({
  method: "set_foreign_payouts",
  args: { token_id: tokenId, payouts },
  gas: GAS.other,
  deposit: ONE_YOCTO,
});

/** dao_id null clears the DAO. */
export const setDaoCall = (tokenId: string, daoId: string | null): CallArgs => ({
  method: "set_dao",
  args: { token_id: tokenId, dao_id: daoId },
  gas: GAS.other,
  deposit: ONE_YOCTO,
});

export const setTimingCall = (tokenId: string, heartbeatIntervalS: number, graceMissed: number): CallArgs => ({
  method: "set_timing",
  args: { token_id: tokenId, heartbeat_interval_s: heartbeatIntervalS, grace_missed: graceMissed },
  gas: GAS.other,
  deposit: ONE_YOCTO,
});

/** Appoint a guardian who may pause the trigger once per heartbeat cycle; guardian_id null clears it. */
export const setGuardianCall = (tokenId: string, guardianId: string | null, maxPauseS?: number): CallArgs => ({
  method: "set_guardian",
  args: guardianId ? { token_id: tokenId, guardian_id: guardianId, max_pause_s: maxPauseS } : { token_id: tokenId, guardian_id: null },
  gas: GAS.other,
  deposit: ONE_YOCTO,
});

/** Guardian or owner: hold off the trigger until now + max_pause_s. */
export const pauseCall = (tokenId: string): CallArgs => ({ method: "pause", args: { token_id: tokenId }, deposit: ONE_YOCTO, gas: GAS.other });

/** Contract range for max_pause_s (lib.rs MIN_PAUSE_S..MAX_PAUSE_S). */
export const PAUSE_RANGE_S = { min: 10, max: 90 * 24 * 3600 } as const;

export const pokeCall = (tokenId: string): CallArgs => ({ method: "poke", args: { token_id: tokenId }, gas: GAS.other });

/** `args` is only needed in step 3 (chain environment fields); it is omitted otherwise. */
export const executeStepCall = (tokenId: string, args?: StepArgs): CallArgs => ({
  method: "execute_step",
  args: args && (args.evm || args.solana) ? { token_id: tokenId, args } : { token_id: tokenId },
  gas: GAS.executeStep,
});

export const markBroadcastCall = (tokenId: string, index: number, txHash: string): CallArgs => ({
  method: "mark_broadcast",
  args: { token_id: tokenId, index, tx_hash: txHash },
  gas: GAS.other,
});

export const claimCall = (tokenId: string): CallArgs => ({ method: "claim", args: { token_id: tokenId }, gas: GAS.other });

/** NEP-171 transfer of the Will NFT (= the vault). Needs exactly 1 yoctoNEAR; owner only, while Alive/Warning. */
export const nftTransferCall = (receiverId: string, tokenId: string, memo?: string): CallArgs => ({
  method: "nft_transfer",
  args: memo ? { receiver_id: receiverId, token_id: tokenId, memo } : { receiver_id: receiverId, token_id: tokenId },
  deposit: ONE_YOCTO,
  gas: GAS.other,
});

export function toPayouts(f: ForeignDraft[], fromAddresses?: (string | undefined)[]): ForeignPayout[] {
  return f.map((p, i) => ({
    chain: p.chain,
    to: p.to,
    amount: p.amount,
    from_address: fromAddresses?.[i] ?? p.from_address,
    status: "pending",
    signed_tx: null,
    tx_hash: null,
  }));
}

export function followUpCalls(tokenId: string, foreign: ForeignPayout[], daoId: string | null): CallArgs[] {
  const out: CallArgs[] = [];
  if (foreign.length) out.push(setForeignPayoutsCall(tokenId, foreign));
  if (daoId) out.push(setDaoCall(tokenId, daoId));
  return out;
}
