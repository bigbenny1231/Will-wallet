// Live from NEAR testnet: read-only `query` (call_function) calls to the contract. No keys, no writes.
const CONTRACT = 'dmw-x8cx.testnet';
const RPCS = ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'];
const NEARBLOCKS = 'https://testnet.nearblocks.io/txns/';

// Settlement transactions of vault 17, from the recorded run (docs/video/README.md, verified in docs/AUDIT_CLAIMS.md).
const V17_TX = {
  step_1: ['JDrdzwBT3geAV9LLeK87MUhQqXU94SakUkkcfMdxnwwr'],
  step_2: ['85NiR7xyLDGyUnqvVzQgMv3Jpwr29r1S4evQ9cq3q5sZ'],
  step_3: ['2mkJionfqdUHzCKgmxGJu5SscfG2cEfRugd8YyovkB2i', 'B28MrsJjQZSWurNYEUdohS61Jc7Vwyav6XUXVFGVgmXk', '4aKAE3y9Gp8qpeMLQXdC4oHb93DXy6CVGaRNBqyU6uJr'],
  step_4: ['FzuDJq23u1Fyr8U1N11AJV3TE7dozvEqvtwJgKFCVjJM'],
  step_5: ['7QKzJUBoPKJLFJ3fJmqgLrYVyhw98UiuFJ6V5EkChEhm'],
};
const STEP_LABEL = {
  step_1: ['I', 'Heirs paid on NEAR'],
  step_2: ['II', 'Pulse and agent keys deleted'],
  step_3: ['III', 'Base, Monad and Solana payouts signed'],
  step_4: ['IV', 'Estate DAO proposal'],
  step_5: ['V', 'Will NFT handed over'],
};
const TX_NAMES = { step_3: ['Base', 'Monad', 'Solana'] };
const TONE = { Alive: 'alive', Warning: 'warn', Paused: 'warn', Triggered: 'dead', Settled: 'still' };

async function view(method, args) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 'dmw-site', method: 'query',
    params: { request_type: 'call_function', finality: 'final', account_id: CONTRACT, method_name: method, args_base64: btoa(JSON.stringify(args)) },
  });
  let last;
  for (const url of RPCS) {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 7000);
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctl.signal });
      clearTimeout(t);
      const j = await r.json();
      if (j.error || !j.result || !j.result.result) throw new Error(JSON.stringify(j.error || j.result));
      return JSON.parse(new TextDecoder().decode(new Uint8Array(j.result.result)));
    } catch (e) { last = e; }
  }
  throw last;
}

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 90) return 'just now';
  const m = s / 60; if (m < 90) return Math.round(m) + ' min ago';
  const h = m / 60; if (h < 36) return Math.round(h) + ' h ago';
  return Math.round(h / 24) + ' days ago';
}
function until(ms) {
  const s = (ms - Date.now()) / 1000;
  if (s <= 0) return 'now, if no beat has arrived';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return 'in ' + (d ? d + ' d ' + h + ' h' : h ? h + ' h ' + m + ' min' : m + ' min') + ' without a beat';
}
const utc = (ms) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';
const short = (acct) => acct.replace(/\.testnet$/, '').replace(/^dmw-(demo-)?/, '').replace(/-[0-9a-f]{4,}$/, '');
const pct = (bps) => (bps / 100).toFixed(0) + '%';

function setState(node, state, note) {
  node.textContent = state;
  node.dataset.tone = TONE[state] || '';
  if (note) node.append(' ', el('small', '', note));
}

export async function init() {
  const grid = document.getElementById('live-grid');
  const when = document.getElementById('live-when');
  const q = (k) => grid.querySelector('[data-live="' + k + '"]');
  try {
    const [supply, v6, v17] = await Promise.all([
      view('nft_total_supply', {}),
      view('get_vault', { token_id: '6' }),
      view('get_vault', { token_id: '17' }),
    ]);
    q('supply').textContent = String(supply);

    setState(q('v6-state'), v6.state);
    q('v6-beat').textContent = ago(v6.last_beat_ms);
    q('v6-beat').title = utc(v6.last_beat_ms);
    q('v6-warn').textContent = v6.state === 'Alive' ? until(v6.warning_at_ms) : utc(v6.warning_at_ms);
    q('v6-heirs').textContent = v6.heirs.map((h) => short(h.account_id) + ' ' + pct(h.bps)).join(', ');

    setState(q('v17-state'), v17.state, v17.state === 'Settled' ? 'step ' + Math.min(v17.step, 5) + ' of 5 done' : '');
    const list = q('v17-steps');
    list.textContent = '';
    v17.log.filter((l) => STEP_LABEL[l.event]).forEach((l) => {
      const [n, label] = STEP_LABEL[l.event];
      const li = el('li');
      li.append(el('span', 'n', n));
      const what = el('span', '', label);
      let detail = l.detail;
      if (l.event === 'step_1') detail = detail.split(', ').map((p) => { const [a, ...r] = p.split(' '); return short(a) + ' ' + r.join(' '); }).join(', ');
      if (l.event === 'step_3') detail = v17.foreign.map((f) => f.chain[0].toUpperCase() + f.chain.slice(1) + ' ' + f.status).join(', ') + '; none relayed';
      if (l.event === 'step_4' && /no dao/i.test(detail)) detail = 'No estate DAO set, so skipped';
      if (l.event === 'step_5') detail = 'to ' + short(detail.replace(/^will nft -> /, ''));
      what.append(el('span', 'd', detail + ', ' + utc(l.ms)));
      li.append(what);
      const tx = el('span');
      (V17_TX[l.event] || []).forEach((h, i) => {
        const a = el('a', '', TX_NAMES[l.event] ? TX_NAMES[l.event][i] : 'tx');
        a.href = NEARBLOCKS + h;
        a.setAttribute('aria-label', a.textContent + ': ' + label + ', transaction on nearblocks');
        if (i) tx.append(' ');
        tx.append(a);
      });
      li.append(tx);
      list.append(li);
    });
    when.textContent = 'Read at ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }) + ', your time.';
  } catch (e) {
    console.warn('live strip: RPC failed', e);
    grid.hidden = true;
    document.getElementById('live-fail').hidden = false;
    when.textContent = '';
  } finally {
    grid.setAttribute('aria-busy', 'false');
  }
}
