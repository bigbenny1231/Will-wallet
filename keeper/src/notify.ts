// Owner notifications: one webhook POST when a watched vault enters Warning or Triggered.
// The webhook URL is a secret (Slack and Discord put the token in the path), so it is never logged.
import { effectiveTriggerAtMs, warningAtMs } from './machine.js';
import type { VaultView } from './types.js';

export type NoticeEvent = 'vault_warning' | 'vault_triggered';

export const DEFAULT_DASHBOARD_URL = 'https://lastwordvault-app.vercel.app';
export const NOTIFY_TIMEOUT_MS = 5_000;

/** JSON body of one notification. `text` is what Slack shows, `content` is what Discord shows; both are the same line. */
export interface NoticeBody {
  text: string;
  content: string;
  event: NoticeEvent;
  token_id: string;
  owner_id: string;
  warning_at_ms: number;
  trigger_at_ms: number;
  contract: string;
}

/** "2026-11-09 14:05:00 UTC" */
export const utc = (ms: number): string => `${new Date(ms).toISOString().slice(0, 19).replace('T', ' ')} UTC`;

/** Link to the vault page. `base` is DMW_DASHBOARD_URL or the public dashboard. */
export function vaultLink(tokenId: string, base: string = DEFAULT_DASHBOARD_URL): string {
  return `${(base || DEFAULT_DASHBOARD_URL).replace(/\/+$/, '')}/vault/${encodeURIComponent(tokenId)}`;
}

/** `nowMs` only picks the wording: a deadline that has already passed is written in the past tense. */
export function buildNotice(event: NoticeEvent, v: VaultView, o: { contract: string; dashboardUrl?: string }, nowMs = 0): NoticeBody {
  const tokenId = String(v.token_id);
  // The id comes from the chain. Keep it to plain characters so it cannot carry chat markup or a mention.
  const shown = tokenId.replace(/[^A-Za-z0-9_.-]/g, '');
  const warningAt = warningAtMs(v);
  const triggerAt = effectiveTriggerAtMs(v);
  const link = vaultLink(tokenId, o.dashboardUrl);
  const line =
    event === 'vault_triggered'
      ? `Vault ${shown} has been triggered and settlement has started. Heartbeats are no longer accepted. ${link}`
      : nowMs >= triggerAt
        ? `Vault ${shown} missed a heartbeat. Settlement has been possible since ${utc(triggerAt)}. ${link}`
        : `Vault ${shown} missed a heartbeat. Settlement becomes possible at ${utc(triggerAt)} unless a heartbeat arrives first. ${link}`;
  return {
    text: line,
    content: line,
    event,
    token_id: tokenId,
    owner_id: v.owner_id,
    warning_at_ms: warningAt,
    trigger_at_ms: triggerAt,
    contract: o.contract,
  };
}

export interface NotifyLog {
  info(tag: string, msg: string): void;
  warn(tag: string, msg: string): void;
}

export interface Notifier {
  /** Queue one POST. Returns at once; never throws and never rejects. `nowMs` is the keeper's clock. */
  notify(event: NoticeEvent, v: VaultView, nowMs?: number): void;
  /** Resolves when every queued POST has finished or timed out. */
  flush(): Promise<void>;
}

