// Dead Man's Wallet landing page. Vanilla ES modules, no dependencies besides assets/pulse.js (window.DMWPulse).
// No backend: links are plain, the live strip makes read-only RPC calls, the quiz never leaves the page.
import { initHero } from './hero.js';

export const CONFIG = {
  DASHBOARD_URL: 'https://will-wallet.vercel.app',  // deployed separately; see dashboard/README.md
  SITE_URL: 'https://will-wallet-site.vercel.app',
  GITHUB_URL: 'https://github.com/bigbenny1231/will-wallet',
};

const links = {
  dashboard: CONFIG.DASHBOARD_URL,
  heir: CONFIG.DASHBOARD_URL + '/heir',
  vault6: CONFIG.DASHBOARD_URL + '/vault/6',
  github: CONFIG.GITHUB_URL,
};
document.querySelectorAll('[data-link]').forEach((a) => {
  const u = links[a.getAttribute('data-link')];
  if (u) a.setAttribute('href', u);
});

initHero();

// Below the fold: load each part when it comes near the viewport.
const lazy = [
  ['#how', () => import('./story.js')],
  ['#live', () => import('./live.js')],
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
  }, { rootMargin: '600px 0px' });
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
