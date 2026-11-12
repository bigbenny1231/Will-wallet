// Scrolling is time: the run of vault 4 (dmw-885364.testnet) as one vertical ECG line, drawn as the reader descends.
// Every event is a real moment of vault 4's recorded run (keeper log, agent transcript, docs/video/README.md); events are spaced by the
// time between them, the heartbeats ARE the beats on the trace, and the clock shows the time at the pen.
import { setSeal, reducedMotion, emit } from './seal.js';

const PEN_AT = 0.62;          // the pen sits at 62% of the viewport height
const SMOOTH_MS = 110;        // easing time constant toward the scroll position
const STATE_WORD = { alive: 'Alive', warn: 'Warning', dead: 'Triggered', still: 'Settled' };
const PHASE_OF = { alive: 'alive', silence: 'silence', settle: 'dead' };

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const hms = (ms) => new Date(ms).toISOString().slice(11, 19);

// One ECG complex, vertical: the trace runs down at x=X and the R wave kicks to the right.
function vComplex(y0, X, s) {
  const d = window.DMWPulse.complex(y0, 0, s);
  return d.replace(/^M/, 'L').replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, a, b) => (X - Number(b)).toFixed(2) + ',' + Number(a).toFixed(2));
}

// The complex as points relative to its start (x to the right of the line, y down), sampled once per scale.
const TPL = {};
function template(s) {
  if (TPL[s]) return TPL[s];
  const NS = 'http://www.w3.org/2000/svg';
  const tmp = document.createElementNS(NS, 'svg');
  tmp.setAttribute('width', 0); tmp.setAttribute('height', 0); tmp.style.position = 'absolute';
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', vComplex(0, 0, s).replace(/^L/, 'M'));
  tmp.append(p); document.body.append(tmp);
  const L = p.getTotalLength(), n = 96, out = [];
  for (let k = 0; k <= n; k++) { const q = p.getPointAtLength((L * k) / n); out.push([q.x, q.y]); }
  tmp.remove();
  return (TPL[s] = out);
}

function splitLetters(h) {
  const text = h.textContent;
  h.textContent = '';
  const sr = document.createElement('span');
  sr.className = 'sr-only';
  sr.textContent = text;
  const vis = document.createElement('span');
  vis.setAttribute('aria-hidden', 'true');
  [...text].forEach((c, i) => {
    const s = document.createElement('span');
    s.className = 'ch' + (c === ' ' ? ' sp' : '');
    s.style.setProperty('--i', i);
    s.textContent = c === ' ' ? ' ' : c;
    vis.append(s);
  });
  h.append(sr, vis);
  return [...vis.children];
}

