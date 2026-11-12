// Funder wallet and source top-ups. Every RPC call goes to an in-memory fake: nothing here touches a network.
import { createECDH, createPrivateKey, createPublicKey, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { base58Encode, bytesToBig, keccak256, rlpDecode, rlpEncode, toChecksumAddress, toHex } from '../src/chains/codec.js';
import { decodeEip1559, eip1559SigningHash, evmTxMaxCost, signEip1559 } from '../src/chains/evmTx.js';
import { SECP256K1_N, checkSeed, deriveEvmFunderKey, deriveFunderKeys, deriveSolanaFunderSeed } from '../src/chains/funderKeys.js';
import type { EvmReceipt, FundingRpc, SolStatus } from '../src/chains/funderRpc.js';
import { RENT_EXEMPT_MIN_0, parseSolTransfer, signSolTransfer, transferMessage } from '../src/chains/solanaTx.js';
import { fundSourcesCommand, funderCommand } from '../src/commands/fund.js';
import { DEFAULT_CAPS, Funder, GUEST_MAX, PAYOUT_GAS_LIMIT, capsFromEnv, formatAmount, guestRefusal, parseAmount, solanaShortfall, type FundCaps, type SourceSet } from '../src/funder.js';
import { makeDeps, tickOnce } from '../src/keeperLoop.js';
import { mockChains, mockCreate } from '../src/mock.js';
import type { ForeignPayout, VaultView } from '../src/types.js';
import { recordingLogger, seedBackend } from './helpers.js';

const SEED = 'test seed for the dmw funder, not a real secret';
const FUNDER_EVM = '0x0B5Fa3EBFe4d784708846C8112F51F43d407f1C2';
const FUNDER_SOL = '8xY5MTEAdVggCkx3XpbtJa39oENYR2NcmFGKb4f3jnHL';

// Sources used throughout (any valid addresses: the fake RPC only keeps balances).
const SRC: SourceSet = {
  base: '0x7F985ce93d5A3fa32519F3be334d61d93d275f3b',
  monad: '0xa8fdcc94b902c32E2aF0788A48A4d082adbE4b91',
  solana: 'CPRMvCbJ8uebgt4BsNhm94eNB8cfsSXsN1ffKMUMhZdc',
};
const GWEI = 1_000_000_000n;
const ETH = 10n ** 18n;
const SOL = 1_000_000_000n;

// ---------------------------------------------------------------------------------------------- fake chains

class FakeRpc implements FundingRpc {
  evm = { base: new Map<string, bigint>(), monad: new Map<string, bigint>() };
  sol = new Map<string, bigint>();
  nonces = new Map<string, number>();
  mined = new Map<string, number>();
  fee = { base: 2_000_000n, monad: 202n * GWEI };
  block = { base: 100n, monad: 100n };
  sentEvm: { chain: 'base' | 'monad'; raw: string }[] = [];
  sentSol: string[] = [];
  revert = false;
  landedSol = new Set<string>();
  calls: string[] = [];
  key = (c: string, a: string) => `${c}:${a.toLowerCase()}`;

  async evmBalance(c: 'base' | 'monad', a: string) {
    this.calls.push(`evmBalance ${c}`);
    return this.evm[c].get(a.toLowerCase()) ?? 0n;
  }
  async evmQuote(c: 'base' | 'monad', from: string) {
    return { nonce: this.nonces.get(this.key(c, from)) ?? 0, maxFeePerGas: this.fee[c], maxPriorityFeePerGas: 1_000_000n };
  }
  async evmMinedNonce(c: 'base' | 'monad', a: string) {
    return this.mined.get(this.key(c, a)) ?? 0;
  }
  async evmSend(c: 'base' | 'monad', raw: string) {
    const t = decodeEip1559(raw);
    this.sentEvm.push({ chain: c, raw });
    this.nonces.set(this.key(c, t.from), t.nonce + 1);
    if (!this.revert) {
      const from = t.from.toLowerCase();
      this.evm[c].set(from, (this.evm[c].get(from) ?? 0n) - t.value - 21_000n * t.maxFeePerGas);
      this.evm[c].set(t.to.toLowerCase(), (this.evm[c].get(t.to.toLowerCase()) ?? 0n) + t.value);
    }
    return t.hash;
  }
  async evmReceipt(c: 'base' | 'monad'): Promise<EvmReceipt> {
    return { ok: !this.revert, blockNumber: this.block[c] };
  }
  async evmBlockNumber(c: 'base' | 'monad') {
    this.calls.push(`block ${c}`);
    this.block[c] += 1n;
    return this.block[c];
  }
  async solBalance(a: string) {
    return this.sol.get(a) ?? 0n;
  }
  async solBlockhash() {
    return 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N';
  }
  async solRentMin() {
    return RENT_EXEMPT_MIN_0;
  }
  async solSend(raw: string) {
    const t = parseSolTransfer(raw);
    expect(t.valid).toBe(true);
    this.sentSol.push(raw);
    this.sol.set(t.from, (this.sol.get(t.from) ?? 0n) - t.lamports - 5000n);
    this.sol.set(t.to, (this.sol.get(t.to) ?? 0n) + t.lamports);
    return t.signature;
  }
  async solStatus(sig: string): Promise<SolStatus | null> {
    if (this.landedSol.has(sig)) return { confirmed: true, err: null };
    return this.sentSol.some((r) => parseSolTransfer(r).signature === sig) ? { confirmed: true, err: null } : null;
  }
}

const payout = (chain: ForeignPayout['chain'], amount: bigint, extra: Partial<ForeignPayout> = {}): ForeignPayout => ({
  chain,
  to: chain === 'solana' ? 'HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr' : '0xfd151ad02f573689f235f56059ce6e2f3b64dd89',
  amount: amount.toString(),
  status: 'pending',
  signed_tx: null,
  tx_hash: null,
  ...extra,
});

const vault = (foreign: ForeignPayout[], owner = 'andrew.testnet'): VaultView => ({ ...mockCreate(0, { token_id: '7', owner_id: owner, foreign: 'none' }), foreign });

const caps = (over: Partial<Record<'base' | 'monad' | 'solana', string>> = {}): FundCaps => capsFromEnv({ FUND_RUN_CAP_ETH: over.base, FUND_RUN_CAP_MON: over.monad, FUND_RUN_CAP_SOL: over.solana });

function makeFunder(rpc: FakeRpc, c: FundCaps = caps()) {
  const { log, lines } = recordingLogger();
  // a rich funder
  rpc.evm.base.set(FUNDER_EVM.toLowerCase(), ETH);
  rpc.evm.monad.set(FUNDER_EVM.toLowerCase(), 100n * ETH);
  rpc.sol.set(FUNDER_SOL, 10n * SOL);
  const funder = Funder.fromSeed(SEED, { rpc, caps: c, log, sleepFn: async () => {} });
  return { funder, lines };
}

// ---------------------------------------------------------------------------------------------- derivation

describe('funder key derivation', () => {
  it('is HKDF-SHA256(KEEPER_SEED, salt "dmw-keeper", info "evm funder key v1" / "solana funder key v1"), with a fixed vector', () => {
    const ikm = Buffer.from(SEED, 'utf8');
    const evm = deriveEvmFunderKey(SEED);
    expect(Buffer.from(evm)).toEqual(Buffer.from(hkdfSync('sha256', ikm, 'dmw-keeper', 'evm funder key v1', 32)));
    const sol = deriveSolanaFunderSeed(SEED);
    expect(Buffer.from(sol)).toEqual(Buffer.from(hkdfSync('sha256', ikm, 'dmw-keeper', 'solana funder key v1', 32)));

    const k = deriveFunderKeys(SEED);
    expect(k.evmAddress).toBe(FUNDER_EVM);
    expect(k.solanaAddress).toBe(FUNDER_SOL);
    expect(deriveFunderKeys(SEED)).toEqual(k); // deterministic
    expect(deriveFunderKeys(SEED + '!').evmAddress).not.toBe(FUNDER_EVM);

    // independent cross-check with node:crypto: secp256k1 public key -> keccak address, and the ed25519 public key
    const ecdh = createECDH('secp256k1');
    ecdh.setPrivateKey(Buffer.from(evm));
    expect(toChecksumAddress('0x' + toHex(keccak256(ecdh.getPublicKey().subarray(1)).slice(12)))).toBe(FUNDER_EVM);
    const der = Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), Buffer.from(sol)]);
    const x = createPublicKey(createPrivateKey({ key: der, format: 'der', type: 'pkcs8' })).export({ format: 'jwk' }).x!;
    expect(base58Encode(Buffer.from(x, 'base64url'))).toBe(FUNDER_SOL);
  });

  it('retries with a counter suffix when the HKDF output is not a valid secp256k1 scalar', () => {
    const infos: string[] = [];
    const fake = (_ikm: Uint8Array, _salt: string, info: string) => {
      infos.push(info);
      if (info === 'evm funder key v1') return new Uint8Array(32); // 0: invalid
      if (info === 'evm funder key v1#1') return Uint8Array.from(Buffer.from(SECP256K1_N.toString(16), 'hex')); // n: invalid
      return Uint8Array.from({ length: 32 }, (_, i) => i + 1);
    };
    const k = deriveEvmFunderKey(SEED, fake);
    expect(infos).toEqual(['evm funder key v1', 'evm funder key v1#1', 'evm funder key v1#2']);
    expect(k[0]).toBe(1);
  });

  it('refuses a missing or short KEEPER_SEED, and never prints the keys', () => {
    expect(() => checkSeed(undefined)).toThrow(/KEEPER_SEED/);
    expect(() => checkSeed('short')).toThrow(/at least 32/);
    const f = Funder.fromSeed(SEED, { rpc: new FakeRpc(), caps: caps(), log: recordingLogger().log });
    const key = toHex(deriveEvmFunderKey(SEED));
    const shown = JSON.stringify(f) + String((f as unknown as { [k: symbol]: () => string })[Symbol.for('nodejs.util.inspect.custom')]?.());
    expect(shown).toContain(FUNDER_EVM);
    expect(shown).not.toContain(key);
    expect(JSON.stringify(f)).toBe(JSON.stringify({ evmAddress: FUNDER_EVM, solanaAddress: FUNDER_SOL }));
  });
});

