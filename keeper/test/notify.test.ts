// Owner notifications (DMW_NOTIFY_WEBHOOK). fetch is injected: nothing here touches the network.
import { describe, expect, it, vi } from 'vitest';
import { makeDeps, tickOnce } from '../src/keeperLoop.js';
import { mockChains, mockCreate } from '../src/mock.js';
import { buildNotice, buildNtfy, makeNotifier, makeNtfyNotifier, notifierFromEnv, redactWebhook, vaultLink, type NoticeBody } from '../src/notify.js';
import { GUEST, recordingLogger, seedBackend } from './helpers.js';

const T0 = Date.UTC(2026, 10, 9, 14, 0, 0); // 2026-11-09 14:00:00 UTC
const HOOK = 'https://hooks.slack.example/services/T000SECRET/B000SECRET/xoxSECRETtoken';

/** A fetch stand-in that records each call and answers 200. */
const fakeFetch = (respond: () => Promise<Response> = async () => new Response('ok', { status: 200 })) => {
  const calls: { url: string; init: RequestInit; body: NoticeBody }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {}, body: JSON.parse(String(init?.body)) });
    return respond();
  });
  return { fn: fn as unknown as typeof fetch, calls, spy: fn };
};

const setup = (clock: { t: number }, opts: { fetchFn: typeof fetch; ownerPrefix?: string; seeds?: Parameters<typeof seedBackend>[1] }) => {
  const s = seedBackend(clock, opts.seeds ?? [{ token_id: '1', foreign: 'none' }]);
  const { log, lines } = recordingLogger();
  const notifier = makeNotifier({ webhookUrl: HOOK, contract: 'dmw-x8cx.testnet', log, fetchFn: opts.fetchFn, timeoutMs: 50 });
  const deps = makeDeps({ backend: s.backend, chains: mockChains(), contractId: 'dmw-x8cx.testnet', now: () => clock.t, log, notifier, ownerPrefix: opts.ownerPrefix });
  return { ...s, deps, lines };
};

describe('notice body', () => {
  it('carries the same calm line as text (Slack) and content (Discord), plus the structured fields', () => {
    const v = mockCreate(T0, { token_id: '12', owner_id: 'andrew.testnet', heartbeat_interval_s: 3600, grace_missed: 2 });
    const b = buildNotice('vault_warning', v, { contract: 'dmw-x8cx.testnet' });
    expect(b.text).toBe('Vault 12 missed a heartbeat. Settlement becomes possible at 2026-11-09 17:00:00 UTC unless a heartbeat arrives first. https://lastwordvault-app.vercel.app/vault/12');
    expect(b.content).toBe(b.text);
    expect(b.text).not.toMatch(/[!\n—]/);
    expect(b).toMatchObject({ event: 'vault_warning', token_id: '12', owner_id: 'andrew.testnet', warning_at_ms: T0 + 3_600_000, trigger_at_ms: T0 + 10_800_000, contract: 'dmw-x8cx.testnet' });
    expect(Object.keys(b).sort()).toEqual(['content', 'contract', 'event', 'owner_id', 'text', 'token_id', 'trigger_at_ms', 'warning_at_ms']);

    const t = buildNotice('vault_triggered', { ...v, state: 'Triggered' }, { contract: 'dmw-x8cx.testnet' });
    expect(t.text).toBe('Vault 12 has been triggered and settlement has started. Heartbeats are no longer accepted. https://lastwordvault-app.vercel.app/vault/12');
    expect(t.content).toBe(t.text);
    expect(t.event).toBe('vault_triggered');

    // seen late, after the deadline: the same notice in the past tense
    const late = buildNotice('vault_warning', v, { contract: 'dmw-x8cx.testnet' }, T0 + 10_800_000);
    expect(late.text).toBe('Vault 12 missed a heartbeat. Settlement has been possible since 2026-11-09 17:00:00 UTC. https://lastwordvault-app.vercel.app/vault/12');
    expect(late.content).toBe(late.text);
  });

  it('uses the paused deadline from the view, DMW_DASHBOARD_URL for the link, and keeps chat markup out of the id', () => {
    const v = { ...mockCreate(T0, { token_id: '7', heartbeat_interval_s: 60, grace_missed: 1 }), trigger_at_ms: T0 + 600_000 };
    const b = buildNotice('vault_warning', v, { contract: 'c.testnet', dashboardUrl: 'http://localhost:3000/' });
    expect(b.trigger_at_ms).toBe(T0 + 600_000);
    expect(b.text).toContain('at 2026-11-09 14:10:00 UTC');
    expect(b.text).toContain(' http://localhost:3000/vault/7');
    expect(vaultLink('7')).toBe('https://lastwordvault-app.vercel.app/vault/7');
    const odd = buildNotice('vault_warning', { ...v, token_id: '<!channel> 9' }, { contract: 'c.testnet' });
    expect(odd.text.startsWith('Vault channel9 missed')).toBe(true);
    expect(odd.text).toContain('/vault/%3C!channel%3E%209');
    expect(odd.token_id).toBe('<!channel> 9'); // the structured field is the raw id
  });
});

