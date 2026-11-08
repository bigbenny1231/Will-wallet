// The hero: hold to stop your heartbeat. Runs a client-side simulation of example vault 0042; nothing is sent.
// The heir's name is typed by the visitor, kept in localStorage, and used by the seal, the ledger and the last line.
import { reducedMotion, emit } from './seal.js';
import { createHeroSeal } from './sealhost.js';

const HOLD_MS = 1500;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const KEY = 'dmw-heir';
const DEFAULT_HEIR = 'Sarah';

function fakeHash() {
  const a = new Uint8Array(44);
  crypto.getRandomValues(a);
  const s = Array.from(a, (b) => B58[b % 58]).join('');
  return s.slice(0, 6) + '…' + s.slice(-4);
}

export function cleanName(v) {
  return String(v || '').replace(/[^\p{L}\p{M} '’.-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 18);
}

// Times in ms after the hold completes. Calm: about eleven seconds end to end.
const SCRIPT = [
  [0, 'warn'],
  [2600, 'dead'],
  [4000, 'row', 0],
  [5200, 'row', 1],
  [6400, 'row', 2],
  [7600, 'row', 3],
  [8800, 'row', 4],
  [10200, 'still'],
  [11000, 'done'],
];

export function initHero() {
  const hero = document.querySelector('.hero');
  const btn = document.getElementById('hold');
  const wrap = document.getElementById('hero-seal');
  const status = document.getElementById('sim-status');
  const label = btn && btn.querySelector('.hold-label');
  const rows = Array.from(document.querySelectorAll('.sim-rows li'));
  const replay = document.getElementById('replay');
  const input = document.getElementById('heir-name');
  if (!hero || !btn || !wrap) return null;

  const seal = createHeroSeal(wrap, '0042');
  let holdTimer = 0;
  let timers = [];
  let running = false;
  let heir = DEFAULT_HEIR;

  const say = (text, tone) => { status.textContent = text; status.dataset.tone = tone || ''; };

  // ---- the heir's name ----
  function applyHeir(raw) {
    heir = cleanName(raw) || DEFAULT_HEIR;
    const second = heir.toLowerCase() === 'ben' ? 'Sarah' : 'Ben';
    document.querySelectorAll('[data-heir]').forEach((n) => { n.textContent = heir; });
    document.querySelectorAll('[data-heir2]').forEach((n) => { n.textContent = second; });
    seal.setHeir(heir);
    if (hero.classList.contains('is-done')) say('Settled. Left to ' + heir + '.', 'still');
  }
  let stored = '';
  try { stored = localStorage.getItem(KEY) || ''; } catch (_) { /* storage blocked */ }
  const q = new URLSearchParams(location.search);
  if (q.get('heir')) stored = q.get('heir');
  if (input) {
    input.value = cleanName(stored);
    input.addEventListener('input', () => {
      applyHeir(input.value);
      try { const v = cleanName(input.value); if (v) localStorage.setItem(KEY, v); else localStorage.removeItem(KEY); } catch (_) { /* ignore */ }
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); btn.focus(); } });
  }
  applyHeir(stored);

  function reset() {
    timers.forEach(clearTimeout); timers = [];
    hero.classList.remove('is-sim', 'is-done', 'is-holding');
    rows.forEach((r) => r.classList.remove('on'));
    seal.setState('alive', 'Alive');
    say('');
    label.textContent = 'Hold to stop your heartbeat';
    running = false;
  }

  function step(kind, arg) {
    switch (kind) {
      case 'warn': seal.setState('warn', 'Warning'); say('A beat was missed.', 'warn'); break;
      case 'dead': seal.setState('dead', 'Triggered'); say('This executes.', 'dead'); emit('flatline', { source: 'hero' }); break;
      case 'row': {
        const r = rows[arg];
        r.querySelector('.sim-hash').textContent = fakeHash();
        r.classList.add('on');
        break;
      }
      case 'still': seal.setState('still', 'Settled'); say('Settled. Left to ' + heir + '.', 'still'); emit('settled', { source: 'hero' }); break;
      case 'done':
        hero.classList.remove('is-sim'); hero.classList.add('is-done');
        label.textContent = 'Hold to run it again';
        running = false;
        break;
    }
  }

  function fire() {
    clearTimeout(holdTimer);
    if (running) return;
    running = true;
    hero.classList.remove('is-holding', 'is-done');
    rows.forEach((r) => r.classList.remove('on'));
    hero.classList.add('is-sim');
    label.textContent = 'Simulation running';
    const pace = reducedMotion() ? 1.25 : 1;
    SCRIPT.forEach(([t, kind, arg]) => timers.push(setTimeout(() => step(kind, arg), t * pace)));
  }

  function begin() {
    if (running) return;
    if (hero.classList.contains('is-done')) { timers.forEach(clearTimeout); seal.setState('alive', 'Alive'); say(''); }
    hero.classList.add('is-holding');
    clearTimeout(holdTimer);
    holdTimer = setTimeout(fire, HOLD_MS);
  }
  function cancel() {
    if (!hero.classList.contains('is-holding')) return;
    clearTimeout(holdTimer);
    hero.classList.remove('is-holding');
  }

  btn.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    try { btn.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
    begin();
  });
  ['pointerup', 'pointercancel', 'lostpointercapture'].forEach((ev) => btn.addEventListener(ev, cancel));
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
  btn.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); if (!e.repeat) begin(); }
    else if (e.key === 'Enter') { e.preventDefault(); if (!running) { if (hero.classList.contains('is-done')) reset(); fire(); } }
  });
  btn.addEventListener('keyup', (e) => { if (e.key === ' ' || e.code === 'Space') { e.preventDefault(); cancel(); } });
  btn.addEventListener('click', (e) => e.preventDefault());
  btn.addEventListener('blur', cancel);
  replay.addEventListener('click', () => { reset(); fire(); });

  // Each loop of the seal's beat animation is one heartbeat: drive the 3D seal and the optional sound from it.
  let heroVisible = true;
  if ('IntersectionObserver' in window) new IntersectionObserver(([e]) => { heroVisible = e.isIntersecting; }).observe(hero);
  const glow = seal.svg && seal.svg.querySelector('.glow');
  if (glow) {
    glow.addEventListener('animationiteration', () => {
      const st = seal.svg.getAttribute('data-state') || 'alive';
      if (st !== 'alive' && st !== 'warn') return;
      seal.beat();
      if (heroVisible) emit('beat', { source: 'hero', delay: 0.62 });
    });
  }

  // For screenshots and the recorded clip: ?sim=run starts it, ?sim=settled shows the end state.
  const sim = q.get('sim');
  if (sim === 'run') fire();
  if (sim === 'settled') { fire(); timers.forEach(clearTimeout); timers = []; SCRIPT.forEach(([, k, a]) => step(k, a)); }

  return seal;
}