export interface NotifierOpts {
  webhookUrl: string;
  contract: string;
  dashboardUrl?: string;
  log: NotifyLog;
  /** Injected in tests; defaults to the global fetch. */
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Remove the webhook URL, and its path, from text that is about to be logged. */
export function redactWebhook(msg: string, webhookUrl: string): string {
  const secrets = new Set<string>([webhookUrl]);
  try {
    const u = new URL(webhookUrl);
    secrets.add(u.href);
    if (u.pathname.length > 1) secrets.add(u.pathname + u.search);
    if (u.search.length > 1) secrets.add(u.search);
    secrets.add(u.host);
  } catch {
    /* not a URL: the raw string is still redacted */
  }
  let out = msg;
  for (const s of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) out = out.split(s).join('[webhook]');
  return out.length > 200 ? `${out.slice(0, 200)}…` : out;
}

export function makeNotifier(o: NotifierOpts): Notifier {
  const inflight = new Set<Promise<void>>();
  const timeoutMs = o.timeoutMs ?? NOTIFY_TIMEOUT_MS;

  const send = async (event: NoticeEvent, v: VaultView, nowMs: number): Promise<void> => {
    try {
      const body = JSON.stringify(buildNotice(event, v, o, nowMs));
      const res = await (o.fetchFn ?? fetch)(o.webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      o.log.info('notify', `vault ${v.token_id}: ${event} sent to the webhook`);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      o.log.warn('notify', `vault ${v.token_id}: ${event} was not delivered (${redactWebhook(raw, o.webhookUrl)}); the keeper carries on`);
    }
  };

  return {
    notify(event, v, nowMs = Date.now()) {
      const p = send(event, v, nowMs);
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    },
    async flush() {
      await Promise.allSettled([...inflight]);
    },
  };
}

// ------------------------------------------------------------------ ntfy (phone push, https://ntfy.sh)

export const DEFAULT_NTFY_SERVER = 'https://ntfy.sh';
/** ntfy topic names: letters, digits, "-" and "_", up to 64 characters. */
const NTFY_TOPIC = /^[A-Za-z0-9_-]{1,64}$/;

export interface NtfyRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * One ntfy publish: a plain-text POST of the same line the webhook carries, with Title, Tags, Priority and Click
 * (the vault page) headers. Header values are ASCII only (the token id is reduced to plain characters).
 */
export function buildNtfy(event: NoticeEvent, v: VaultView, o: { server?: string; topic: string; contract: string; dashboardUrl?: string }, nowMs = 0): NtfyRequest {
  const n = buildNotice(event, v, o, nowMs);
  const shown = String(v.token_id).replace(/[^A-Za-z0-9_.-]/g, '');
  const triggered = event === 'vault_triggered';
  return {
    url: `${(o.server || DEFAULT_NTFY_SERVER).replace(/\/+$/, '')}/${o.topic}`,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      Title: triggered ? `Vault ${shown} triggered: settlement started` : `Vault ${shown} missed a heartbeat`,
      Tags: triggered ? 'rotating_light,dmw' : 'warning,dmw',
      Priority: triggered ? 'high' : 'default',
      Click: vaultLink(String(v.token_id), o.dashboardUrl),
    },
    body: n.text,
  };
}

export interface NtfyNotifierOpts {
  server?: string;
  topic: string;
  contract: string;
  dashboardUrl?: string;
  log: NotifyLog;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/** Same contract as the webhook notifier: queued, never throws, failures logged with the topic redacted. */
export function makeNtfyNotifier(o: NtfyNotifierOpts): Notifier {
  const inflight = new Set<Promise<void>>();
  const timeoutMs = o.timeoutMs ?? NOTIFY_TIMEOUT_MS;
  const send = async (event: NoticeEvent, v: VaultView, nowMs: number): Promise<void> => {
    const req = buildNtfy(event, v, o, nowMs);
    try {
      const res = await (o.fetchFn ?? fetch)(req.url, { method: 'POST', headers: req.headers, body: req.body, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      o.log.info('notify', `vault ${v.token_id}: ${event} sent to ntfy`);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      // Anyone who knows the topic can read it: keep it out of the log like a webhook URL.
      const clean = redactWebhook(raw.split(o.topic).join('[topic]'), req.url);
      o.log.warn('notify', `vault ${v.token_id}: ${event} was not delivered to ntfy (${clean}); the keeper carries on`);
    }
  };
  return {
    notify(event, v, nowMs = Date.now()) {
      const p = send(event, v, nowMs);
      inflight.add(p);
      void p.finally(() => inflight.delete(p));
    },
    async flush() {
      await Promise.allSettled([...inflight]);
    },
  };
}

/** Several notifiers behind one (webhook and ntfy both set). */
export function combineNotifiers(list: Notifier[]): Notifier | undefined {
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  return {
    notify(event, v, nowMs) {
      for (const n of list) n.notify(event, v, nowMs);
    },
    async flush() {
      await Promise.allSettled(list.map((n) => n.flush()));
    },
  };
}

const isHttpUrl = (raw: string): boolean => {
  try {
    const u = new URL(raw);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    return false;
  }
};

/**
 * Notifiers from the environment, or undefined when none is usable:
 *  - DMW_NOTIFY_WEBHOOK: Slack / Discord / any JSON webhook;
 *  - DMW_NOTIFY_NTFY_TOPIC (+ optional DMW_NOTIFY_NTFY_SERVER, default https://ntfy.sh): phone push through ntfy.
 * DMW_DASHBOARD_URL sets the base of the vault link in both.
 */
export function notifierFromEnv(env: NodeJS.ProcessEnv, contract: string, log: NotifyLog, fetchFn?: typeof fetch): Notifier | undefined {
  const dashboardUrl = (env.DMW_DASHBOARD_URL ?? '').trim() || undefined;
  const list: Notifier[] = [];
  const raw = (env.DMW_NOTIFY_WEBHOOK ?? '').trim();
  if (raw) {
    if (!isHttpUrl(raw)) log.warn('notify', 'DMW_NOTIFY_WEBHOOK is set but is not an http(s) URL; webhook notifications are off');
    else {
      log.info('notify', 'notifications are on (DMW_NOTIFY_WEBHOOK is set): one POST when a vault enters Warning or Triggered');
      list.push(makeNotifier({ webhookUrl: raw, contract, dashboardUrl, log, fetchFn }));
    }
  }
  const topic = (env.DMW_NOTIFY_NTFY_TOPIC ?? '').trim();
  if (topic) {
    const server = (env.DMW_NOTIFY_NTFY_SERVER ?? '').trim() || DEFAULT_NTFY_SERVER;
    if (!NTFY_TOPIC.test(topic)) log.warn('notify', 'DMW_NOTIFY_NTFY_TOPIC is set but is not a topic name (letters, digits, "-", "_", at most 64); ntfy notifications are off');
    else if (!isHttpUrl(server)) log.warn('notify', 'DMW_NOTIFY_NTFY_SERVER is not an http(s) URL; ntfy notifications are off');
    else {
      log.info('notify', `ntfy push is on (DMW_NOTIFY_NTFY_TOPIC is set, server ${new URL(server).host}): one push when a vault enters Warning or Triggered`);
      list.push(makeNtfyNotifier({ server, topic, contract, dashboardUrl, log, fetchFn }));
    }
  }
  return combineNotifiers(list);
}