// ---------------------------------------------------------------------------------------------- encoding

describe('transaction encoding', () => {
  it('RLP round-trips, with the canonical encodings', () => {
    expect(toHex(rlpEncode(new Uint8Array()))).toBe('80');
    expect(toHex(rlpEncode(Uint8Array.of(0x7f)))).toBe('7f');
    expect(toHex(rlpEncode([]))).toBe('c0');
    expect(toHex(rlpEncode(new TextEncoder().encode('dog')))).toBe('83646f67');
    const long = new Uint8Array(60).fill(7);
    const item = [long, [Uint8Array.of(1), new Uint8Array()], Uint8Array.of(0x80)];
    expect(rlpDecode(rlpEncode(item))).toEqual(item);
    expect(() => rlpDecode(Uint8Array.of(0x83, 1))).toThrow(/truncated/);
  });

  it('decodes the contract-signed EIP-1559 vector and recovers its MPC source address', () => {
    // the selfcheck vector, signed by the MPC signer for the chainsig probe's base-1 path
    const t = decodeEip1559('0x02f87183014a3480830f42408405f5e10082520894000000000000000000000000000000000000dead85e8d4a5100080c001a0488833e3912f3f6a2909811f5e3b98f74392cb9aba5fa927807db6ad9411f87aa069d220b745ac974c6465917e4d7ced686ff7dcee3f8c295c8a4bd9ca6672efc1');
    expect(t).toMatchObject({ chainId: 84532, nonce: 0, to: '0x000000000000000000000000000000000000dEaD', value: 10n ** 12n, gasLimit: 21000n, maxFeePerGas: 100_000_000n });
    expect(t.from).toBe('0xcA024adC7cac111339Fe077C739F8085aE705F2F');
    expect(t.hash).toBe('0x2079a032ef5d1cf7abdf5eb25638a3d88421e8ba885b409958bb6b672a3a9ce0');
    expect(evmTxMaxCost(t)).toBe(10n ** 12n + 21000n * 100_000_000n);
  });

  it('signs a type-2 transfer that decodes back to the same to/value/chainId/nonce/fees and sender (Base and Monad)', () => {
    const key = deriveEvmFunderKey(SEED);
    for (const chainId of [84532, 10143]) {
      const fields = { chainId, nonce: 5, maxPriorityFeePerGas: 1_000_000n, maxFeePerGas: 203n * GWEI, gasLimit: 21_000n, to: SRC.monad, value: 30_200_000_000_000_000n };
      const { raw, hash } = signEip1559(fields, key);
      expect(raw.startsWith('0x02')).toBe(true);
      const d = decodeEip1559(raw);
      expect(d).toMatchObject(fields);
      expect(d.from).toBe(FUNDER_EVM);
      expect(d.hash).toBe(hash);
      expect(d.s <= SECP256K1_N / 2n).toBe(true); // low-s
      // the signature covers the chain id: the same fields on the other chain hash differently
      expect(toHex(eip1559SigningHash(fields))).not.toBe(toHex(eip1559SigningHash({ ...fields, chainId: chainId === 84532 ? 10143 : 84532 })));
      // 12 fields: chainId..accessList, yParity, r, s; empty data and access list
      const list = rlpDecode(Buffer.from(raw.slice(4), 'hex')) as Uint8Array[];
      expect(list).toHaveLength(12);
      expect((list[7] as Uint8Array).length).toBe(0);
      expect(bytesToBig(list[0] as Uint8Array)).toBe(BigInt(chainId));
    }
    // deterministic (RFC 6979): a fixed vector
    const v = signEip1559({ chainId: 84532, nonce: 0, maxPriorityFeePerGas: 1n, maxFeePerGas: 2n, gasLimit: 21_000n, to: SRC.base, value: 1n }, key);
    expect(v.hash).toBe(FIXED_TX_HASH);
  });

  it('builds the Solana transfer message byte for byte like the contract-signed vector, and signs it', () => {
    const vec = 'ATeKNaZSfowSiNlpVUam/tRbfMiakrXIxZeMPGmkzysh2Q5qn/+y8KoHEk6d8OM3+OZ0FQZ77JwwfJxoD1pR3AABAAED6kpsY+KcUgq+9VB7Ey7F+ZVHdq6+vnuSQh7qaRRG0iwCAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAzEkOkozS44c7s0P8ldozF5ymD02/RsLDbpEpnVXU5rkBAgIAAQwCAAAAQEIPAAAAAAA=';
    const p = parseSolTransfer(vec);
    expect(p).toMatchObject({ lamports: 1_000_000n, valid: true, signature: '27QTHoE8sRsRtvZRG6RMiLntqG6zh18eCU7DvBghcEbWKNVTgGZVSj4Y1jC87xFUtbydm5tuJFf5QdzJaLaARhYj' });
    expect(Buffer.from(transferMessage(p))).toEqual(Buffer.from(vec, 'base64').subarray(65));

    const seed = deriveSolanaFunderSeed(SEED);
    const t = { from: FUNDER_SOL, to: SRC.solana, lamports: 1_005_000n, recentBlockhash: p.recentBlockhash };
    const s = signSolTransfer(t, seed);
    expect(parseSolTransfer(s.raw)).toEqual({ ...t, signature: s.signature, valid: true });
    expect(() => signSolTransfer({ ...t, from: SRC.solana }, seed)).toThrow(/does not match/);
  });
});

