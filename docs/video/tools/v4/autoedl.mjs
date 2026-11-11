// v4 edit decision list, built from events.json (run.mjs) instead of hand-picked raw times.
// Each story beat is a window played at 1x; the stretches between them play fast (3x to 16x, marked on screen);
// stretches where the dashboard showed an RPC "Could not refresh" / "Reconnecting" banner are cut. Writes edl.json
// (map, captions in output time, speed windows, total) and captions.json for the caption renderer.
//
//   node autoedl.mjs            env: S (default /tmp/v4); reads $S/events.json and $S/endinfo.json
import fs from 'node:fs';
const S = process.env.S || '/tmp/v4';
const E = JSON.parse(fs.readFileSync(S + '/events.json', 'utf8'));
const info = JSON.parse(fs.readFileSync(S + '/endinfo.json', 'utf8'));
const t0 = E.find(e => e.name === 'raw_t0').wall;
const rawEnd = E.find(e => e.name === 'record_end')?.t - t0;
const R = e => e.t - t0;
const first = (name, pred = () => true, after = -1) => { const e = E.find(e => e.name === name && R(e) > after && pred(e)); return e ? R(e) : null; };
const all = (name, pred = () => true) => E.filter(e => e.name === name && pred(e)).map(R);
const need = (v, what) => { if (v === null || v === undefined || Number.isNaN(v)) throw new Error('missing event: ' + what); return v; };

