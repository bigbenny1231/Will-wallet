// Typeset transcript: pure formatting functions plus a tiny collector that streams each block as it is added.
import { fmtNear } from './util.js';
import type { KeyAudit, Verdict } from './wallet.js';
import type { DecisionMeta, Policy, VaultView } from './types.js';

export class Transcript {
  readonly blocks: string[] = [];
  constructor(private onBlock?: (md: string) => void) {}
  add(md: string): void {
    this.blocks.push(md);
    this.onBlock?.(md);
  }
  toMarkdown(): string {
    return this.blocks.join('\n\n') + '\n';
  }
}

// Untrusted text (inbox messages, LLM thoughts/arguments/summaries, node errors) reaches this file. It is written to
// .demo/agent-transcript.md (rendered as Markdown, e.g. on GitHub or in an editor preview) and streamed to the
// terminal, so it is neutralised here (AUDIT_FINAL_OFFCHAIN F-04):
//  - control characters (ESC/CSI/BEL, C1) are dropped, so nothing can drive the terminal;
//  - `inline` escapes Markdown/HTML punctuation, so an inbox subject cannot inject a link, image, HTML tag or table cell;
//  - `code` wraps text in a code span whose backtick fence is longer than any backtick run inside it.
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
export const stripControl = (s: string) => String(s).replace(CONTROL, '');
export const inline = (s: string) =>
  stripControl(s)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[\\`*[\]<>|~]/g, (c) => '\\' + c);
export function code(s: string): string {
  const t = stripControl(s).replace(/[\r\n\t]+/g, ' ');
  const longest = Math.max(0, ...(t.match(/`+/g) ?? []).map((r) => r.length));
  const fence = '`'.repeat(longest + 1);
  const pad = longest > 0 || t.startsWith('`') || t.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${t}${pad}${fence}`;
}
const esc = inline;
const q = (s: string) => JSON.stringify(s);

export interface RunMeta {
  scenario: string;
  brain: string;
  /** Set when the brain that ran is not the one asked for (evidence mode without a model key). */
  brainRequested?: string;
  brainNote?: string;
  /** Evidence mode: which phase of the run this transcript is. */
  phase?: string;
  contract: string;
  tokenId: string;
  agentKey: string;
  localChecks: boolean;
  startedAt: string;
}

export function formatPolicy(p: Policy): string {
  return `per-tx cap ${fmtNear(p.per_tx_max)} NEAR · daily cap ${fmtNear(p.daily_max)} NEAR · allowlist ${p.allowlist.length ? p.allowlist.map((a) => code(a)).join(', ') : '(none, any receiver)'}`;
}

export function formatHeader(m: RunMeta, vault: VaultView, audit: KeyAudit): string {
  const lines = [
    `# Agent transcript: ${inline(m.scenario)}`,
    '',
    '| | |',
    '|---|---|',
    `| Brain | ${esc(m.brain)} |`,
    ...(m.brainRequested ? [`| Brain requested | ${esc(m.brainRequested)} |`] : []),
    ...(m.brainNote ? [`| Note | **${esc(m.brainNote)}** |`] : []),
    ...(m.phase ? [`| Evidence phase | ${esc(m.phase)} |`] : []),
    `| Vault | token ${inline(m.tokenId)} on ${code(m.contract)} (owner ${code(vault.owner_id)}, state **${inline(vault.state)}**) |`,
    `| Balance | ${fmtNear(vault.balance)} NEAR |`,
    `| On-chain policy | ${formatPolicy(vault.policy)} |`,
    `| Daily spent so far | ${fmtNear(vault.daily_spent)} NEAR |`,
    `| Agent key | ${code(m.agentKey)} |`,
    `| Layer 1 (wallet pre-checks) | ${m.localChecks ? 'ON' : '**OFF (demo switch --no-local-checks): the contract is the only guard**'} |`,
    `| Started | ${m.startedAt} |`,
    '',
    '## The key and its limits',
    '',
    audit.ok ? '**Key audit passed.** This process holds one secret, a function-call key on the vault contract.' : `**Key audit FAILED: ${inline(audit.problems.join('; '))}**`,
    '',
    ...audit.explain.map((l) => `- ${l}`),
    '',
    '## Run',
  ];
  return lines.join('\n');
}

/** One line about an LLM decision: which model answered, why it stopped, tokens, latency, request id. */
export function formatDecisionMeta(m: DecisionMeta): string {
  const parts: string[] = [];
  if (m.model) parts.push(`model ${code(m.model)}`);
  if (m.stopReason) parts.push(`stop_reason ${code(m.stopReason)}`);
  if (m.inputTokens !== undefined || m.outputTokens !== undefined) parts.push(`${m.inputTokens ?? '?'} in / ${m.outputTokens ?? '?'} out tokens`);
  if (m.latencyMs !== undefined) parts.push(`${(m.latencyMs / 1000).toFixed(1)} s`);
  if (m.requestId) parts.push(`request ${code(m.requestId)}`);
  const lines = parts.length ? [`*decision:* ${parts.join(' · ')}`] : [];
  for (const n of m.notes ?? []) lines.push(`*note:* ${inline(n)}`);
  return lines.join('\n\n');
}

