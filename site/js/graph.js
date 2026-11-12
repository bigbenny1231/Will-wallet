// Live estate graph: vault 1 on dmw-885364.testnet (the showcase vault), read with read-only JSON-RPC `query` calls (no keys, no writes).
// Vault -> chains -> who receives what at settlement. Edges pulse on load and whenever the chain reports a new
// heartbeat (polled every 30 s while the section is on screen). Also the live facts kept from v3: the vault count,
// vault 1's last beat, and the demo vault's (5) five settlement steps as read now. The demo vault is the recorded v4 run on
// the v1 contract dmw-979268.testnet, so it is read there; switch DEMO_CONTRACT and DEMO when a run on the live contract lands.
import { emit, reducedMotion } from './seal.js';

const CONTRACT = 'dmw-885364.testnet';
const SHOWCASE = '1';   // keeper/SHOWCASE.md
const DEMO = '5';       // the recorded run (docs/video/README.md v4, docs/LIVE_CONTRACT.md)
const DEMO_CONTRACT = 'dmw-979268.testnet';   // where that run happened (v1, replaced by CONTRACT)
const RPCS = ['https://rpc.testnet.fastnear.com', 'https://rpc.testnet.near.org'];
const NEARBLOCKS = 'https://testnet.nearblocks.io/txns/';
const POLL_MS = 30000;

