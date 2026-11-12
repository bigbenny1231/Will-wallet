import { describe, expect, it } from 'vitest';
import { SimChain, simVault } from '../src/sim.js';
import { Wallet, auditKey, localPolicyCheck, DAY_MS } from '../src/wallet.js';

const N = 10n ** 24n;
const API = 'dmw-api-sim.testnet';
const mk = (over = {}, localChecks = true) => {
  const chain = new SimChain(simVault(Date.now(), over));
  return { chain, wallet: new Wallet({ chain, tokenId: '1', localChecks }) };
};

describe('wallet wrapper: layer 1 refuses to sign', () => {
  it.each([
    ['vault_not_alive', { state: 'Warning' as const }, API, '0.1'],
    ['receiver_not_allowlisted', {}, 'stranger.testnet', '0.1'],
    ['over_per_tx_max', {}, API, '0.6'],
    ['over_daily_max', { daily_spent: (N * 9n / 10n).toString() }, API, '0.2'],
    ['insufficient_balance', { balance: (N / 20n).toString() }, API, '0.1'],
  ])('refuses %s without creating a transaction', async (reason, over, receiver, amount) => {
    const { chain, wallet } = mk(over);
    const v = await wallet.pay({ receiver, amountNear: amount });
    expect(v.status).toBe('refused_locally');
    expect(v.text).toBe(`refused_locally: ${reason}`);
    expect(chain.calls).toHaveLength(0);
  });

  it('refuses malformed input locally: bad receiver, zero or junk amount, the vault contract itself', async () => {
    const { chain, wallet } = mk();
    expect((await wallet.pay({ receiver: 'Not An Account!', amountNear: '0.1' })).text).toBe('refused_locally: invalid_receiver');
    expect((await wallet.pay({ receiver: API, amountNear: '0' })).text).toBe('refused_locally: invalid_amount');
    expect((await wallet.pay({ receiver: API, amountNear: '1e3' })).text).toBe('refused_locally: invalid_amount');
    expect((await wallet.pay({ receiver: API, amountNear: '-1' })).text).toBe('refused_locally: invalid_amount');
    expect((await wallet.pay({ receiver: chain.contractId, amountNear: '0.1' })).text).toBe('refused_locally: receiver_is_vault_contract');
    expect(chain.calls).toHaveLength(0);
  });

  it('lists every failing reason, contract order first (the whole-balance drain fails four checks)', async () => {
    const { wallet } = mk();
    const v = await wallet.pay({ receiver: 'stranger.testnet', amountNear: '3' });
    expect(v.status === 'refused_locally' && v.reasons).toEqual(['receiver_not_allowlisted', 'over_per_tx_max', 'over_daily_max']);
  });

  it('treats a passed warning deadline as not alive even if the stored state still says Alive', () => {
    const now = Date.now();
    const v = simVault(now, { warning_at_ms: now - 1 });
    expect(localPolicyCheck(v, API, 1n, now)).toContain('vault_not_alive');
  });

  it('v1 view: resets the fixed daily window after 24 h like the v1 contract', () => {
    const now = Date.now();
    const v = simVault(now - DAY_MS - 1, { daily_spent: N.toString(), daily_window_start_ms: now - DAY_MS - 1, warning_at_ms: now + 1000, spends: undefined });
    expect(localPolicyCheck(v, API, N / 2n, now)).toEqual([]);
  });

  it('v2 view: the daily cap is a rolling 24 h window over spends', () => {
    const now = Date.now();
    const p6 = (N * 6n / 10n).toString();
    // 0.6 NEAR spent 25 h ago and 0.6 NEAR spent 23 h ago: only the second still counts.
    const spends = [
      { ms: now - 25 * 3_600_000, amount: p6 },
      { ms: now - 23 * 3_600_000, amount: p6 },
    ];
    // A stale view-time daily_spent must not matter: the spends are authoritative.
    const v = simVault(now, { spends, daily_spent: N.toString(), warning_at_ms: now + 10 * 3_600_000 });
    expect(localPolicyCheck(v, API, N * 4n / 10n, now)).toEqual([]);
    expect(localPolicyCheck(v, API, N * 4n / 10n + 1n, now)).toEqual(['over_daily_max']);
    // A fixed window opened 25 h ago would have reset; the rolling window still counts the 23 h old spend.
    // An hour and a bit later it has aged out too.
    expect(localPolicyCheck(v, API, N / 2n, now + 3_600_001)).toEqual([]);
  });

  it('fails closed when the vault cannot be read', async () => {
    const { chain, wallet } = mk();
    chain.getVault = async () => {
      throw new Error('rpc down');
    };
    const v = await wallet.pay({ receiver: API, amountNear: '0.1' });
    expect(v.status).toBe('refused_locally');
    expect(chain.calls).toHaveLength(0);
  });

  it('tracks daily spend across calls even if the view lags behind', async () => {
    const { chain, wallet } = mk();
    chain.getVault = async () => simVault(Date.now()); // always reports daily_spent 0
    chain.agentPay = async () => ({ hash: 'sim-x', logs: [], returnValue: { allowed: true, daily_spent: '0' } });
    expect((await wallet.pay({ receiver: API, amountNear: '0.5' })).status).toBe('allowed');
    expect((await wallet.pay({ receiver: API, amountNear: '0.5' })).status).toBe('allowed');
    const third = await wallet.pay({ receiver: API, amountNear: '0.1' });
    expect(third.text).toBe('refused_locally: over_daily_max');
  });
});