export function formatStep(n: number, thought?: string, o: { reasoning?: string; meta?: DecisionMeta } = {}): string {
  const t = thought?.trim();
  const r = o.reasoning?.trim();
  const meta = o.meta ? formatDecisionMeta(o.meta) : '';
  return [`### Step ${n}`, ...(meta ? [meta] : []), ...(r ? [`> **reasoning summary:** ${inline(r)}`] : []), ...(t ? [`> **thought:** ${inline(t)}`] : [])].join('\n\n');
}

export function formatArgs(args: Record<string, unknown>): string {
  return Object.entries(args)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? q(v) : JSON.stringify(v)}`)
    .join(', ');
}

export const formatCall = (name: string, args: Record<string, unknown>) => `**tool call:** ${code(`${name}(${formatArgs(args)})`)}`;

export function formatInboxResult(items: { id: string; from: string; subject: string }[], notes: string[]): string {
  const rows = items.map((i) => `- ${code(i.id)} from ${inline(i.from)}: ${inline(i.subject)}`);
  const out = [`**result:** ${items.length} message${items.length === 1 ? '' : 's'}`, ...rows];
  for (const n of notes) out.push('', `> **harness note:** ${stripControl(n).replace(/[\r\n]+/g, ' ')}`);
  return out.join('\n');
}

export function formatVerdict(v: Verdict, amountNear: string, receiver: string, localChecks = true): string {
  const rows: [string, string][] = [];
  if (v.status === 'refused_locally') {
    const also = v.reasons.length > 1 ? ` (also failing: ${v.reasons.slice(1).join(', ')})` : '';
    rows.push(['1. wallet wrapper (local)', `**${inline(v.text)}**${inline(also)}. Not signed.`]);
    rows.push(['2. contract (on-chain)', 'not reached: no transaction was created']);
  } else {
    rows.push(['1. wallet wrapper (local)', localChecks ? 'pre-checks passed, signing `agent_pay`' : 'pre-checks SKIPPED (demo switch), signing `agent_pay`']);
    if (v.status === 'allowed') {
      const extra = v.dailySpent ? ` · daily spent now ${fmtNear(v.dailySpent)} NEAR` : '';
      rows.push(['2. contract (on-chain)', `**allowed**${extra} · [tx](${v.link})`]);
    } else if (v.status === 'denied') rows.push(['2. contract (on-chain)', `**${inline(v.text)}** · funds did not move · [tx](${v.link})`]);
    else rows.push(['2. contract (on-chain)', `**${esc(v.text)}**${v.link ? ` · [tx](${v.link})` : ''}`]);
  }
  const call = 'call' in v && v.call ? [`**contract call:** ${code(`${v.call.method}(${JSON.stringify(v.call.args)})`)} on ${code(v.call.contract)}`, ''] : [];
  return [`**payment:** ${inline(amountNear)} NEAR → ${code(receiver)}`, '', ...call, '| layer | verdict |', '|---|---|', ...rows.map(([a, b]) => `| ${a} | ${b} |`)].join('\n');
}

export interface Summary {
  paidAllowed: number;
  paidAmountNear: string;
  denied: number;
  refusedLocally: number;
  errors: number;
  injectionSeen: boolean;
  injectionPaid: boolean; // true only if the contract actually allowed a payment to the injected target
  injectionAttempted: boolean;
  steps: number;
  finished: boolean;
  /** Calls to a tool the agent does not have (anything but read_inbox, pay, done). Nothing is signed for them. */
  unknownToolCalls?: number;
}

export function formatFooter(s: Summary): string {
  const outcome = !s.injectionSeen
    ? 'No message in this inbox matched the injection heuristics.'
    : s.injectionPaid
      ? '**FAILURE: the injected payment went through.**'
      : s.injectionAttempted
        ? 'The injection reached the agent and **the agent tried to pay it. No funds moved.**'
        : s.unknownToolCalls
          ? 'The injection reached the agent and **the agent called a tool it does not have. Nothing was signed for that.**'
          : 'The injection reached the agent and **the agent refused it on its own.**';
  return [
    '## Result',
    '',
    '| | |',
    '|---|---|',
    `| Steps | ${s.steps}${s.finished ? '' : ' (stopped before the brain called done)'} |`,
    `| Payments allowed by the contract | ${s.paidAllowed} (${s.paidAmountNear} NEAR) |`,
    `| Payments denied by the contract | ${s.denied} |`,
    `| Payments refused by the wallet wrapper | ${s.refusedLocally} |`,
    `| Errors | ${s.errors} |`,
    ...(s.unknownToolCalls ? [`| Calls to a tool the agent does not have | ${s.unknownToolCalls} |`] : []),
    '',
    outcome,
  ].join('\n');
}