describe('keeper loop notifications', () => {
  it('posts once per Alive to Warning transition and once when Triggered; nothing for Warning to Alive or Settled', async () => {
    const clock = { t: T0 };
    const f = fakeFetch();
    const { backend, deps, stored } = setup(clock, { fetchFn: f.fn });
    await tickOnce(deps); // Alive, first sighting
    expect(f.calls).toHaveLength(0);

    clock.t = T0 + 11_000; // one interval (10 s) missed
    await tickOnce(deps);
    await tickOnce(deps);
    clock.t = T0 + 12_000;
    await tickOnce(deps);
    expect(f.calls.map((c) => c.body.event)).toEqual(['vault_warning']); // once, however often the loop polls
    const first = f.calls[0];
    expect(first.url).toBe(HOOK);
    expect(first.init.method).toBe('POST');
    expect(first.init.headers).toEqual({ 'content-type': 'application/json' });
    expect(first.body).toEqual({
      text: 'Vault 1 missed a heartbeat. Settlement becomes possible at 2026-11-09 14:00:20 UTC unless a heartbeat arrives first. https://lastwordvault-app.vercel.app/vault/1',
      content: 'Vault 1 missed a heartbeat. Settlement becomes possible at 2026-11-09 14:00:20 UTC unless a heartbeat arrives first. https://lastwordvault-app.vercel.app/vault/1',
      event: 'vault_warning',
      token_id: '1',
      owner_id: 'mock-owner.testnet',
      warning_at_ms: T0 + 10_000,
      trigger_at_ms: T0 + 20_000,
      contract: 'dmw-x8cx.testnet',
    });

    clock.t = T0 + 13_000;
    await backend.heartbeat('1'); // the owner comes back
    await tickOnce(deps);
    expect(f.calls).toHaveLength(1); // Warning -> Alive is not reported

    clock.t = T0 + 24_000; // missed again: a new transition, a new notice
    await tickOnce(deps);
    expect(f.calls.map((c) => c.body.event)).toEqual(['vault_warning', 'vault_warning']);
    expect(f.calls[1].body.trigger_at_ms).toBe(T0 + 33_000);

    clock.t = T0 + 34_000; // past the deadline: the keeper pokes and settles in this pass
    await tickOnce(deps);
    expect(stored('1').state).toBe('Settled');
    expect(f.calls.map((c) => c.body.event)).toEqual(['vault_warning', 'vault_warning', 'vault_triggered']);
    expect(f.calls[2].body.owner_id).toBe('mock-owner.testnet'); // still the creator at the moment of the trigger
    expect(f.calls[2].body.text).toBe('Vault 1 has been triggered and settlement has started. Heartbeats are no longer accepted. https://lastwordvault-app.vercel.app/vault/1');
    await tickOnce(deps);
    expect(f.calls).toHaveLength(3);
  });

  it('a vault first seen already in Warning gets no warning notice (the transition was not observed), only the trigger', async () => {
    const clock = { t: T0 };
    const f = fakeFetch();
    const { deps } = setup(clock, { fetchFn: f.fn });
    clock.t = T0 + 15_000;
    await tickOnce(deps); // keeper starts while the vault is in Warning
    expect(f.calls).toHaveLength(0);
    clock.t = T0 + 21_000;
    await tickOnce(deps);
    expect(f.calls.map((c) => c.body.event)).toEqual(['vault_triggered']);
  });

  it('without a notifier nothing is posted, and with a filter only matching vaults are reported', async () => {
    const clock = { t: T0 };
    const f = fakeFetch();
    const { deps } = setup(clock, {
      fetchFn: f.fn,
      ownerPrefix: GUEST,
      seeds: [
        { token_id: '1', owner_id: 'dmw-andrew-8d2e.testnet', foreign: 'none' },
        { token_id: '2', owner_id: 'dmw-guest-aaa111.testnet', foreign: 'none' },
      ],
    });
    await tickOnce(deps);
    clock.t = T0 + 11_000;
    await tickOnce(deps);
    expect(f.calls.map((c) => c.body.token_id)).toEqual(['2']);
    await tickOnce({ ...deps, notifier: undefined, lastState: new Map() });
    expect(f.calls).toHaveLength(1);
  });

  it('a failing webhook is logged and the loop carries on; the URL never reaches the log', async () => {
    const outcomes: (() => Promise<Response>)[] = [
      async () => new Response('no_service', { status: 404 }),
      async () => {
        throw new TypeError(`Failed to parse URL from ${HOOK}`);
      },
    ];
    for (const respond of outcomes) {
      const clock = { t: T0 };
      const f = fakeFetch(respond);
      const { deps, stored, lines } = setup(clock, { fetchFn: f.fn });
      await tickOnce(deps);
      clock.t = T0 + 11_000;
      await tickOnce(deps);
      clock.t = T0 + 21_000;
      const r = await tickOnce(deps);
      expect(f.spy).toHaveBeenCalledTimes(2); // warning and triggered were both attempted
      expect(r.error).toBeUndefined(); // a lost notice is not a keeper error
      expect(stored('1').state).toBe('Settled');
      const warns = lines.filter((l) => l.startsWith('warn notify'));
      expect(warns).toHaveLength(2);
      expect(warns[0]).toMatch(/vault 1: vault_warning was not delivered \(.+\); the keeper carries on/);
      const all = lines.join('\n');
      for (const secret of [HOOK, 'hooks.slack.example', 'T000SECRET', 'xoxSECRETtoken', '/services/']) expect(all).not.toContain(secret);
    }
  });

  it('a webhook that never answers is cut off by the timeout and does not hold up the pass', async () => {
    const clock = { t: T0 };
    const hang = vi.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_res, rej) => init!.signal!.addEventListener('abort', () => rej(init!.signal!.reason))));
    const { deps, stored, lines } = setup(clock, { fetchFn: hang as unknown as typeof fetch });
    await tickOnce(deps);
    clock.t = T0 + 21_000;
    // The poll skipped the whole Warning window: Alive -> Warning and Warning -> Triggered are both seen in this pass.
    await tickOnce(deps); // resolves: flush() waits at most the 50 ms timeout
    expect(hang).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(hang.mock.calls[0][1]!.body)).text).toContain('Settlement has been possible since 2026-11-09 14:00:20 UTC.');
    expect(stored('1').state).toBe('Settled');
    expect(lines.filter((l) => l.startsWith('warn notify'))).toHaveLength(2);
  });
});

