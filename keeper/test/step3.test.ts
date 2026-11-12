// Step III operator window (contract v2 finding C, report item 4A): a keeper that is not an operator parks step III
// until the window opens, instead of calling execute_step (and panicking) on every poll.
import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { makeDeps, tickOnce } from '../src/keeperLoop.js';
import { mockChains, mockCreate } from '../src/mock.js';
import { isOperator, step3OpensAt, step3ProgressMs, STEP3_MARGIN_MS, STEP3_UNKNOWN_PARK_MS } from '../src/step3.js';
import type { VaultView } from '../src/types.js';
import { recordingLogger, seedBackend } from './helpers.js';

const T0 = Date.UTC(2026, 10, 12, 12, 0, 0);
const HOUR = 3_600_000;
const C = 'dmw-mock.testnet';

describe('operator rule (mirrors Contract::is_operator)', () => {
  const v = { ...mockCreate(T0, { owner_id: 'alice.testnet' }), keeper_id: 'vk.testnet' };
  const cfg = { owner_id: 'deployer.testnet', keeper: 'ck.testnet', step3_open_after_ms: HOUR };
  it('contract owner, contract keeper, vault keeper, vault owner and every heir are operators; nobody else', () => {
    for (const me of ['deployer.testnet', 'ck.testnet', 'vk.testnet', 'alice.testnet', 'sarah.testnet', 'tom.testnet']) expect(isOperator(me, v, cfg, C)).toBe(true);
    for (const me of ['stranger.testnet', 'dmw-sweep-1.testnet']) expect(isOperator(me, v, cfg, C)).toBe(false);
  });
  it('the contract account itself never is (a locked contract owns itself)', () => {
    expect(isOperator(C, v, { ...cfg, owner_id: C }, C)).toBe(false);
    expect(isOperator('x.testnet', { ...v, keeper_id: null }, { owner_id: null, keeper: null }, C)).toBe(false);
  });
});

describe('window start from the vault log', () => {
  it('is the latest step_2 / foreign_signed / foreign_failed entry', () => {
    const log = [
      { ms: 1, event: 'triggered', detail: '' },
      { ms: 10, event: 'step_2', detail: '' },
      { ms: 20, event: 'heartbeat', detail: '' },
      { ms: 30, event: 'foreign_signed', detail: '#0' },
      { ms: 25, event: 'foreign_failed', detail: '#1' },
    ];
    expect(step3ProgressMs({ log })).toBe(30);
    expect(step3OpensAt({ log }, { step3_open_after_ms: HOUR })).toBe(30 + HOUR);
    expect(step3ProgressMs({ log: [{ ms: 5, event: 'heartbeat', detail: '' }] })).toBeNull();
  });
});

/** A vault at step III, step 3 started at T0 (step_2 logged then), one Solana payout pending. */
function atStep3(clock: { t: number }, me: string | undefined) {
  const s = seedBackend(clock, [
    {
      token_id: '1',
      foreign: 'solana',
      patch: (v: VaultView) => {
        Object.assign(v, { state: 'Triggered', step: 3, foreign_index: 0 });
        v.log.push({ ms: T0, event: 'step_2', detail: 'deleted 2 keys' });
      },
    },
  ]);
  s.backend.accountId = me;
  const calls: string[] = [];
  const exec = s.backend.executeStep.bind(s.backend);
  s.backend.executeStep = async (id, args) => {
    calls.push(id);
    return exec(id, args);
  };
  const { log, lines } = recordingLogger();
  const deps = makeDeps({ backend: s.backend, chains: mockChains(), contractId: C, now: () => clock.t, log });
  return { ...s, deps, lines, calls };
}

describe('keeper loop: step III window', () => {
  it('a non-operator parks step III until step-3 start + step3_open_after_ms, logs once, then moves settlement on', async () => {
    const clock = { t: T0 + 10 * 60_000 };
    const { deps, lines, calls, stored } = atStep3(clock, 'dmw-sweep-abc.testnet');
    const r1 = await tickOnce(deps);
    expect(calls).toEqual([]);
    expect(r1.error).toBeUndefined();
    expect(r1.pending).toEqual(['1']); // still to settle: a sweep keeps it in view
    const opens = new Date(T0 + HOUR + STEP3_MARGIN_MS).toISOString().slice(0, 19) + 'Z';
    const notes = lines.filter((l) => l.includes('step III'));
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain('dmw-sweep-abc.testnet is not an operator of this vault');
    expect(notes[0]).toContain(`opens signing to anyone at ${opens}`);
    expect(notes[0]).toContain('in 51 min');

    clock.t = T0 + 30 * 60_000;
    await tickOnce(deps);
    expect(calls).toEqual([]);
    expect(lines.filter((l) => l.includes('step III'))).toHaveLength(1); // logged once

    clock.t = T0 + HOUR + STEP3_MARGIN_MS;
    await tickOnce(deps);
    expect(calls[0]).toBe('1');
    // Contract v3 (M-1): a non-operator never supplies a Solana blockhash. After the hour its step 3 records the
    // payout failed without a signature ("skipped: ..."), settlement moves on, and an operator may re-sign it.
    expect(stored('1').foreign[0]).toMatchObject({ status: 'failed', signed_tx: null });
    expect(stored('1').step).toBeGreaterThan(3);
    expect(lines.some((l) => l.includes('solana payout #0 skipped'))).toBe(true);
    expect(lines.some((l) => l.startsWith('err'))).toBe(false);
  });

  it('an operator (an heir here) signs at once', async () => {
    const clock = { t: T0 + 60_000 };
    const { deps, calls, stored } = atStep3(clock, 'sarah.testnet');
    await tickOnce(deps);
    expect(calls[0]).toBe('1');
    expect(stored('1').foreign[0].status).not.toBe('pending'); // signed (then relayed and marked in the same pass)
  });

  it('the contract keeper from get_config, and the vault keeper, are operators', async () => {
    const clock = { t: T0 + 60_000 };
    const a = atStep3(clock, 'ck.testnet');
    a.backend.config.keeper = 'ck.testnet';
    await tickOnce(a.deps);
    expect(a.calls[0]).toBe('1');
    const b = atStep3(clock, 'vk.testnet');
    b.backend.config.keeper = null;
    const v = JSON.parse(readFileSync(b.file, 'utf8'));
    v.vaults['1'].keeper_id = 'vk.testnet';
    writeFileSync(b.file, JSON.stringify(v));
    await tickOnce(b.deps);
    expect(b.calls[0]).toBe('1');
    const c = atStep3(clock, 'nobody.testnet');
    await tickOnce(c.deps);
    expect(c.calls).toEqual([]);
  });

  it('when the local check cannot tell, the contract panic parks step III (5 min) without counting as a failure', async () => {
    const clock = { t: T0 + 60_000 };
    const { deps, backend, calls, lines } = atStep3(clock, 'stranger.testnet');
    backend.getConfig = async () => {
      throw new Error('view failed');
    };
    const r = await tickOnce(deps);
    expect(calls).toEqual(['1']); // tried once: the contract refused
    expect(r.error).toBeUndefined();
    expect(deps.step3Park.get('1')).toBe(clock.t + STEP3_UNKNOWN_PARK_MS);
    expect(lines.filter((l) => l.includes('step III'))).toHaveLength(1);
    await tickOnce(deps);
    expect(calls).toEqual(['1']); // parked: no second call
  });

  it('without an account id (older backends, the default mock) nothing changes', async () => {
    const clock = { t: T0 + 60_000 };
    const { deps, calls } = atStep3(clock, undefined);
    await tickOnce(deps);
    expect(calls[0]).toBe('1');
  });
});