describe('wallet wrapper: layer 2 is the contract verdict', () => {
  it('signs when every pre-check passes and reports allowed with the tx link', async () => {
    const { chain, wallet } = mk();
    const v = await wallet.pay({ receiver: API, amountNear: '0.12', memo: 'INV-1' });
    expect(v.status).toBe('allowed');
    expect(v.status === 'allowed' && v.link).toContain('sim-1');
    expect(chain.calls).toEqual([{ receiver_id: API, amount: (12n * N / 100n).toString() }]);
  });

  it('with layer 1 off, the contract still denies and the wrapper reports denied: <reason>', async () => {
    const { chain, wallet } = mk({}, false);
    const v = await wallet.pay({ receiver: 'stranger.testnet', amountNear: '3' });
    expect(v.status).toBe('denied');
    expect(v.text).toBe('denied: receiver_not_allowlisted');
    expect(chain.calls).toHaveLength(1);
    expect(BigInt(chain.vault.balance)).toBe(3n * N); // nothing moved
  });

  it('reports a transport or key failure as error, never as success', async () => {
    const { chain, wallet } = mk();
    chain.agentPay = async () => {
      throw new Error('InvalidAccessKey: key deleted');
    };
    const v = await wallet.pay({ receiver: API, amountNear: '0.1' });
    expect(v.status).toBe('error');
    expect(v.text).toContain('InvalidAccessKey');
  });
});

describe('key audit and surface', () => {
  const C = 'dmw.testnet';
  it('accepts exactly a function-call key on the vault contract for agent_pay', () => {
    const a = auditKey({ kind: 'FunctionCall', receiver_id: C, method_names: ['agent_pay'], allowance: N.toString() }, C);
    expect(a.ok).toBe(true);
    expect(a.explain.join(' ')).toContain('1 NEAR of gas budget');
  });
  it('rejects a full-access key, a wrong receiver, and extra or empty method lists', () => {
    expect(auditKey({ kind: 'FullAccess' }, C).ok).toBe(false);
    expect(auditKey({ kind: 'FunctionCall', receiver_id: 'other.testnet', method_names: ['agent_pay'], allowance: null }, C).ok).toBe(false);
    expect(auditKey({ kind: 'FunctionCall', receiver_id: C, method_names: ['agent_pay', 'heartbeat'], allowance: null }, C).ok).toBe(false);
    expect(auditKey({ kind: 'FunctionCall', receiver_id: C, method_names: [], allowance: null }, C).ok).toBe(false);
  });
  it('the wallet exposes no transfer, only pay / snapshot / audit', () => {
    const methods = Object.getOwnPropertyNames(Wallet.prototype).filter((m) => m !== 'constructor');
    expect(methods.sort()).toEqual(['audit', 'pay', 'snapshot']);
  });
});