describe('configuration from the environment', () => {
  it('is off without DMW_NOTIFY_WEBHOOK, off for a value that is not an http(s) URL, and never logs the value', () => {
    const { log, lines } = recordingLogger();
    expect(notifierFromEnv({}, 'c.testnet', log)).toBeUndefined();
    expect(notifierFromEnv({ DMW_NOTIFY_WEBHOOK: '  ' }, 'c.testnet', log)).toBeUndefined();
    expect(lines).toEqual([]);
    expect(notifierFromEnv({ DMW_NOTIFY_WEBHOOK: 'not a url SECRETVALUE' }, 'c.testnet', log)).toBeUndefined();
    expect(notifierFromEnv({ DMW_NOTIFY_WEBHOOK: 'file:///etc/SECRETVALUE' }, 'c.testnet', log)).toBeUndefined();
    expect(notifierFromEnv({ DMW_NOTIFY_WEBHOOK: HOOK }, 'c.testnet', log)).toBeDefined();
    expect(lines).toHaveLength(3);
    expect(lines.join('\n')).not.toMatch(/SECRET|hooks\.slack/);
  });

  it('reads DMW_DASHBOARD_URL for the link and posts through the injected fetch', async () => {
    const { log } = recordingLogger();
    const f = fakeFetch();
    const n = notifierFromEnv({ DMW_NOTIFY_WEBHOOK: HOOK, DMW_DASHBOARD_URL: 'https://example.test/app/' }, 'c.testnet', log, f.fn)!;
    n.notify('vault_warning', mockCreate(T0, { token_id: '3' }));
    await n.flush();
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].url).toBe(HOOK);
    expect(f.calls[0].body.text.endsWith(' https://example.test/app/vault/3')).toBe(true);
    expect(f.calls[0].body.contract).toBe('c.testnet');
  });

  it('redacts the URL, its host and its path from error text', () => {
    expect(redactWebhook(`request to ${HOOK} failed`, HOOK)).toBe('request to [webhook] failed');
    expect(redactWebhook('POST /services/T000SECRET/B000SECRET/xoxSECRETtoken on hooks.slack.example refused', HOOK)).toBe('POST [webhook] on [webhook] refused');
    expect(redactWebhook('x'.repeat(500), HOOK).length).toBeLessThanOrEqual(201);
  });
});

