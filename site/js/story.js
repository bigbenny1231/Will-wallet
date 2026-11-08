// Three acts: the pinned seal follows the act in the middle of the screen; act III's strip flatlines into the steps.
import { setSeal } from './seal.js';

export function init() {
  const seal = document.querySelector('.story-seal .seal');
  const acts = Array.from(document.querySelectorAll('.act'));
  const strip = document.getElementById('strip');
  let current = null;
  let settled = false;

  const show = (act) => {
    current = act;
    if (act.classList.contains('act-settle') && settled) setSeal(seal, 'still', 'Settled');
    else setSeal(seal, act.dataset.state, act.dataset.word);
  };

  if (seal && 'IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) show(e.target); });
    }, { rootMargin: '-48% 0px -48% 0px', threshold: 0 });
    acts.forEach((a) => io.observe(a));
  }

  if (strip && window.DMWPulse) {
    window.DMWPulse.watchStrip(strip, {
      rootMargin: '0px 0px -30% 0px',
      onFlat: () => setTimeout(() => {
        settled = true;
        if (current && current.classList.contains('act-settle')) setSeal(seal, 'still', 'Settled');
      }, 2400),
    });
  }
}
