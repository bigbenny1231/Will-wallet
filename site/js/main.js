// Dead Man's Wallet landing page, v4. Vanilla ES modules, no dependencies besides assets/pulse.js (window.DMWPulse).
// No backend: links are plain, the estate graph makes read-only RPC calls, the heir name and quiz never leave the page.
import { initHero } from './hero.js';
import { reducedMotion } from './seal.js';

export const CONFIG = {
  DASHBOARD_URL: 'https://will-wallet.vercel.app',  // deployed separately; see dashboard/README.md
  SITE_URL: 'https://will-wallet-site.vercel.app',
  GITHUB_URL: 'https://github.com/bigbenny1231/will-wallet',
};

const links = {
  dashboard: CONFIG.DASHBOARD_URL,
  heir: CONFIG.DASHBOARD_URL + '/heir',
  try: CONFIG.DASHBOARD_URL + '/try',
  vault6: CONFIG.DASHBOARD_URL + '/vault/6',
  github: CONFIG.GITHUB_URL,
};
document.querySelectorAll('[data-link]').forEach((a) => {
  const u = links[a.getAttribute('data-link')];
  if (u) a.setAttribute('href', u);
});

const rm = reducedMotion();
const heroSeal = initHero();

// The WebGL seal (about 140 KB gzipped) loads on the visitor's first interaction (pointer, touch, key, scroll),
// never during first paint; until then, and wherever WebGL is missing, the SVG seal is the seal.
if (heroSeal) {
  const evs = ['pointermove', 'pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'];
  const go = () => {
    evs.forEach((e) => window.removeEventListener(e, go));
    const idle = window.requestIdleCallback || ((f) => setTimeout(f, 200));
    idle(() => heroSeal.load3D(), { timeout: 1200 });
  };
  evs.forEach((e) => window.addEventListener(e, go, { passive: true }));
  if (new URLSearchParams(location.search).has('seal3d')) go();
}

// A soft light that follows the pointer over the ink. Transform only; desktop, motion allowed.
const light = document.querySelector('.light');
if (light && !rm && matchMedia('(hover: hover) and (pointer: fine)').matches) {
  let x = 0, y = 0, raf = 0;
  window.addEventListener('pointermove', (e) => {
    x = e.clientX; y = e.clientY;
    if (!raf) raf = requestAnimationFrame(() => { raf = 0; light.style.transform = `translate3d(${x}px, ${y}px, 0)`; light.classList.add('is-on'); });
  }, { passive: true });
  document.documentElement.addEventListener('pointerleave', () => light.classList.remove('is-on'));
}

// Nav: transparent on landing, a strip once the hero starts to leave.
const navEl = document.getElementById('nav');
if (navEl) {
  let navRaf = 0;
  const setNav = () => { navRaf = 0; navEl.classList.toggle('is-scrolled', (window.scrollY || 0) > 24); };
  addEventListener('scroll', () => { if (!navRaf) navRaf = requestAnimationFrame(setNav); }, { passive: true });
  setNav();
}

// Sound: off by default, loaded on the first tap. No sound with reduced motion.
const soundBtn = document.getElementById('sound');
if (soundBtn) {
  if (rm || !(window.AudioContext || window.webkitAudioContext)) document.documentElement.classList.add('no-audio');
  soundBtn.addEventListener('click', async () => {
    const s = await import('./sound.js');
    s.wire();
    const on = s.setOn(!s.isOn());
    soundBtn.setAttribute('aria-pressed', String(on));
    soundBtn.querySelector('.sound-label').textContent = on ? 'Sound: on' : 'Sound: off';
    soundBtn.setAttribute('aria-label', on ? 'Sound: on' : 'Sound: off');
    if (on) s.thump();
  });
}

// Below the fold: load each part when it comes near the viewport.
const lazy = [
  ['#how', () => import('./story.js')],
  ['#live', () => import('./graph.js')],
  ['#would-it-arrive', () => import('./quiz.js')],
];
const start = (load) => load().then((m) => m.init()).catch((e) => console.warn('module failed', e));
if ('IntersectionObserver' in window) {
  const io = new IntersectionObserver((entries) => {
    entries.forEach((e) => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      start(e.target.__load);
    });
  }, { rootMargin: '900px 0px' });
  lazy.forEach(([sel, load]) => { const el = document.querySelector(sel); if (el) { el.__load = load; io.observe(el); } });
} else {
  lazy.forEach(([, load]) => start(load));
}

// Demo player: a quiet overlay until the visitor asks for it, then native controls.
const video = document.getElementById('demo-video');
const play = document.querySelector('.play');
if (video && play) {
  play.addEventListener('click', () => {
    video.controls = true;
    video.closest('.player').classList.add('is-playing');
    const p = video.play();
    if (p && p.catch) p.catch(() => { /* source missing or blocked: controls stay visible */ });
    video.focus();
  });
}

// ?debug=1 — on-screen diagnostics so a phone screenshot tells us what the device is actually doing.
if (location.search.includes('debug')) {
  const show = () => {
    const q = s => document.querySelector(s);
    const r = s => { const e = q(s); if (!e) return 'none'; const b = e.getBoundingClientRect(); return `${Math.round(b.width)}x${Math.round(b.height)} @${Math.round(b.left)},${Math.round(b.top)}`; };
    const css = [...document.styleSheets].map(s => (s.href || 'inline').replace(location.origin, '')).join(' | ');
    const brand = q('.brand');
    const cs = brand ? getComputedStyle(brand) : null;
    const lines = [
      'UA ' + navigator.userAgent,
      `viewport ${innerWidth}x${innerHeight} dpr ${devicePixelRatio} docW ${document.documentElement.scrollWidth} zoom ${(visualViewport ? visualViewport.scale : 1).toFixed(2)}`,
      'css ' + css,
      'brand ' + r('.brand') + ' font ' + (cs ? cs.fontSize + ' ' + cs.fontFamily.split(',')[0] + ' ws=' + cs.whiteSpace + ' disp=' + cs.display : ''),
      'mark ' + r('.brand .mark') + ' span ' + r('.brand span') + ' sound ' + r('.sound-toggle') + ' nav ' + r('.nav-inner'),
      'markCS ' + (q('.brand .mark') ? getComputedStyle(q('.brand .mark')).width + '/' + getComputedStyle(q('.brand .mark')).height : ''),
      'html font-size ' + getComputedStyle(document.documentElement).fontSize + ' body ' + getComputedStyle(document.body).fontSize,
    ];
    let box = q('#dmw-debug');
    if (!box) { box = document.createElement('pre'); box.id = 'dmw-debug'; document.body.appendChild(box); }
    box.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;margin:0;padding:8px;background:#000;color:#3DDC84;font:11px/1.35 monospace;white-space:pre-wrap;word-break:break-all;max-height:60vh;overflow:auto';
    box.textContent = lines.join('\n');
  };
  show(); setTimeout(show, 1500); addEventListener('resize', show);
}