describe('ntfy phone push (DMW_NOTIFY_NTFY_TOPIC)', () => {
  const TOPIC = 'dmw-andrew-Secret_Topic42';
  /** records raw ntfy requests (plain-text body, not JSON) */
  const ntfyFetch = (status = 200) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fn = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response('{}', { status });
    }) as unknown as typeof fetch;
    return { fn, calls };
  };

  it('builds a plain POST with the same line, and Title / Tags / Priority / Click headers', () => {
    const v = mockCreate(T0, { token_id: '12', heartbeat_interval_s: 3600, grace_missed: 2 });
    const w = buildNtfy('vault_warning', v, { topic: TOPIC, contract: 'c.testnet' });
    expect(w.url).toBe(`https://ntfy.sh/${TOPIC}`);
    expect(w.body).toBe(buildNotice('vault_warning', v, { contract: 'c.testnet' }).text);
    expect(w.headers).toEqual({
      'content-type': 'text/plain; charset=utf-8',
      Title: 'Vault 12 missed a heartbeat',
      Tags: 'warning,dmw',
      Priority: 'default',
      Click: 'https://lastwordvault-app.vercel.app/vault/12',
    });
    const t = buildNtfy('vault_triggered', { ...v, state: 'Triggered', token_id: '<b>9' }, { server: 'https://ntfy.example.org/', topic: TOPIC, contract: 'c.testnet', dashboardUrl: 'https://dash.test' });
    expect(t.url).toBe(`https://ntfy.example.org/${TOPIC}`);
    expect(t.headers.Title).toBe('Vault b9 triggered: settlement started');
    expect(t.headers.Tags).toBe('rotating_light,dmw');
    expect(t.headers.Priority).toBe('high');
    expect(t.headers.Click).toBe('https://dash.test/vault/%3Cb%3E9');
    for (const h of Object.values(t.headers)) expect(h).toMatch(/^[\x20-\x7e]*$/); // ASCII header values
  });

  it('is configured from the environment next to the webhook; both receive the notice from the keeper loop', async () => {
    const clock = { t: T0 };
    const f = ntfyFetch();
    const { log, lines } = recordingLogger();
    const notifier = notifierFromEnv({ DMW_NOTIFY_WEBHOOK: HOOK, DMW_NOTIFY_NTFY_TOPIC: TOPIC }, 'c.testnet', log, f.fn)!;
    expect(lines.some((l) => l.includes('ntfy push is on') && l.includes('ntfy.sh'))).toBe(true);
    expect(lines.join('\n')).not.toContain(TOPIC);
    const s = seedBackend(clock, [{ token_id: '1', foreign: 'none' }]);
    const deps = makeDeps({ backend: s.backend, chains: mockChains(), contractId: 'c.testnet', now: () => clock.t, log, notifier });
    await tickOnce(deps);
    clock.t = T0 + 11_000;
    await tickOnce(deps);
    expect(f.calls.map((c) => c.url)).toEqual([HOOK, `https://ntfy.sh/${TOPIC}`]);
    const push = f.calls[1].init;
    expect(push.method).toBe('POST');
    expect(String(push.body)).toMatch(/^Vault 1 missed a heartbeat\. .* https:\/\/lastwordvault-app\.vercel\.app\/vault\/1$/);
    expect((push.headers as Record<string, string>).Click).toBe('https://lastwordvault-app.vercel.app/vault/1');
    expect(lines.some((l) => l.includes('sent to ntfy'))).toBe(true);
  });

  it('DMW_NOTIFY_NTFY_SERVER overrides the server; bad values switch ntfy off; failures are logged without the topic', async () => {
    const { log, lines } = recordingLogger();
    const f = ntfyFetch(500);
    const n = notifierFromEnv({ DMW_NOTIFY_NTFY_TOPIC: TOPIC, DMW_NOTIFY_NTFY_SERVER: 'https://push.example.org' }, 'c.testnet', log, f.fn)!;
    n.notify('vault_triggered', { ...mockCreate(T0, { token_id: '4' }), state: 'Triggered' });
    await n.flush();
    expect(f.calls[0].url).toBe(`https://push.example.org/${TOPIC}`);
    expect(lines.some((l) => l.includes('not delivered to ntfy (HTTP 500)'))).toBe(true);
    expect(notifierFromEnv({ DMW_NOTIFY_NTFY_TOPIC: 'has spaces/and slash' }, 'c.testnet', log)).toBeUndefined();
    expect(notifierFromEnv({ DMW_NOTIFY_NTFY_TOPIC: TOPIC, DMW_NOTIFY_NTFY_SERVER: 'ftp://x' }, 'c.testnet', log)).toBeUndefined();

    const thrower = (async () => {
      throw new Error(`connect to https://ntfy.sh/${TOPIC} refused`);
    }) as unknown as typeof fetch;
    const m = makeNtfyNotifier({ topic: TOPIC, contract: 'c.testnet', log, fetchFn: thrower, timeoutMs: 50 });
    m.notify('vault_warning', mockCreate(T0, { token_id: '5' }));
    await m.flush();
    expect(lines.join('\n')).not.toContain(TOPIC);
    expect(lines.some((l) => l.includes('vault 5') && l.includes('not delivered to ntfy'))).toBe(true);
  });
});