export function init() {
  const track = document.getElementById('track');
  const svg = document.getElementById('spine');
  const section = document.getElementById('how');
  if (!track || !svg || !window.DMWPulse) return;
  const evs = [...track.querySelectorAll('.ev')];
  const clock = document.querySelector('.story-clock');
  const clockSeal = clock && clock.querySelector('.seal');
  const wordEl = clock && clock.querySelector('[data-clock="word"]');
  const timeEl = clock && clock.querySelector('[data-clock="time"]');
  const rm = reducedMotion();
  const root = document.documentElement;

  // ---- kinetic act titles ----
  const kins = {};
  track.querySelectorAll('.kin').forEach((h) => { kins[h.dataset.kin] = { h, letters: splitLetters(h), on: false }; });
  // "II. Silence": only the word flattens into the line; the numeral stays
  if (kins.silence) {
    const ls = kins.silence.letters;
    const start = ls.findIndex((c) => c.textContent === 'S');
    const word = document.createElement('span');
    word.className = 'kin-word';
    ls[start].before(word);
    ls.slice(start).forEach((c) => word.append(c));
    kins.silence.letters = ls.slice(start);
  }

  // ---- space the events by the time between them ----
  function setGaps() {
    const narrow = innerWidth < 960;
    const s = narrow ? 0.55 : 0.75;
    let phase = 'alive';
    evs.forEach((li, i) => {
      if (li.dataset.phase) phase = li.dataset.phase;
      if (i === 0) { li.style.setProperty('--gap', '0px'); return; }
      const dt = (Number(li.dataset.t) - Number(evs[i - 1].dataset.t)) / 1000;
      let gap;
      if (li.classList.contains('ev-act')) gap = narrow ? 56 : 120;
      else if (phase === 'silence') gap = clamp(dt * (narrow ? 2.4 : 3.6), 24, narrow ? 220 : 320);
      else if (phase === 'settle') gap = clamp(dt * (narrow ? 1.6 : 2.2), 18, 110);
      else gap = clamp(dt * (narrow ? 1.5 : 2.1), 10, 90);
      // a beat needs room for the complex drawn above its mark
      if (li.classList.contains('ev-beat')) gap = Math.max(gap, 100 * s + 18 - 26);
      if (li.classList.contains('ev-end')) gap = narrow ? 64 : 120;
      li.style.setProperty('--gap', gap.toFixed(0) + 'px');
    });
  }

  // ---- geometry ----
  let H = 0, X = 18, S = 0.55;
  let segs = [];           // { path, y0, y1, L, ys:[], ls:[] }
  let anchors = [];        // per event: y on the line
  let pen, penGlow;
  let marks = { lastBeat: 0, trigger: 0, end: 0 };

  function build() {
    const narrow = innerWidth < 960;
    X = narrow ? 18 : 36;
    S = narrow ? 0.55 : 0.75;
    track.style.setProperty('--x', X + 'px');
    H = track.offsetHeight;
    svg.setAttribute('viewBox', `0 0 72 ${H}`);
    svg.setAttribute('width', 72);
    svg.setAttribute('height', H);

    anchors = evs.map((li) => {
      const fs = parseFloat(getComputedStyle(li).fontSize) || 16;
      if (li.classList.contains('ev-act')) return li.offsetTop + 30;
      if (li.classList.contains('ev-end')) return li.offsetTop + 24;
      return li.offsetTop + fs * 0.62 + 4;
    });
    const beatIdx = evs.map((li, i) => (li.classList.contains('ev-beat') ? i : -1)).filter((i) => i >= 0);
    const iTrig = evs.findIndex((li) => li.classList.contains('ev-trigger'));
    const iEnd = evs.length - 1;
    const yStart = 0;
    const yLast = anchors[beatIdx[beatIdx.length - 1]] + 2;
    const yTrig = anchors[iTrig];
    const yEnd = anchors[iEnd] - 34;
    marks = { lastBeat: yLast, trigger: yTrig, end: yEnd, start: anchors[0] };

    // The line is built as polylines (the ECG complex is sampled once into a template), so the length lookup
    // and the pen position are plain arithmetic: no getPointAtLength in the scroll loop or in the build.
    const tpl = template(S);
    const alive = [[X, yStart]];
    beatIdx.forEach((i) => {
      const y0 = anchors[i] - 9 - 100 * S;
      alive.push([X, y0]);
      tpl.forEach(([dx, dy]) => alive.push([X + dx, y0 + dy]));
    });
    alive.push([X, yLast]);

    // silence: the trace thins and stutters, then lies down
    const silence = [[X, yLast]];
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const span = yTrig - yLast;
    for (let y = yLast + 10; y < yTrig - 6; y += 9) {
      const k = 1 - (y - yLast) / span;
      silence.push([X + (rnd() - 0.5) * 2 * (k * k) * 5.5, y]);
    }
    silence.push([X, yTrig]);

    // settlement: the flat line, which becomes the timeline the five steps tick onto
    const settle = [[X, yTrig], [X, yEnd]];

    svg.textContent = '';
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs) => { const n = document.createElementNS(NS, tag); Object.entries(attrs).forEach(([k, v]) => n.setAttribute(k, v)); svg.append(n); return n; };
    const dOf = (pts) => 'M' + pts.map(([x, y]) => x.toFixed(2) + ',' + y.toFixed(2)).join('L');
    mk('path', { class: 'ghost', d: dOf(alive.concat(silence, settle)) });
    segs = [['ink-alive', alive, yStart, yLast], ['ink-silence', silence, yLast, yTrig], ['ink-settle', settle, yTrig, yEnd]].map(([cls, pts, y0, y1]) => {
      const path = mk('path', { class: cls, d: dOf(pts) });
      const ls = [0];
      for (let k = 1; k < pts.length; k++) ls.push(ls[k - 1] + Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]));
      const ys = pts.map((p) => p[1]);
      for (let k = 1; k < ys.length; k++) ys[k] = Math.max(ys[k], ys[k - 1]);   // monotonic for the lookup
      const L = ls[ls.length - 1];
      path.style.strokeDasharray = `${L + 1} ${L + 1}`;
      path.style.strokeDashoffset = String(L + 1);
      return { path, pts, y0, y1, L, ys, ls };
    });
    // minute marks along the line: time made visible (labels on desktop only)
    const T = evs.map((li) => Number(li.dataset.t));
    const yAt = (t) => { let i = 0; while (i < T.length - 2 && T[i + 1] <= t) i++; return anchors[i] + ((t - T[i]) / Math.max(1, T[i + 1] - T[i])) * (anchors[i + 1] - anchors[i]); };
    for (let m = Math.ceil(T[0] / 60000) * 60000; m <= T[T.length - 1]; m += 60000) {
      const y = yAt(m);
      mk('path', { class: 'minute', d: `M${X - 14},${y.toFixed(1)}H${X - 6}` });
      if (!narrow) { const tx = mk('text', { class: 'minute-l', x: X - 19, y: (y + 3.5).toFixed(1), 'text-anchor': 'end' }); tx.textContent = hms(m).slice(0, 5); }
    }
    penGlow = mk('circle', { class: 'pen-glow', r: 9, cx: X, cy: -40 });
    pen = mk('circle', { class: 'pen', r: 2.6, cx: X, cy: -40 });
    lastDrawn = -1;
  }

  // index + fraction of the polyline point at height y
  function at(seg, y) {
    const { ys } = seg;
    if (y <= ys[0]) return [0, 0];
    if (y >= ys[ys.length - 1]) return [ys.length - 2, 1];
    let lo = 0, hi = ys.length - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (ys[m] < y) lo = m; else hi = m; }
    return [lo, ys[hi] === ys[lo] ? 0 : (y - ys[lo]) / (ys[hi] - ys[lo])];
  }

  // ---- state ----
  let drawn = rm ? 1e9 : -200;
  let target = drawn;
  let lastDrawn = -1;
  let curState = '', curPhase = '', curTime = '';
  let passed = evs.map(() => false);

  function render(y) {
    // the line
    let active = null;
    segs.forEach((seg) => {
      const [i, f] = at(seg, y);
      const l = seg.ls[i] + f * (seg.ls[i + 1] - seg.ls[i]);
      seg.path.style.strokeDashoffset = String(seg.L + 1 - l);
      if (y > seg.y0 && y <= seg.y1 + 0.5) active = { seg, i, f };
    });
    if (active && !rm) {
      const a = active.seg.pts[active.i], b = active.seg.pts[active.i + 1];
      const px = (a[0] + (b[0] - a[0]) * active.f).toFixed(2), py = (a[1] + (b[1] - a[1]) * active.f).toFixed(2);
      pen.setAttribute('cx', px); pen.setAttribute('cy', py);
      penGlow.setAttribute('cx', px); penGlow.setAttribute('cy', py);
      pen.style.opacity = penGlow.style.opacity = '';
    } else { pen.style.opacity = penGlow.style.opacity = '0'; }

    // events, crossings, state
    let state = 'alive', phase = 'alive', beats = 0, flat = false, settled = false;
    evs.forEach((li, i) => {
      const isPast = anchors[i] <= y + 1;
      if (isPast !== passed[i]) {
        li.classList.toggle('is-past', isPast);
        if (isPast && !rm && lastDrawn >= 0) {
          if (li.classList.contains('ev-beat')) beats++;
          if (li.classList.contains('ev-trigger')) flat = true;
          if (li.classList.contains('ev-final')) settled = true;
        }
        passed[i] = isPast;
      }
      if (isPast) {
        if (li.dataset.state) state = li.dataset.state;
        if (li.dataset.phase) phase = li.dataset.phase;
      }
    });
    if (state === 'dead') phase = 'settle';
    let page = PHASE_OF[phase];
    if (state === 'still') page = 'ash';
    if (beats) { emit('beat', { source: 'story' }); if (clockSeal) window.DMWPulse.beat(clockSeal); }
    if (flat) emit('flatline', { source: 'story' });
    if (settled) emit('settled', { source: 'story' });

    // kinetic titles
    const kA = kins.alive, kS = kins.silence, kT = kins.settle;
    const iA = evs.indexOf(kA && kA.h.closest('.ev'));
    const iS = evs.indexOf(kS && kS.h.closest('.ev'));
    const iT = evs.indexOf(kT && kT.h.closest('.ev'));
    if (kA && !kA.on && y > anchors[iA] + 40) { kA.on = true; kA.h.classList.add('is-on'); }
    if (kT && !kT.on && y > anchors[iT] + 20) { kT.on = true; kT.h.classList.add('is-on'); }
    if (kS && !rm) {
      const f = clamp((y - anchors[iS] - 120) / 420, 0, 1);
      if (f !== kS.f) {
        kS.f = f;
        kS.h.style.setProperty('--flat', f.toFixed(3));
        const n = kS.letters.length;
        kS.letters.forEach((c, i) => {
          const local = clamp(f * 1.7 - (i / n) * 0.7, 0, 1);
          c.style.transform = local ? `scaleY(${(1 - local * 0.93).toFixed(3)})` : '';
        });
      }
    }

    // clock: interpolate the real times between the marks around the pen
    if (timeEl) {
      let t;
      if (y <= anchors[0]) t = Number(evs[0].dataset.t);
      else if (y >= anchors[anchors.length - 1]) t = Number(evs[evs.length - 1].dataset.t);
      else {
        let i = 0;
        while (i < anchors.length - 2 && anchors[i + 1] <= y) i++;
        const f = (y - anchors[i]) / Math.max(1, anchors[i + 1] - anchors[i]);
        t = Number(evs[i].dataset.t) + f * (Number(evs[i + 1].dataset.t) - Number(evs[i].dataset.t));
      }
      const txt = hms(t);
      if (txt !== curTime) { timeEl.textContent = txt; curTime = txt; }
    }
    if (state !== curState) {
      curState = state;
      if (clockSeal) setSeal(clockSeal, state, STATE_WORD[state]);
      if (wordEl) wordEl.textContent = STATE_WORD[state];
      if (clock) clock.dataset.state = state;
      svg.dataset.state = state;
      svg.classList.toggle('is-settled', state === 'still');
    }
    // the page background follows the run while the reader is inside it
    if (!rm) {
      const inside = y > marks.start - 120 && y < H + 160;
      const want = inside ? page : 'none';
      if (want !== curPhase) { curPhase = want; root.dataset.phase = want; }
    }
    lastDrawn = y;
  }

  // ---- loop ----
  let raf = 0, visible = false, trackTop = 0;
  const measure = () => { trackTop = track.getBoundingClientRect().top + scrollY; };
  const targetY = () => scrollY + innerHeight * PEN_AT - trackTop;
  let lastT = 0;
  function frame(now) {
    raf = 0;
    target = targetY();
    const dt = lastT ? Math.min(100, now - lastT) : 16;
    lastT = now;
    // time-based easing (same feel at any frame rate), and the pen never trails by more than a third of a screen
    let next = drawn + (target - drawn) * (1 - Math.exp(-dt / SMOOTH_MS));
    const lag = innerHeight * 0.33;
    if (target - next > lag) next = target - lag;
    if (next - target > lag) next = target + lag;
    drawn = next;
    if (Math.abs(target - drawn) < 0.4) drawn = target;
    render(drawn);
    if (drawn !== target) raf = requestAnimationFrame(frame); else lastT = 0;
  }
  const kick = () => { if (!raf && visible) raf = requestAnimationFrame(frame); };

  function rebuild() {
    setGaps();
    // gaps change layout: measure after the browser applies them
    requestAnimationFrame(() => {
      build(); measure();
      passed = evs.map(() => null);
      curState = ''; curTime = '';
      if (rm) render(1e9); else { drawn = targetY(); render(drawn); }
    });
  }

  if (rm) {
    root.dataset.phase = 'none';
  }
  (document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()).then(() => {
    rebuild();
    if (rm) return;
    window.addEventListener('scroll', kick, { passive: true });
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(([e]) => {
        visible = e.isIntersecting;
        if (visible) { measure(); kick(); }
        else if (curPhase !== 'none') { curPhase = 'none'; root.dataset.phase = 'none'; }
      }, { rootMargin: '200px 0px' }).observe(section);
    } else { visible = true; }
  });
  let rt = 0, lastW = innerWidth;
  window.addEventListener('resize', () => {
    if (Math.abs(innerWidth - lastW) < 2) { measure(); return; } // mobile URL bar: height only
    lastW = innerWidth;
    clearTimeout(rt); rt = setTimeout(rebuild, 180);
  });
}
