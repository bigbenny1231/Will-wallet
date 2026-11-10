// Regression tests for docs/AUDIT_FINAL_OFFCHAIN.md (keeper findings).
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NearBackend } from '../src/backend.js';
import { broadcastEvm, evmTxHash, evmTxKnown, getEvmStepArgs } from '../src/chains/evm.js';
import { broadcastSolana, getSolanaStepArgs, solanaTxSignature } from '../src/chains/solana.js';
import { warnIfShared } from '../src/config.js';
import { termSafe } from '../src/util.js';

const RAW_EVM =
  '0x02f87183014a3480830f42408405f5e10082520894000000000000000000000000000000000000dead85e8d4a5100080c001a0488833e3912f3f6a2909811f5e3b98f74392cb9aba5fa927807db6ad9411f87aa069d220b745ac974c6465917e4d7ced686ff7dcee3f8c295c8a4bd9ca6672efc1';

const rpcReturning = (result: unknown) =>
  vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ jsonrpc: '2.0', id: 1, result }) }) as unknown as Response);

afterEach(() => vi.unstubAllGlobals());

describe('F-03 agent_pay is sent once, other calls keep their retry', () => {
  const fakeAccount = (err: Error) => {
    const callFunctionRaw = vi.fn(async () => {
      throw err;
    });
    return { accountId: 'c.testnet', callFunctionRaw } as unknown as ConstructorParameters<typeof NearBackend>[2] & { callFunctionRaw: typeof callFunctionRaw };
  };
  it('a timeout on agent_pay is not retried (it may have executed)', async () => {
    const acct = fakeAccount(new Error('TimeoutError: timed out'));
    const b = new NearBackend({} as never, 'c.testnet', acct);
    await expect(b.agentPay({ token_id: '1', receiver_id: 'a.testnet', amount: '1' })).rejects.toThrow(/timed out/);
    expect(acct.callFunctionRaw).toHaveBeenCalledTimes(1);
  });
});

describe('F-07 broadcast returns the locally computed tx id', () => {
  it('EVM: a node that answers with another hash does not change what the keeper marks', async () => {
    vi.stubGlobal('fetch', rpcReturning('0x' + 'ab'.repeat(32)));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await broadcastEvm(RAW_EVM, 'http://rpc.invalid')).toBe(evmTxHash(RAW_EVM));
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });
  it('Solana: returns the first signature of the raw tx', async () => {
    const raw = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 7), Buffer.alloc(10)]).toString('base64');
    vi.stubGlobal('fetch', rpcReturning('1111111111111111111111111111111111111111111111111111111111111111'));
    expect(await broadcastSolana(raw, 'http://rpc.invalid')).toBe(solanaTxSignature(raw));
  });
});

describe('K-3 an RPC reply without a result is an error, never a successful broadcast', () => {
  const reply = (status: number, body: unknown, json = true) =>
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      json: async () => {
        if (!json) throw new SyntaxError('Unexpected token < in JSON');
        return body;
      },
    }) as unknown as Response);
  const SOL_RAW = Buffer.concat([Buffer.from([1]), Buffer.alloc(64, 7), Buffer.alloc(10)]).toString('base64');

  it('EVM: a 429 whose JSON has neither result nor error is not a broadcast', async () => {
    vi.stubGlobal('fetch', reply(429, { message: 'rate limited' }));
    await expect(broadcastEvm(RAW_EVM, 'http://rpc.invalid')).rejects.toThrow(/HTTP 429/);
  });
  it('EVM: a 200 with an empty object is not a broadcast', async () => {
    vi.stubGlobal('fetch', reply(200, {}));
    await expect(broadcastEvm(RAW_EVM, 'http://rpc.invalid')).rejects.toThrow(/no result/);
  });
  it('EVM: an HTML gateway page is an error', async () => {
    vi.stubGlobal('fetch', reply(502, null, false));
    await expect(broadcastEvm(RAW_EVM, 'http://rpc.invalid')).rejects.toThrow(/HTTP 502, not a JSON-RPC answer/);
    vi.stubGlobal('fetch', reply(200, null));
    await expect(getEvmStepArgs('0x' + '1'.repeat(40), 'http://rpc.invalid')).rejects.toThrow(/not a JSON-RPC answer/);
  });
  it('EVM: a JSON-RPC error keeps its message (the keeper classifies "insufficient funds" from it), even with HTTP 4xx', async () => {
    vi.stubGlobal('fetch', reply(400, { jsonrpc: '2.0', id: 1, error: { code: -32003, message: 'insufficient funds for gas * price + value' } }));
    await expect(broadcastEvm(RAW_EVM, 'http://rpc.invalid')).rejects.toThrow(/insufficient funds/);
  });
  it('EVM: a null result is a real answer (unknown tx), not an error', async () => {
    vi.stubGlobal('fetch', reply(200, { jsonrpc: '2.0', id: 1, result: null }));
    expect(await evmTxKnown('0x' + 'ab'.repeat(32), 'http://rpc.invalid')).toBe(false);
  });
  it('Solana: a 429 without a result is not a broadcast, and not a blockhash', async () => {
    vi.stubGlobal('fetch', reply(429, { message: 'Too many requests' }));
    await expect(broadcastSolana(SOL_RAW, 'http://rpc.invalid')).rejects.toThrow(/HTTP 429/);
    await expect(getSolanaStepArgs('http://rpc.invalid')).rejects.toThrow(/HTTP 429/);
  });
  it('every RPC request carries a time limit', async () => {
    const f = rpcReturning('0x1');
    vi.stubGlobal('fetch', f);
    await evmTxKnown('0x' + 'ab'.repeat(32), 'http://rpc.invalid');
    const init = (f.mock.calls[0] as unknown as [string, RequestInit])[1];
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('F-09 termSafe', () => {
  it('strips ESC/CSI/BEL and C1 controls, keeps text', () => {
    expect(termSafe('ok \u001b[2J\u001b]0;pwned\u0007 done\u009b31m')).toBe('ok [2J]0;pwned done31m');
    expect(termSafe('a\nb\tc\r')).toBe('a b c');
  });
});

describe('F-01 .env permission warning', () => {
  it('warns for group/world-readable files only', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(warnIfShared('/x/.env', 0o100644, 'linux')).toBe(true);
    expect(warnIfShared('/x/.env', 0o100600, 'linux')).toBe(false);
    expect(warnIfShared('/x/.env', 0o100644, 'win32')).toBe(false);
    err.mockRestore();
  });
});
