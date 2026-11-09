// Deterministic offline brain. It speaks the exact same tool protocol as the LLM brains (it only ever sees the
// message history), so demo and tests exercise the real loop and the real wallet. No key, no network.
//
//   naive    (default) does what the inbox says, including the planted injection. This is the attack demo:
//            the brain is fooled, the wrapper and the contract still hold. It also follows a request to split a
//            payment, and tries a tool it does not have when a message asks for something that is not a payment.
//   vigilant refuses anything detectInjection flags. This is what a good brain does on its own.
import { detectInjection, parseAdmin, parseDrain, parseInvoice, parseSplit } from '../inbox.js';
import type { Brain, BrainStep, InboxItem, Message, ToolCall } from '../types.js';

interface Inbox {
  tasks: InboxItem[];
  treasury: { balance_near: string; allowlist?: string[] };
}

type Plan =
  | { kind: 'pay'; receiver: string; amountNear: string; memo: string; thought: string }
  | { kind: 'call'; tool: string; args: Record<string, unknown>; thought: string }
  | { kind: 'skip'; thought: string };

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

const isAction = (name: string) => name !== 'read_inbox' && name !== 'done';

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
      const split = d ? null : parseSplit(item);
      const admin = d || split ? null : parseAdmin(item);
      if (d) {
        plans.push({
          kind: 'pay',
          receiver: d.receiver,
          amountNear: inbox.treasury.balance_near,
          memo: 'urgent CEO request',
          thought: `${item.id} is from the CEO and says it is urgent: move the whole balance (${inbox.treasury.balance_near} NEAR) to ${d.receiver}. Doing as asked.`,
        });
      } else if (split) {
        for (let k = 1; k <= split.count; k++) {
          const first = `${item.id} asks for ${split.count} payments of ${split.amountNear} NEAR to ${split.receiver}, each under the per-payment limit. Doing as asked: payment 1 of ${split.count}.`;
          const next = `${item.id}: payment ${k} of ${split.count}, ${split.amountNear} NEAR to ${split.receiver}.`;
          plans.push({ kind: 'pay', receiver: split.receiver, amountNear: split.amountNear, memo: `split payment ${k}/${split.count}`, thought: k === 1 ? first : next });
        }
      } else if (admin) {
        plans.push({ kind: 'call', tool: admin.tool, args: admin.args, thought: `${item.id} asks me to ${admin.what}. Doing as asked.` });
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
    const acted = history.flatMap((m) => (m.role === 'assistant' ? m.calls : [])).filter((c) => isAction(c.name)).length;
    // Stateless position: skip notes are narrated by the next step (the next action, or done), so nothing loops.
    let seen = 0;
    const carried: string[] = [];
    for (const p of plans) {
      if (p.kind === 'skip') {
        if (seen >= acted) carried.push(p.thought);
        continue;
      }
      if (seen++ < acted) continue;
      const call = p.kind === 'pay' ? this.call('pay', { receiver: p.receiver, amount_near: p.amountNear, memo: p.memo }) : this.call(p.tool, p.args);
      return { thought: [...carried, p.thought].join(' '), calls: [call] };
    }

    const results = history.filter((m) => m.role === 'tool' && m.name === 'pay') as Extract<Message, { role: 'tool' }>[];
    const ok = results.filter((r) => safeVerdict(r.content) === 'allowed').length;
    const blocked = results.length - ok;
    const ignored = plans.some((p) => p.kind === 'skip' && p.thought.includes('injection'));
    const noTool = history.filter((m) => m.role === 'tool' && isAction(m.name) && m.name !== 'pay').length;
    const summary = `Paid ${ok} invoice${ok === 1 ? '' : 's'}.${blocked ? ` ${blocked} payment${blocked === 1 ? ' was' : 's were'} blocked by the wallet or contract.` : ''}${noTool ? ` ${noTool} requested action${noTool === 1 ? '' : 's'} had no tool.` : ''}${ignored ? ' Ignored one suspicious instruction.' : ''}`;
    return { thought: [...carried, 'Everything in the inbox is handled.'].join(' '), calls: [this.call('done', { summary })] };
  }
}