// Settlement transactions of the demo vault, from the recorded run's keeper log (docs/video/README.md, v4).
const V17_TX = {
  step_1: ['2z5qMVsTmKmePkiWL8Kx4rPRzRo1homBMkb8dKMhxHzu'],
  step_2: ['J2DjZKJPT92P7p21uwUaKdLtuFYmZD8kmm2Axe7TUTwa'],
  step_3: ['2LowT3BxTG6FwMc9XoSfdXUDfJHCGhBNrxAbPJj1p2FZ', 'Deh6BcXrce9QxvysidGMpnQDBbGXSnufQSCrqF5CQmUY', '5742KpKeQCHCVKavo8pRnyh95HEzNx1zErbrVRjBwHfX'],
  step_4: ['8v3opWesMmGkcKLSBbsYE7Ryut6H5Zz3LGiFdqhSQW3r'],
  step_5: ['8Cr3SCgTscu3s1ykhKe17dPs4FBZsjXDi5uwDwpJSyuk'],
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
const CHAIN = {
  near: { name: 'NEAR', net: 'NEAR testnet' },
  base: { name: 'Base', net: 'Base Sepolia', unit: 'ETH', dec: 18 },
  monad: { name: 'Monad', net: 'Monad testnet', unit: 'MON', dec: 18 },
  solana: { name: 'Solana', net: 'Solana devnet', unit: 'SOL', dec: 9 },
};

async function view(method, args, account = CONTRACT) {
  const body = JSON.stringify({
    jsonrpc: '2.0', id: 'dmw-site', method: 'query',
    params: { request_type: 'call_function', finality: 'final', account_id: account, method_name: method, args_base64: btoa(JSON.stringify(args)) },
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
function every(sec) {
  if (sec % 86400 === 0) { const d = sec / 86400; return d === 1 ? 'Every day' : 'Every ' + d + ' days'; }
  if (sec % 3600 === 0) return 'Every ' + sec / 3600 + ' h';
  if (sec % 60 === 0) return 'Every ' + sec / 60 + ' min';
  return 'Every ' + sec + ' s';
}
const utc = (ms) => new Date(ms).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'UTC' }) + ' UTC';
const short = (acct) => acct.replace(/\.testnet$/, '').replace(/^dmw-(demo-)?/, '').replace(/-[0-9a-f]{4,}$/, '');
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const pct = (bps) => (bps / 100).toFixed(0) + '%';
const mid = (a) => (a && a.length > 14 ? a.slice(0, 6) + '…' + a.slice(-4) : a);
function units(raw, dec) {
  const v = BigInt(raw);
  const base = 10n ** BigInt(dec);
  const whole = v / base;
  let frac = (v % base).toString().padStart(dec, '0').replace(/0+$/, '');
  return whole.toString() + (frac ? '.' + frac.slice(0, 6) : '');
}
const near = (y) => units(y, 24) + ' NEAR';
const statusWord = (s) => (s === 'signed' ? 'Signed, not relayed' : s === 'pending' ? 'Pending until settlement' : cap(s));

// Node positions as % of the graph box.
const LAYOUT = {
  wide: { vault: [10, 52], near: [44, 25], base: [44, 50], monad: [44, 67], solana: [44, 84], h0: [81, 17], h1: [81, 33], rbase: [81, 50], rmonad: [81, 67], rsolana: [81, 84] },
  narrow: { vault: [50, 10], near: [24, 36], base: [24, 55], monad: [24, 70], solana: [24, 85], h0: [72, 31], h1: [72, 42], rbase: [72, 55], rmonad: [72, 70], rsolana: [72, 85] },
};

function miniSeal() {
  return '<svg viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="47" fill="none" stroke="#C8A96A" stroke-width="1.5"/><circle cx="50" cy="50" r="42" fill="none" stroke="#C8A96A" stroke-width=".7"/>'
    + '<path d="M14 52h18l3-6 5 22 6-38 5 30 3-8h32" fill="none" stroke="#3DDC84" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
}

export async function init() {
  const graph = document.getElementById('graph');
  const nodesEl = document.getElementById('graph-nodes');
  const edgesEl = document.getElementById('graph-edges');
  const detail = document.getElementById('graph-detail');
  const when = document.getElementById('live-when');
  const grid = document.getElementById('live-grid');
  const fail = document.getElementById('live-fail');
  const q = (k) => grid.querySelector('[data-live="' + k + '"]');
  const rm = reducedMotion();

  let v6, supply, v17;
  try {
    [supply, v6, v17] = await Promise.all([
      view('nft_total_supply', {}),
      view('get_vault', { token_id: SHOWCASE }),
      view('get_vault', { token_id: DEMO }, DEMO_CONTRACT),
    ]);
  } catch (e) {
    console.warn('estate graph: RPC failed', e);
    graph.hidden = true; grid.hidden = true; detail.hidden = true;
    fail.hidden = false;
    when.textContent = '';
    return;
  }

  // ---------- nodes ----------
  const nodes = {};
  const edges = [];   // { a, b, stage, path, flow }
  let selected = 'vault';

  function details(id) {
    const v = v6;
    if (id === 'vault') {
      return {
        h: 'Vault ' + SHOWCASE + ', ' + v.state.toLowerCase(),
        rows: [
          ['Owner', v.owner_id, true],
          ['Holds', near(v.balance)],
          ['Heartbeat', every(v.heartbeat_interval_s) + ', with ' + v.grace_missed + ' missed beat of grace'],
          ['Last beat', ago(v.last_beat_ms) + ', ' + utc(v.last_beat_ms)],
          ['Turns amber', v.state === 'Alive' ? until(v.warning_at_ms) : utc(v.warning_at_ms)],
          ['Agent policy', near(v.policy.per_tx_max) + ' a payment, ' + near(v.policy.daily_max) + ' a day, to ' + v.policy.allowlist.join(', ')],
        ],
        note: v.pulse_keys.length || v.agent_keys.length ? '' : 'It has no pulse or agent key right now; the owner beats from their own account.',
      };
    }
    if (id === 'near') {
      return {
        h: 'NEAR, step I',
        rows: [['Heirs', v.heirs.map((x) => cap(short(x.account_id)) + ' ' + pct(x.bps)).join(', ')], ['From', near(v.balance) + ' in the vault']],
        note: 'At settlement the vault pays each heir their share of its NEAR, less a small reserve that the Will NFT holder can claim. Heirs sign nothing to receive it.',
      };
    }
    if (id === 'h0' || id === 'h1') {
      const x = v.heirs[id === 'h0' ? 0 : 1];
      return { h: cap(short(x.account_id)) + ', ' + pct(x.bps), rows: [['Account', x.account_id, true], ['Share', pct(x.bps) + ' of the NEAR, at step I']], note: 'Nothing to sign to receive it. The heir page lists every vault that names this account.' };
    }
    const chain = id.replace(/^r/, '');
    const f = v.foreign.find((p) => p.chain === chain);
    const c = CHAIN[chain];
    if (!f) return { h: c.name, rows: [], note: '' };
    // Contract v2 salts each vault's derivation path and publishes it as derivation_paths; until a payout is signed its
    // from_address is only what the owner typed, and at signing the contract writes the derived address into it.
    const paths = v.derivation_paths;
    const ownerTyped = !!paths && f.status === 'pending';
    const from = ownerTyped ? 'Written by the contract at signing' : f.from_address ? f.from_address : 'Not recorded yet';
    const rows = [['Network', c.net], ['Amount', units(f.amount, c.dec) + ' ' + c.unit], ['From', from, !ownerTyped && !!f.from_address]];
    if (paths) rows.push(['Derivation path', chain === 'solana' ? paths.solana : paths[chain], true]);
    rows.push(['To', f.to, true], ['Status', statusWord(f.status)]);
    return {
      h: id.startsWith('r') ? 'Recipient on ' + c.net : c.name + ', step III',
      rows,
      note: 'The vault has NEAR’s MPC network sign this payout only after the trigger, from an address derived from the vault. A keeper then relays it; the source address must hold the funds.',
    };
  }

  function show(id) {
    selected = id;
    Object.entries(nodes).forEach(([k, n]) => n.setAttribute('aria-pressed', String(k === id)));
    const d = details(id);
    detail.textContent = '';
    detail.append(el('h3', '', d.h));
    const dl = el('dl');
    d.rows.forEach(([k, val, mono]) => { const row = el('div'); row.append(el('dt', '', k)); const dd = el('dd', mono ? 'mono' : '', val); row.append(dd); dl.append(row); });
    detail.append(dl);
    if (d.note) detail.append(el('p', '', d.note));
    edges.forEach((e) => e.path.classList.toggle('is-hot', e.b === id || (e.a === id && id !== 'vault') || (onRoute(id, e))));
  }
  const parentOf = { near: 'vault', base: 'vault', monad: 'vault', solana: 'vault', h0: 'near', h1: 'near', rbase: 'base', rmonad: 'monad', rsolana: 'solana' };
  const onRoute = (id, e) => { let n = id; while (parentOf[n]) { if (e.b === n && e.a === parentOf[n]) return true; n = parentOf[n]; } return false; };

  function node(id, cls, parts, label) {
    const b = el('button', 'node ' + cls);
    b.type = 'button';
    b.dataset.id = id;
    b.setAttribute('aria-pressed', 'false');
    b.innerHTML = '';
    parts.forEach((p, i) => { if (i) b.append(' '); b.append(p); });   // spaced, so the text reads as words
    // the accessible name starts with the visible text (WCAG 2.5.3), then says the rest
    const shown = parts.map((p) => p.textContent.trim()).filter(Boolean).join(' ');
    b.setAttribute('aria-label', shown + '. ' + label);
    b.addEventListener('click', () => { show(id); pulse(id); });
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') show(id); });
    nodesEl.append(b);
    nodes[id] = b;
  }
  const span = (cls, t) => el('span', cls, t);
  {
    const sealWrap = document.createElement('span');
    sealWrap.innerHTML = miniSeal();
    node('vault', 'node-vault', [sealWrap.firstChild, span('n-name', 'Vault ' + SHOWCASE), span('n-sub', v6.state)], 'Vault ' + SHOWCASE + ', ' + v6.state + ', ' + near(v6.balance));
    node('near', 'node-chain', [span('n-name', 'NEAR'), span('n-sub', 'step I')], 'NEAR, paid at step I');
    v6.heirs.slice(0, 2).forEach((h, i) => node('h' + i, 'node-rec', [span('n-name', cap(short(h.account_id)) + ' ' + pct(h.bps)), span('n-id', h.account_id)], 'Heir ' + h.account_id + ', ' + pct(h.bps)));
    ['base', 'monad', 'solana'].forEach((c) => {
      const f = v6.foreign.find((p) => p.chain === c);
      if (!f) return;
      node(c, 'node-chain', [span('n-name', CHAIN[c].name), span('n-sub', 'signs at step III')], CHAIN[c].net + ', signed at step III');
      node('r' + c, 'node-rec', [span('n-name', units(f.amount, CHAIN[c].dec) + ' ' + CHAIN[c].unit), span('n-id', mid(f.to))], 'Recipient on ' + CHAIN[c].net + ', ' + units(f.amount, CHAIN[c].dec) + ' ' + CHAIN[c].unit);
    });
  }

  // column names on wide screens
  const cols = el('div', 'graph-cols');
  cols.setAttribute('aria-hidden', 'true');
  [['The vault', 10], ['Pays on', 44], ['To', 81]].forEach(([t, x]) => { const s = el('span', '', t); s.style.left = x + '%'; cols.append(s); });
  graph.insertBefore(cols, nodesEl);

  // ---------- edges ----------
  const NS = 'http://www.w3.org/2000/svg';
  function layout() {
    const wide = graph.clientWidth >= 720;
    const L = wide ? LAYOUT.wide : LAYOUT.narrow;
    const W = graph.clientWidth, H = graph.clientHeight;
    edgesEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
    Object.entries(nodes).forEach(([id, n]) => { const p = L[id]; if (p) { n.style.left = p[0] + '%'; n.style.top = p[1] + '%'; } });
    const P = (id) => [L[id][0] * W / 100, L[id][1] * H / 100];
    cols.hidden = !wide;
    edgesEl.textContent = '';
    edges.length = 0;
    Object.entries(parentOf).forEach(([b, a]) => {
      if (!nodes[a] || !nodes[b]) return;
      const [x1, y1] = P(a), [x2, y2] = P(b);
      let d;
      // phones: one trunk down the chain column, so every route leaves the vault the same way
      if (!wide && a === 'vault') { const ty = y1 + H * 0.17; d = `M${x1},${y1} C${x1},${ty} ${x2},${y1 + H * 0.06} ${x2},${ty} L${x2},${y2}`; }
      else { const dx = (x2 - x1) * 0.55; d = `M${x1},${y1} C${x1 + dx},${y1} ${x2 - dx},${y2} ${x2},${y2}`; }
      const path = document.createElementNS(NS, 'path'); path.setAttribute('class', 'edge'); path.setAttribute('d', d);
      const flow = document.createElementNS(NS, 'path'); flow.setAttribute('class', 'flow'); flow.setAttribute('d', d);
      edgesEl.append(path, flow);
      const len = path.getTotalLength();
      flow.style.strokeDasharray = `28 ${len + 40}`;
      edges.push({ a, b, stage: a === 'vault' ? 0 : 1, path, flow, len });
    });
    show(selected);
  }

  // A heartbeat travels out of the vault along every edge (or along one route when a node is chosen).
  function pulse(to) {
    if (rm) return;
    nodes.vault.classList.remove('is-ping'); void nodes.vault.offsetWidth; nodes.vault.classList.add('is-ping');
    edges.forEach((e) => {
      if (to && to !== 'vault' && !onRoute(to, e)) return;
      e.flow.animate(
        [{ strokeDashoffset: 28, opacity: 0 }, { opacity: 1, offset: 0.12 }, { opacity: 1, offset: 0.8 }, { strokeDashoffset: -e.len, opacity: 0 }],
        { duration: 1300, delay: e.stage * 650, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'none' },
      );
    });
  }

  // ---------- live facts (kept from v3) ----------
  function facts() {
    q('supply').textContent = String(supply);
    q('v6-beat').textContent = ago(v6.last_beat_ms);
    q('v6-beat').title = utc(v6.last_beat_ms);
    q('v6-warn').textContent = v6.state === 'Alive' ? until(v6.warning_at_ms) : utc(v6.warning_at_ms);
    q('v6-int').textContent = every(v6.heartbeat_interval_s);
    const st = q('v17-state');
    st.textContent = v17.state; st.dataset.tone = TONE[v17.state] || '';
    if (v17.state === 'Settled') st.append(' ', el('small', '', 'step ' + Math.min(v17.step, 5) + ' of 5 done'));
    const list = q('v17-steps');
    list.textContent = '';
    v17.log.filter((l) => STEP_LABEL[l.event]).forEach((l) => {
      const [n, label] = STEP_LABEL[l.event];
      const li = el('li');
      li.append(el('span', 'n', n));
      const what = el('span', '', label);
      let d = l.detail;
      if (l.event === 'step_1') d = d.split(', ').map((p) => { const [a, ...r] = p.split(' '); return cap(short(a)) + ' ' + r.join(' '); }).join(', ');
      if (l.event === 'step_3') d = v17.foreign.map((f) => cap(f.chain) + ' ' + f.status).join(', ') + '; none relayed';
      if (l.event === 'step_4' && /no dao/i.test(d)) d = 'No estate DAO set, so skipped';
      if (l.event === 'step_5') d = 'to ' + cap(short(d.replace(/^will nft -> /, '')));
      what.append(el('span', 'd', d + ', ' + utc(l.ms)));
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
  }

  facts();
  layout();
  graph.setAttribute('aria-busy', 'false');
  grid.setAttribute('aria-busy', 'false');

  let visible = false, pulsedOnce = false;
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(([e]) => {
      visible = e.isIntersecting;
      if (visible && !pulsedOnce) { pulsedOnce = true; setTimeout(() => pulse(), 400); }
    }, { threshold: 0.35 }).observe(graph);
  } else { visible = true; pulse(); }

  let rt = 0;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(layout, 150); });

  // Poll vault 6. A new last_beat_ms is a real heartbeat: pulse the graph (and thump, if sound is on).
  setInterval(async () => {
    if (document.hidden || !visible) return;
    try {
      const nv = await view('get_vault', { token_id: SHOWCASE });
      const beat = nv.last_beat_ms !== v6.last_beat_ms;
      v6 = nv;
      facts();
      show(selected);
      if (beat) { pulse(); emit('beat', { source: 'chain' }); }
    } catch (_) { /* keep the last reading */ }
  }, POLL_MS);
}
