// The hero: hold to stop your heartbeat. Runs a client-side simulation of example vault 0042; nothing is sent.
import { setSeal, reducedMotion } from './seal.js';

const HOLD_MS = 1500;
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function fakeHash() {
  const a = new Uint8Array(44);
  crypto.getRandomValues(a);
  const s = Array.from(a, (b) => B58[b % 58]).join('');
  return s.slice(0, 6) + '…' + s.slice(-4);
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
  const seal = document.querySelector('#hero-seal .seal');
  const status = document.getElementById('sim-status');
  const label = btn && btn.querySelector('.hold-label');
  const rows = Array.from(document.querySelectorAll('.sim-rows li'));
  const replay = document.getElementById('replay');
  if (!hero || !btn || !seal) return;

  let holdTimer = 0;
  let timers = [];
  let running = false;

  const say = (text, tone) => { status.textContent = text; status.dataset.tone = tone || ''; };

  function reset() {
    timers.forEach(clearTimeout); timers = [];
    hero.classList.remove('is-sim', 'is-done', 'is-holding');
    rows.forEach((r) => r.classList.remove('on'));
    setSeal(seal, 'alive', 'Alive');
    say('');
    label.textContent = 'Hold to stop your heartbeat';
    running = false;
  }

  function step(kind, arg) {
    switch (kind) {
      case 'warn': setSeal(seal, 'warn', 'Warning'); say('A beat was missed.', 'warn'); break;
      case 'dead': setSeal(seal, 'dead', 'Triggered'); say('This executes.', 'dead'); break;
      case 'row': {
        const r = rows[arg];
        r.querySelector('.sim-hash').textContent = fakeHash();
        r.classList.add('on');
        break;
      }
      case 'still': setSeal(seal, 'still', 'Settled'); say('Settled. Left to Sarah.', 'still'); break;
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
    // Reduced motion: the same steps, slower and without transitions (CSS turns them off).
    const pace = reducedMotion() ? 1.25 : 1;
    SCRIPT.forEach(([t, kind, arg]) => timers.push(setTimeout(() => step(kind, arg), t * pace)));
  }

  function begin() {
    if (running) return;
    if (hero.classList.contains('is-done')) { timers.forEach(clearTimeout); setSeal(seal, 'alive', 'Alive'); say(''); }
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

  // For screenshots and the recorded clip: ?sim=run starts it, ?sim=settled shows the end state.
  const q = new URLSearchParams(location.search).get('sim');
  if (q === 'run') fire();
  if (q === 'settled') { fire(); timers.forEach(clearTimeout); timers = []; SCRIPT.forEach(([, k, a]) => step(k, a)); }
}
