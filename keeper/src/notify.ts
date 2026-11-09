// Owner notifications: one webhook POST when a watched vault enters Warning or Triggered.
// The webhook URL is a secret (Slack and Discord put the token in the path), so it is never logged.
import { effectiveTriggerAtMs, warningAtMs } from './machine.js';
import type { VaultView } from './types.js';

export type NoticeEvent = 'vault_warning' | 'vault_triggered';

export const DEFAULT_DASHBOARD_URL = 'https://will-wallet.vercel.app';
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

/** Notifier from DMW_NOTIFY_WEBHOOK / DMW_DASHBOARD_URL, or undefined when no usable webhook is set. */
export function notifierFromEnv(env: NodeJS.ProcessEnv, contract: string, log: NotifyLog, fetchFn?: typeof fetch): Notifier | undefined {
  const raw = (env.DMW_NOTIFY_WEBHOOK ?? '').trim();
  if (!raw) return undefined;
  let ok = false;
  try {
    const u = new URL(raw);
    ok = u.protocol === 'https:' || u.protocol === 'http:';
  } catch {
    ok = false;
  }
  if (!ok) {
    log.warn('notify', 'DMW_NOTIFY_WEBHOOK is set but is not an http(s) URL; notifications are off');
    return undefined;
  }
  log.info('notify', 'notifications are on (DMW_NOTIFY_WEBHOOK is set): one POST when a vault enters Warning or Triggered');
  return makeNotifier({ webhookUrl: raw, contract, dashboardUrl: (env.DMW_DASHBOARD_URL ?? '').trim() || undefined, log, fetchFn });
}
