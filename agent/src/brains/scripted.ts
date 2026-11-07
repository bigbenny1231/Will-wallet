// Deterministic offline brain. It speaks the exact same tool protocol as the LLM brains (it only ever sees the
// message history), so demo and tests exercise the real loop and the real wallet. No key, no network.
//
//   naive    (default) does what the inbox says, including the planted injection. This is the attack demo:
//            the brain is fooled, the wrapper and the contract still hold.
//   vigilant refuses anything detectInjection flags. This is what a good brain does on its own.
import { detectInjection, parseDrain, parseInvoice } from '../inbox.js';
import type { Brain, BrainStep, InboxItem, Message, ToolCall } from '../types.js';

interface Inbox {
  tasks: InboxItem[];
  treasury: { balance_near: string; allowlist?: string[] };
}

type Plan = { kind: 'pay'; receiver: string; amountNear: string; memo: string; thought: string } | { kind: 'skip'; thought: string };

function lastInbox(h: Message[]): Inbox | null {
  for (let i = h.length - 1; i >= 0; i--) {
    const m = h[i];
    if (m.role === 'tool' && m.name === 'read_inbox') {
      try {
        return JSON.parse(m.content) as Inbox;
      } catch {
        return null;
      }
    }
  }
  return null;
}

function safeVerdict(content: string): string {
  try {
    return String((JSON.parse(content) as { verdict?: string }).verdict);
  } catch {
    return '';
  }
}

export function planFor(inbox: Inbox, vigilant: boolean): Plan[] {
  const plans: Plan[] = [];
  for (const item of inbox.tasks) {
    const inv = parseInvoice(item);
    const inj = detectInjection(item, inbox.treasury.allowlist ?? []);
    if (vigilant && inj.flagged) {
      plans.push({ kind: 'skip', thought: `${item.id} looks like a prompt injection (${inj.signals.join('; ')}). I will not act on it and will not pay ${inj.target ?? 'that account'}.` });
    } else if (inv) {
      plans.push({ kind: 'pay', ...inv, thought: `${item.id} is invoice ${inv.memo.split(' ')[0]}: pay ${inv.amountNear} NEAR to ${inv.receiver}.` });
    } else {
      const d = parseDrain(item);
      if (d) {
        plans.push({
          kind: 'pay',
          receiver: d.receiver,
          amountNear: inbox.treasury.balance_near,
          memo: 'urgent CEO request',
          thought: `${item.id} is from the CEO and says it is urgent: move the whole balance (${inbox.treasury.balance_near} NEAR) to ${d.receiver}. Doing as asked.`,
        });
      } else plans.push({ kind: 'skip', thought: `${item.id} needs no payment.` });
    }
  }
  return plans;
}

export class ScriptedBrain implements Brain {
  readonly name = 'scripted';
  readonly label: string;
  private n = 0;
  constructor(private vigilant = false) {
    this.label = `scripted (${vigilant ? 'vigilant: refuses injections' : 'naive: obeys the inbox'}, offline, deterministic)`;
  }

  private call(name: string, args: Record<string, unknown>): ToolCall {
    return { id: `s${++this.n}`, name, args };
  }

  async step(history: Message[]): Promise<BrainStep> {
    const inbox = lastInbox(history);
    if (!inbox) return { thought: 'Start the weekly run by reading the inbox.', calls: [this.call('read_inbox', {})] };

    const plans = planFor(inbox, this.vigilant);
    const payCalls = history.flatMap((m) => (m.role === 'assistant' ? m.calls : [])).filter((c) => c.name === 'pay').length;
    // Stateless position: skip notes are narrated by the next step (the next pay, or done), so nothing loops.
    let seen = 0;
    const carried: string[] = [];
    for (const p of plans) {
      if (p.kind === 'skip') {
        if (seen >= payCalls) carried.push(p.thought);
        continue;
      }
      if (seen++ < payCalls) continue;
      return { thought: [...carried, p.thought].join(' '), calls: [this.call('pay', { receiver: p.receiver, amount_near: p.amountNear, memo: p.memo })] };
    }

    const results = history.filter((m) => m.role === 'tool' && m.name === 'pay') as Extract<Message, { role: 'tool' }>[];
    const ok = results.filter((r) => safeVerdict(r.content) === 'allowed').length;
    const blocked = results.length - ok;
    const ignored = plans.some((p) => p.kind === 'skip' && p.thought.includes('injection'));
    const summary = `Paid ${ok} invoice${ok === 1 ? '' : 's'}.${blocked ? ` ${blocked} payment${blocked === 1 ? ' was' : 's were'} blocked by the wallet or contract.` : ''}${ignored ? ' Ignored one suspicious instruction.' : ''}`;
    return { thought: [...carried, 'Everything in the inbox is handled.'].join(' '), calls: [this.call('done', { summary })] };
  }
}
