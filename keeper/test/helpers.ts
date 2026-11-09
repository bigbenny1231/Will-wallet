// Shared test helpers: a mock store seeded with several vaults, and a logger that records every line.
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Logger } from '../src/keeperLoop.js';
import { MockBackend, mockCreate, type MockOpts } from '../src/mock.js';
import type { VaultView } from '../src/types.js';

export const GUEST = 'dmw-guest-';

export interface Seed extends MockOpts {
  /** change the freshly created vault before it is stored (state, step, payouts, heirs) */
  patch?: (v: VaultView) => void;
}

/** A MockBackend over a temp file holding one vault per seed (10 s interval, grace 1 unless overridden). */
export function seedBackend(clock: { t: number }, seeds: Seed[]) {
  const file = join(mkdtempSync(join(tmpdir(), 'dmw-')), 'm.json');
  const vaults: Record<string, VaultView> = {};
  for (const { patch, ...o } of seeds) {
    const v = mockCreate(clock.t, { heartbeat_interval_s: 10, grace_missed: 1, ...o });
    patch?.(v);
    vaults[v.token_id] = v;
  }
  writeFileSync(file, JSON.stringify({ vaults, txCounter: 0 }));
  const backend = new MockBackend(file, () => clock.t);
  /** the stored vault, exactly as the mock persisted it */
  const stored = (id: string): VaultView => JSON.parse(readFileSync(file, 'utf8')).vaults[id];
  return { backend, stored, file };
}

export const quiet: Logger = { ok() {}, warn() {}, err() {}, info() {} };

export function recordingLogger() {
  const lines: string[] = [];
  const add = (level: string) => (tag: string, msg: string) => void lines.push(`${level} ${tag} ${msg}`);
  const log: Logger = { ok: add('ok'), warn: add('warn'), err: add('err'), info: add('info') };
  return { log, lines };
}