// ---------------------------------------------------------------------------------------------- math and caps

describe('amounts, caps and shortfall math', () => {
  it('parses and prints exact decimals', () => {
    expect(parseAmount('0.002', 18)).toBe(2_000_000_000_000_000n);
    expect(parseAmount('1', 9)).toBe(SOL);
    expect(() => parseAmount('0.0000000001', 9)).toThrow(/decimals/);
    expect(() => parseAmount('-1', 9)).toThrow();
    expect(formatAmount(500_231_000_000_000n, 'base')).toBe('0.000500231 ETH');
    expect(formatAmount(SOL, 'solana')).toBe('1 SOL');
  });

  it('reads the caps from FUND_CAP_* / FUND_RUN_CAP_*, with the documented defaults', () => {
    const d = capsFromEnv({});
    expect(d.perTopUp).toEqual({ base: parseAmount(DEFAULT_CAPS.perTopUp.base, 18), monad: 5n * 10n ** 16n, solana: 20_000_000n });
    expect(d.perRun).toEqual({ base: 10n ** 16n, monad: 25n * 10n ** 16n, solana: 100_000_000n });
    expect(capsFromEnv({ FUND_CAP_SOL: '0.5' }).perTopUp.solana).toBe(500_000_000n);
    expect(() => capsFromEnv({ FUND_CAP_ETH: 'lots' })).toThrow(/FUND_CAP_ETH/);
  });

  it('Solana: the source ends at 0 after a single payout, or keeps at least the rent-exempt minimum', () => {
    const R = RENT_EXEMPT_MIN_0;
    expect(solanaShortfall(0n, 10_005_000n, R, 1)).toBe(10_005_000n); // empty -> exactly the payout + fee, ends at 0
    expect(solanaShortfall(10_005_000n, 10_005_000n, R, 1)).toBe(0n);
    expect(solanaShortfall(4_000_000n, 10_005_000n, R, 1)).toBe(6_005_000n);
    expect(solanaShortfall(10_005_000n + 100n, 10_005_000n, R, 1)).toBe(R - 100n); // 100 lamports left would be below rent
    expect(solanaShortfall(10_005_000n + R, 10_005_000n, R, 1)).toBe(0n);
    expect(solanaShortfall(0n, 505_000n, R, 1)).toBe(505_000n + R); // a fresh account needs the rent-exempt minimum
    expect(solanaShortfall(0n, 2_010_000n, R, 2)).toBe(2_010_000n + R); // two payouts: never pass through a sub-rent balance
  });

  it('guest vaults are funded only within the guest amounts of dashboard/src/pages/Try.tsx', () => {
    const g = 'dmw-guest-abc123.testnet';
    expect(guestRefusal(vault([payout('base', GUEST_MAX.base), payout('solana', GUEST_MAX.solana)], g))).toBeNull();
    expect(guestRefusal(vault([payout('base', GUEST_MAX.base)], g), true)).toBeNull();
    expect(guestRefusal(vault([payout('base', 1n)], 'dmw-demo-owner-1.testnet'), true)).toMatch(/guest vaults only/);
    expect(guestRefusal(vault([payout('base', 1n)], 'dmw-demo-owner-1.testnet'), false)).toBeNull();
    expect(guestRefusal(vault([payout('base', GUEST_MAX.base + 1n)], g))).toMatch(/above the guest amount 0.0001 ETH/);
    expect(guestRefusal(vault([payout('solana', 2_000_000n)], g))).toMatch(/0.001 SOL/);
    expect(guestRefusal(vault([payout('monad', 1n)], g))).toMatch(/monad payout/);
    expect(guestRefusal(vault([payout('monad', ETH)], 'andrew.testnet'))).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------- top-ups

describe('fundVault', () => {
  it('sends exactly the shortfall per source: amount + 2 x 50 000 gas x max fee on EVM, amount + 5000 on Solana', async () => {
    const rpc = new FakeRpc();
    const { funder, lines } = makeFunder(rpc);
    rpc.evm.base.set(SRC.base.toLowerCase(), 100_000_000_000_000n); // 0.0001 ETH already there
    const v = vault([payout('base', 500_000_000_000_000n), payout('monad', 10n ** 16n), payout('solana', 10_000_000n)]);
    const r = await funder.fundVault(v, SRC);
    const by = Object.fromEntries(r.map((t) => [t.chain, t]));
    const baseNeed = 500_000_000_000_000n + 2n * PAYOUT_GAS_LIMIT * rpc.fee.base;
    expect(by.base).toMatchObject({ status: 'funded', need: baseNeed, shortfall: baseNeed - 100_000_000_000_000n, indexes: [0] });
    const monadNeed = 10n ** 16n + 2n * 50_000n * 202n * GWEI; // 0.01 + 0.0202 MON
    expect(by.monad).toMatchObject({ status: 'funded', need: monadNeed, shortfall: monadNeed });
    expect(by.solana).toMatchObject({ status: 'funded', need: 10_005_000n, shortfall: 10_005_000n });
    // the chain sees exactly that, from the funder, with the right chain id and nonce
    const base = decodeEip1559(rpc.sentEvm.find((s) => s.chain === 'base')!.raw);
    expect(base).toMatchObject({ chainId: 84532, nonce: 0, to: SRC.base, value: baseNeed - 100_000_000_000_000n, gasLimit: 21_000n, from: FUNDER_EVM });
    const monad = decodeEip1559(rpc.sentEvm.find((s) => s.chain === 'monad')!.raw);
    expect(monad).toMatchObject({ chainId: 10143, nonce: 0, to: SRC.monad, value: monadNeed });
    expect(rpc.evm.base.get(SRC.base.toLowerCase())).toBe(baseNeed);
    expect(rpc.sol.get(SRC.solana)).toBe(10_005_000n);
    expect(by.base.link).toMatch(/^https:\/\/sepolia\.basescan\.org\/tx\/0x/);
    expect(by.monad.link).toMatch(/^https:\/\/testnet\.monadexplorer\.com\/tx\/0x/);
    expect(by.solana.link).toMatch(/^https:\/\/explorer\.solana\.com\/tx\/.+\?cluster=devnet$/);
    expect(funder.spent).toEqual({ base: baseNeed - 100_000_000_000_000n, monad: monadNeed, solana: 10_005_000n });
    expect(lines.join('\n')).toContain('topped up by');
    // Monad: waited k = 3 blocks after inclusion (reserve rule) before returning
    expect(rpc.block.monad).toBeGreaterThanOrEqual(103n);

    // a second run finds every source holding enough and sends nothing
    const again = await funder.fundVault(v, SRC);
    expect(again.map((t) => t.status)).toEqual(['enough', 'enough', 'enough']);
    expect(rpc.sentEvm).toHaveLength(2);
    expect(rpc.sentSol).toHaveLength(1);
  });

  it('uses the exact cost of an already signed payout (value + gasLimit x maxFee of its tx)', async () => {
    const rpc = new FakeRpc();
    const { funder } = makeFunder(rpc);
    // a payout signed "by the source": here a key we hold stands in for the MPC signer
    const srcKey = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
    const signed = signEip1559({ chainId: 84532, nonce: 0, maxPriorityFeePerGas: 1n, maxFeePerGas: 9_000_000n, gasLimit: 50_000n, to: '0xfd151ad02f573689f235f56059ce6e2f3b64dd89', value: 500_000_000_000_000n }, srcKey);
    const from = decodeEip1559(signed.raw).from;
    const r = await funder.plan(vault([payout('base', 500_000_000_000_000n, { status: 'signed', signed_tx: signed.raw })]), { ...SRC, base: from });
    expect(r[0].need).toBe(500_000_000_000_000n + 50_000n * 9_000_000n);
  });

  it('skips broadcast payouts, and signed payouts whose tx already landed', async () => {
    const rpc = new FakeRpc();
    const { funder } = makeFunder(rpc);
    const srcKey = Uint8Array.from({ length: 32 }, (_, i) => i + 7);
    const signed = signEip1559({ chainId: 84532, nonce: 0, maxPriorityFeePerGas: 1n, maxFeePerGas: 9_000_000n, gasLimit: 50_000n, to: '0xfd151ad02f573689f235f56059ce6e2f3b64dd89', value: 1000n }, srcKey);
    const from = decodeEip1559(signed.raw).from;
    rpc.mined.set(`base:${from.toLowerCase()}`, 1); // nonce 0 is mined
    const solSigned = signSolTransfer({ from: FUNDER_SOL, to: SRC.solana, lamports: 1_000_000n, recentBlockhash: 'EkSnNWid2cvwEVnVx9aBqawnmiCNiDgp3gUdkDPTKN1N' }, deriveSolanaFunderSeed(SEED));
    rpc.landedSol.add(solSigned.signature);
    const v = vault([
      payout('base', 1000n, { status: 'signed', signed_tx: signed.raw }),
      payout('solana', 1_000_000n, { status: 'broadcast', signed_tx: 'AA==', tx_hash: 'x' }),
      payout('solana', 1_000_000n, { status: 'signed', signed_tx: solSigned.raw }),
    ]);
    const r = await funder.fundVault(v, { ...SRC, base: from, solana: FUNDER_SOL });
    expect(r).toEqual([]);
    expect(rpc.sentEvm).toHaveLength(0);
    expect(rpc.sentSol).toHaveLength(0);
  });

  it('refuses a top-up above the per-top-up cap, and stops at the per-run cap across vaults', async () => {
    const rpc = new FakeRpc();
    const { funder, lines } = makeFunder(rpc, caps({ solana: '0.025' }));
    const big = await funder.fundVault(vault([payout('base', 3_000_000_000_000_000n)]), SRC); // 0.003 ETH > 0.002 cap
    expect(big[0]).toMatchObject({ status: 'skipped' });
    expect(big[0].reason).toMatch(/per-top-up cap 0.002 ETH \(FUND_CAP_ETH\)/);
    expect(rpc.sentEvm).toHaveLength(0);

    // two vaults of 0.015 SOL each: the second would pass the 0.025 SOL run cap
    const a = await funder.fundVault(vault([payout('solana', 15_000_000n)]), SRC);
    expect(a[0].status).toBe('funded');
    const b = await funder.fundVault({ ...vault([payout('solana', 15_000_000n)]), token_id: '8' }, { ...SRC, solana: 'HpEHvLpa9pMNiDCQDnVMSomCx4bmJuXX8sKqtKGg2uWr' });
    expect(b[0]).toMatchObject({ status: 'skipped' });
    expect(b[0].reason).toMatch(/per-run cap 0.025 SOL/);
    expect(rpc.sentSol).toHaveLength(1);
    expect(lines.some((l) => l.includes('not funded'))).toBe(true);
  });

  it('does not fund a guest vault above the guest amounts, and funds one within them', async () => {
    const rpc = new FakeRpc();
    const { funder } = makeFunder(rpc);
    const g = 'dmw-guest-0123456789.testnet';
    expect(await funder.fundVault(vault([payout('base', ETH / 100n)], g), SRC)).toEqual([]);
    const ok = await funder.fundVault(vault([payout('base', GUEST_MAX.base), payout('solana', GUEST_MAX.solana)], g), SRC);
    expect(ok.map((t) => t.status)).toEqual(['funded', 'funded']);
  });

  it('reports a reverted top-up and an empty funder as failed, without throwing', async () => {
    const rpc = new FakeRpc();
    const { funder } = makeFunder(rpc);
    rpc.revert = true;
    const r = await funder.fundVault(vault([payout('monad', 10n ** 16n)]), SRC);
    expect(r[0]).toMatchObject({ status: 'failed' });
    expect(r[0].reason).toMatch(/reverted/);
    rpc.revert = false;
    rpc.sol.set(FUNDER_SOL, 0n);
    const s = await funder.fundVault(vault([payout('solana', 10_000_000n)]), SRC);
    expect(s[0].status).toBe('failed');
    expect(s[0].reason).toMatch(/the funder .* holds 0 SOL/);
  });
});

// ---------------------------------------------------------------------------------------------- CLI commands

describe('funder and fund-sources commands', () => {
  it('funder prints the addresses, balances and caps (and never a key); --json too', async () => {
    const rpc = new FakeRpc();
    const { funder } = makeFunder(rpc);
    let text = '';
    await funderCommand({ funder, rpc, caps: caps(), out: { write: (s: string) => (text += s) } });
    expect(text).toContain(`Base Sepolia   ${FUNDER_EVM}  1 ETH  https://sepolia.basescan.org/address/${FUNDER_EVM}`);
    expect(text).toContain(`Monad testnet  ${FUNDER_EVM}  100 MON`);
    expect(text).toContain(`Solana devnet  ${FUNDER_SOL}  10 SOL  https://explorer.solana.com/address/${FUNDER_SOL}?cluster=devnet`);
    expect(text).toContain('caps: per top-up 0.002 ETH / 0.05 MON / 0.02 SOL; per run 0.01 ETH / 0.25 MON / 0.1 SOL');
    expect(text).not.toContain(toHex(deriveEvmFunderKey(SEED)));
    let json = '';
    const rep = await funderCommand({ funder, rpc, caps: caps(), json: true, out: { write: (s: string) => (json += s) } });
    expect(JSON.parse(json)).toEqual(JSON.parse(JSON.stringify(rep)));
    expect(rep.balances.monad.balance).toBe((100n * ETH).toString());
  });

  it('fund-sources: dry run sends nothing; a real run funds and reports links; ok is false when a source is left short', async () => {
    const rpc = new FakeRpc();
    const { funder } = makeFunder(rpc);
    const v = vault([payout('base', 500_000_000_000_000n), payout('solana', 10_000_000n)]);
    const backend = { getVault: async () => v };
    const chains = { deriveAddresses: async () => SRC };
    let out = '';
    const dry = await fundSourcesCommand({ backend, chains, contract: 'c.testnet', tokenId: '7', funder, dryRun: true, out: { write: (s: string) => (out += s) } });
    expect(dry.ok).toBe(true);
    expect(dry.sources.map((s) => s.status)).toEqual(['would_fund', 'would_fund']);
    expect(out).toMatch(/vault 7 solana CPRMvCbJ8uebgt4BsNhm94eNB8cfsSXsN1ffKMUMhZdc {2}holds 0 SOL, needs 0.010005 SOL: would send 0.010005 SOL \(dry run\)/);
    expect(rpc.sentEvm.length + rpc.sentSol.length).toBe(0);

    out = '';
    const real = await fundSourcesCommand({ backend, chains, contract: 'c.testnet', tokenId: '7', funder, out: { write: (s: string) => (out += s) } });
    expect(real.ok).toBe(true);
    expect(real.sources.every((s) => s.status === 'funded' && s.link)).toBe(true);
    expect(out).toMatch(/vault 7 base {3}0x7F985ce93d5A3fa32519F3be334d61d93d275f3b {2}holds 0 ETH, needs 0.0005002 ETH: funded \+0.0005002 ETH {2}https:\/\/sepolia\.basescan\.org\/tx\/0x[0-9a-f]{64}/);

    const capped = await fundSourcesCommand({ backend: { getVault: async () => vault([payout('monad', ETH)]) }, chains, contract: 'c.testnet', tokenId: '7', funder, json: true, out: { write() {} } });
    expect(capped.ok).toBe(false);
    expect(capped.sources[0].status).toBe('skipped');
  });
});

// ---------------------------------------------------------------------------------------------- keeper loop

describe('keeper loop --fund-sources', () => {
  const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);

  it('tops the sources up before the step-III signature', async () => {
    const clock = { t: T0 };
    const s = seedBackend(clock, [{ token_id: '1', foreign: 'solana', patch: (v) => Object.assign(v, { state: 'Triggered', step: 3, foreign_index: 0 }) }]);
    const order: string[] = [];
    const funder = { fundVault: async (v: VaultView) => (order.push(`fund ${v.token_id} step ${v.step} idx ${v.foreign_index}`), []) };
    const exec = s.backend.executeStep.bind(s.backend);
    s.backend.executeStep = async (id, args) => (order.push(`execute_step ${id}`), exec(id, args));
    const deps = makeDeps({ backend: s.backend, chains: mockChains(), contractId: 'dmw-mock.testnet', now: () => clock.t, log: recordingLogger().log, funder });
    await tickOnce(deps);
    expect(order.slice(0, 2)).toEqual(['fund 1 step 3 idx 0', 'execute_step 1']);
  });

  it('on an unfunded relay: tops up once and relays again at once; a second unfunded result parks as before', async () => {
    const clock = { t: T0 };
    const s = seedBackend(clock, [
      { token_id: '1', foreign: 'base', patch: (v) => Object.assign(v, { state: 'Triggered', step: 4, foreign_index: 1, foreign: v.foreign.map((p) => ({ ...p, status: 'signed', signed_tx: '0xmocksigned0' })) }) },
    ]);
    const chains = mockChains();
    let funded = false;
    let fundCalls = 0;
    chains.broadcastEvm = async () => {
      if (!funded) throw new Error('insufficient funds for gas * price + value');
      return 'mock0xevmfunded';
    };
    const funder = {
      fundVault: async (v: VaultView) => {
        fundCalls++;
        funded = true;
        return [{ chain: 'base' as const, source: 'x', indexes: [0], balance: 0n, need: 1n, shortfall: 1n, status: 'funded' as const }];
      },
    };
    const { log, lines } = recordingLogger();
    const deps = makeDeps({ backend: s.backend, chains, contractId: 'dmw-mock.testnet', now: () => clock.t, log, funder });
    const r = await tickOnce(deps);
    expect(fundCalls).toBe(1);
    expect(r.actions.map((a) => `${a.kind}:${a.ok}:${a.detail ?? ''}`)).toContain('broadcast:true:base');
    expect(s.stored('1').foreign[0].status).toBe('broadcast');
    expect(lines.some((l) => l.includes('topping it up'))).toBe(true);

    // a source that stays unfunded after the top-up: parked for 60 s, no second top-up for the same tx
    const s2 = seedBackend(clock, [
      { token_id: '2', foreign: 'base', patch: (v) => Object.assign(v, { state: 'Triggered', step: 4, foreign_index: 1, foreign: v.foreign.map((p) => ({ ...p, status: 'signed', signed_tx: '0xmocksigned0' })) }) },
    ]);
    const c2 = mockChains();
    c2.broadcastEvm = async () => {
      throw new Error('insufficient funds for gas * price + value');
    };
    let calls2 = 0;
    const deps2 = makeDeps({ backend: s2.backend, chains: c2, contractId: 'dmw-mock.testnet', now: () => clock.t, log: recordingLogger().log, funder: { fundVault: async () => (calls2++, []) } });
    await tickOnce(deps2);
    await tickOnce(deps2);
    expect(calls2).toBe(1);
    expect(deps2.relayBlock.get('2:0')?.reason).toBe('unfunded');
  });
});

const FIXED_TX_HASH = '0x2437e244b270beb8955b9ba13ecd7ca7a33c21c2c4a86e101d8c29f340413c38';