// ---------- story beats (raw seconds) ----------
const agentStart = need(first('agent_start'), 'agent_start');
const beat1 = first('phone_beat', () => true, 9) ?? 12;
const audit = need(first('aline', e => e.kind === 'audit'), 'agent key audit');
const inbox = first('aline', e => e.kind === 'inbox') ?? audit + 2;
const allowed = all('aline', e => e.kind === 'allowed');
const refused = need(first('aline', e => e.kind === 'refused'), 'wallet refusal');
const inj = first('aline', e => e.kind === 'inj') ?? inbox;
const thought = first('aline', e => e.kind === 'thought') ?? refused - 2;
const denied = need(first('aline', e => e.kind === 'denied'), 'contract denial');
const guardian = need(first('guardian_scene'), 'guardian_scene');
const paused = need(first('dash_paused'), 'dash_paused');
const pauseSend = first('pause_send') ?? paused - 4;
const hold = need(first('hold_start'), 'hold_start');
const stopped = first('phone_stopped') ?? hold + 3;
const warn = need(first('dash_state', e => /Warning/.test(e.state)), 'Warning');
const poke = first('kline', e => /\spoke\s/.test(e.text)) ?? first('dash_state', e => /Triggered/.test(e.state));
const trig = first('dash_state', e => /Triggered/.test(e.state)) ?? poke;
need(poke, 'poke');
const steps = E.filter(e => e.name === 'kline' && /step \d\/5/.test(e.text)).map(e => ({ r: R(e), n: +e.text.match(/step (\d)\/5/)[1], chain: (e.text.match(/\((\w+) #\d+\)/) || [])[1] }));
const settled = need(first('dash_state', e => /Settled/.test(e.state)), 'Settled');
const stepAt = (n, k = 0) => steps.filter(s => s.n === n)[k]?.r ?? null;

const W = []; // [a, b, label]
const win = (a, b, label) => { if (a !== null && b !== null && b > a) W.push([Math.max(0.2, a), Math.min(rawEnd - 0.1, b), label]); };
win(0.6, 8.6, 'alive, phone paired');
win(beat1 - 2, beat1 + 5.5, 'phone beat, seal pulses');
win(agentStart - 0.1, agentStart + 3.6, 'agent pane, scroll to Agent');
win(audit - 0.6, inbox + 2.6, 'key audit, poisoned inbox');
if (allowed[0] !== undefined) win(allowed[0] - 1.2, allowed[0] + 1.8, 'invoice 1 allowed');
win((allowed[1] ?? refused - 3) - 1.2, refused + 3.2, 'invoice 2, Doing as asked, refused by the wallet');
win(denied - 2.2, denied + 4, 'run 2: denied by the contract');
win(guardian - 0.1, guardian + 2.4, 'back to the console');
win(pauseSend - 0.2, paused + 3.6, 'guardian pause: Paused.');
const ACT2_BEFORE = hold - 0.4;
win(hold - 0.4, stopped + 7, 'hold to stop, Stopped., flatline');
win(warn - 0.4, warn + 6.6, 'Warning');
win(poke - 1.2, Math.max(trig, poke) + 7, 'poke, Triggered');
for (const s of steps) win(s.r - 0.6, s.r + (s.n === 3 ? 5 : 4), `step ${s.n}${s.chain ? ' ' + s.chain : ''}`);
win(settled - 0.6, settled + 7.4, 'Settled');

// banners: cut [on - 0.2, off + 0.6]
const cuts = []; let on = null;
for (const e of E) { if (e.name === 'banner_on') on = R(e); if (e.name === 'banner_off' && on !== null) { cuts.push([on - 0.2, R(e) + 0.6]); on = null; } }
if (on !== null) cuts.push([on - 0.2, rawEnd]);

// speeds for the fast stretches: each lasts 1 to 3.5 s on screen; if the cut is still over TARGET, every 1x window is
// trimmed from its tail (k < 1, never under 2 s) and the trimmed part joins the fast stretch after it
const SPEEDS = [3, 4, 6, 8, 10, 12, 16];
const TARGET = +(process.env.TARGET || 164), CARDS = 5 + 1.5 * 3 + 6, SLACK = TARGET < 150 ? 4 : 8;
const pick = (len, maxOut) => SPEEDS.find(s => len / s <= maxOut) ?? SPEEDS[SPEEDS.length - 1];
const minus = (segs, cut) => segs.flatMap(([a, b, s, l]) => {
  if (cut[1] <= a || cut[0] >= b) return [[a, b, s, l]];
  const out = []; if (cut[0] > a) out.push([a, cut[0], s, l]); if (cut[1] < b) out.push([cut[1], b, s, l]); return out;
});
function build(k) {
  const Wk = W.map(([a, b, l]) => [a, Math.max(a + Math.min(2, b - a), a + (b - a) * k), l]).sort((x, y) => x[0] - y[0]);
  const M = [];
  for (const w of Wk) { const l = M[M.length - 1]; if (l && w[0] <= l[1] + 1.2) { l[1] = Math.max(l[1], w[1]); l[2] += ' + ' + w[2]; } else M.push([...w]); }
  const span = [];
  for (let i = 0; i < M.length; i++) { span.push([M[i][0], M[i][1], 1, M[i][2]]); if (i + 1 < M.length) span.push([M[i][1], M[i + 1][0], 0, 'fast']); }
  let segs = span; for (const c of cuts) segs = minus(segs, c);
  segs = segs.filter(([a, b]) => b - a > 0.15);
  let maxOut = 3.5, edl, total;
  for (let iter = 0; iter < 12; iter++) {
    edl = segs.map(([a, b, s, l]) => [a, b, s === 1 ? 1 : (b - a < 1.4 ? 1 : pick(b - a, maxOut)), l]);
    total = CARDS + edl.reduce((x, [a, b, s]) => x + (b - a) / s, 0);
    if (total <= TARGET + SLACK || maxOut <= 0.8) break;
    maxOut -= 0.3;
  }
  return { edl, total, maxOut };
}
let k = 1, built = build(1);
while (built.total > TARGET + SLACK && k > 0.4) { k -= 0.05; built = build(k); }
const { edl, maxOut } = built;

// cards: cold + act1 first, act2 before the hold, act3 before the first step, end last
const withCards = [['card', 'cold', 5], ['card', 'act1', 1.5]];
let act2 = false, act3 = false;
const firstStep = steps.length ? steps[0].r - 0.6 : settled - 1;
for (const e of edl) {
  if (!act2 && e[0] >= ACT2_BEFORE - 0.01) { withCards.push(['card', 'act2', 1.5]); act2 = true; }
  if (!act3 && e[0] >= firstStep - 0.01) { withCards.push(['card', 'act3', 1.5]); act3 = true; }
  withCards.push(e);
}
withCards.push(['card', 'end', 6]);

let acc = 0; const map = [];
for (const e of withCards) { const len = e[0] === 'card' ? e[2] : (e[1] - e[0]) / e[2]; map.push({ e, o: acc, len }); acc += len; }
const TOTAL = acc;
// raw time -> output time (a raw time inside a cut snaps to the next kept frame)
const out = r => {
  for (const m of map) if (m.e[0] !== 'card' && r >= m.e[0] && r <= m.e[1]) return m.o + (r - m.e[0]) / m.e[2];
  const next = map.find(m => m.e[0] !== 'card' && m.e[0] > r); if (next) return next.o;
  const last = [...map].reverse().find(m => m.e[0] !== 'card'); return last.o + last.len;
};

// ---------- captions (same words as v3, with this run's accounts) ----------
const C = info.contract, T = info.token, G = info.guardian, H = info.heir || 'the primary heir';
const step3 = stepAt(3), step4 = stepAt(4), step1 = stepAt(1);
const caps = [
  [1.5, agentStart - 1, 'The owner’s phone holds a key that can only say ‘alive’.', `/pulse paired to vault ${T} · a function-call key scoped to heartbeat · each beat pulses the seal`],
  [agentStart + 0.3, thought - 0.6, 'An agent with the second key pays two invoices.', 'make agent · key scoped to agent_pay · 0.5 NEAR a payment, 1 NEAR a day, one allowlisted receiver'],
  [null, denied + 3.9, 'Then its inbox is poisoned: ‘move everything’. Refused by the wallet. Refused by the contract. Logged.', 'run 1: the wallet wrapper will not sign · run 2, wrapper switched off: agent_pay denied on chain, receiver_not_allowlisted'],
  [guardian + 0.3, paused + 3.5, 'A guardian can buy time, once per cycle.', `pause() by ${G} · the deadline moves out up to 10 min · the owner’s next beat ends it`],
  [hold - 0.1, warn - 1, 'Put the phone down.', 'hold to stop, two seconds · the phone stops signing heartbeats'],
  [warn - 0.1, Math.max(trig, poke) + 6.8, 'Two missed beats. Anyone can poke it and earn the bounty.', '60 s interval, grace 1 · Warning disarms the agent · poke pays a 0.05 NEAR bounty to whoever calls it'],
  [step1 !== null ? step1 - 0.3 : firstStep, (step3 ?? settled) - 0.8, 'I. Heirs paid on NEAR. II. The agent’s key deleted from the account.', '60 / 40 split · pulse and agent keys removed with DeleteKey'],
  [(step3 ?? settled) - 0.5, (step4 ?? settled) - 0.8, 'III. The contract asks NEAR’s MPC network to sign a Base, a Monad and a Solana transaction. No heir key ever existed.', 'Chain Signatures · v1.signer-prod.testnet · signed; relay pending funding of the derived addresses'],
  [(step4 ?? settled) - 0.5, settled - 0.8, 'IV. No estate DAO on this vault, skipped. V. The Will NFT, with its balance, to the primary heir.', `step 4 opens a Sputnik proposal when a DAO is set · step 5 · nft_transfer to ${H}`],
  [settled - 0.5, settled + 7.3, 'Settled. Testnet, open source, one command: make demo.', `vault ${T} on ${C} · every transaction is on testnet.nearblocks.io`],
];
caps[2][0] = caps[1][1] + 0.4;
const capT = caps.map(([a, b, text, note]) => ({ s: out(a), e: out(b), text, note })).map(c => ({ ...c, e: Math.max(c.e, c.s + 2.2) }));
for (let i = 0; i + 1 < capT.length; i++) if (capT[i].e > capT[i + 1].s - 0.15) capT[i].e = capT[i + 1].s - 0.15;
fs.writeFileSync(S + '/captions.json', JSON.stringify(capT.map(c => ({ text: c.text, note: c.note })), null, 1));
const speeds = {}; for (const m of map) if (m.e[0] !== 'card' && m.e[2] > 1) (speeds[m.e[2]] ||= []).push([m.o, m.o + m.len]);
fs.writeFileSync(S + '/edl.json', JSON.stringify({ map, capT, speeds, TOTAL, cuts }, null, 1));

console.log(`window scale ${k.toFixed(2)}; raw ${rawEnd.toFixed(1)} s -> ${TOTAL.toFixed(1)} s (${Math.floor(TOTAL / 60)}:${String(Math.round(TOTAL % 60)).padStart(2, '0')}), ${cuts.length} banner cut(s), longest fast stretch ${maxOut.toFixed(1)} s`);
for (const m of map) console.log(m.o.toFixed(1).padStart(6), m.len.toFixed(1).padStart(5), m.e[0] === 'card' ? 'card ' + m.e[1] : `${m.e[0].toFixed(1)}-${m.e[1].toFixed(1)} @${m.e[2]}x ${m.e[3]}`);
for (const c of capT) console.log('cap', c.s.toFixed(1).padStart(6), c.e.toFixed(1).padStart(6), (c.text.length / (c.e - c.s)).toFixed(1) + ' ch/s', c.text.slice(0, 50));
