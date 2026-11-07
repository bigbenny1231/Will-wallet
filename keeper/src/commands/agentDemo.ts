import { randomBytes } from 'node:crypto';
import pc from 'picocolors';
import type { Backend } from '../backend.js';
import type { TxResult } from '../types.js';
import { formatYocto, nearTxLink, parseEvents, termSafe } from '../util.js';

export interface DemoCall {
  label: string;
  receiver: string;
  amount: string;
  tx?: TxResult;
  error?: string;
}

export function planDemoCalls(policy: { per_tx_max: string; allowlist: string[] }, receiverOverride?: string) {
  const perTx = BigInt(policy.per_tx_max);
  const allowed = {
    receiver: receiverOverride || policy.allowlist[0] || 'agent-demo-receiver.testnet',
    amount: String(perTx / 10n > 0n ? perTx / 10n : 1n),
  };
  const denied = {
    receiver: `stranger-${randomBytes(4).toString('hex')}.testnet`,
    amount: String(perTx * 2n),
  };
  return { allowed, denied };
}

export function renderEvent(e: { event: string; data: Record<string, unknown> }): string {
  const d = e.data;
  const detail = [d.receiver_id && `to ${d.receiver_id}`, d.amount && formatYocto(String(d.amount)), d.reason && `reason=${d.reason}`]
    .filter(Boolean)
    .join(' · ');
  const line = termSafe(`  event ${e.event}${detail ? '  ' + detail : ''}`);
  if (e.event.endsWith('denied')) return pc.red(line);
  if (e.event.endsWith('allowed')) return pc.green(line);
  return pc.dim(line);
}

export async function agentDemo(o: {
  backend: Backend;
  tokenId: string;
  receiver?: string;
  out?: { write(s: string): unknown };
}): Promise<DemoCall[]> {
  const out = o.out ?? process.stdout;
  const w = (s: string) => out.write(s + '\n');
  const vault = await o.backend.getVault(o.tokenId);
  const plan = planDemoCalls(vault.policy, o.receiver);
  w(pc.dim(`policy: per_tx_max ${formatYocto(vault.policy.per_tx_max)} · daily_max ${formatYocto(vault.policy.daily_max)} · allowlist [${vault.policy.allowlist.join(', ')}]`));

  const calls: DemoCall[] = [];
  for (const [label, p, color] of [
    ['ALLOWED  (small, allowlisted)', plan.allowed, pc.green],
    ['DENIED   (unknown receiver, over per_tx_max)', plan.denied, pc.red],
  ] as const) {
    const call: DemoCall = { label, receiver: p.receiver, amount: p.amount };
    w('');
    w(color(pc.bold(`agent_pay ${label}`)) + pc.dim(`  ${formatYocto(p.amount)} → ${p.receiver}`));
    try {
      const tx = await o.backend.agentPay({ token_id: o.tokenId, receiver_id: p.receiver, amount: p.amount, memo: `agent-demo ${label.split(' ')[0].toLowerCase()}` });
      call.tx = tx;
      w(`  result ${JSON.stringify(tx.returnValue)}  ${nearTxLink(tx.hash)}`);
      if (tx.failure) w(pc.red(`  failure ${tx.failure}`));
      const events = parseEvents(tx.logs);
      if (!events.length) w(pc.yellow('  (no dmw events found in receipt logs)'));
      for (const e of events) w(renderEvent(e));
    } catch (e) {
      call.error = e instanceof Error ? e.message : String(e);
      w(pc.red(`  call failed: ${call.error}`));
    }
    calls.push(call);
  }
  return calls;
}
