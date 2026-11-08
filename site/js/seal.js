// SVG seal helpers: state colour (via DMWPulse), the word in its centre, the rim inscription, its title, and the heir.
const VAULT_RE = /VAULT \d+/;

export function setSeal(seal, state, word) {
  if (!seal) return;
  if (window.DMWPulse) window.DMWPulse.setState(seal, state);
  else seal.setAttribute('data-state', state);
  const w = seal.querySelector('.word');
  if (w) w.textContent = word;
  seal.querySelectorAll('.inscription .state').forEach((t) => { t.textContent = word.toUpperCase(); });
  const title = seal.querySelector('title');
  if (title) title.textContent = title.textContent.replace(/: .*$/, ': ' + word.toLowerCase());
  const no = seal.querySelector('.no');
  if (no) {
    if (!no.dataset.orig) no.dataset.orig = no.textContent;
    no.textContent = state === 'still' && seal.dataset.heirName ? 'TO ' + seal.dataset.heirName.toUpperCase() : no.dataset.orig;
  }
}

// The rim reads: DEAD MAN'S WALLET · VAULT 0042 · ALIVE · FOR MARIA · VAULT 0042 · ALIVE ·
export function setSealHeir(seal, name) {
  if (!seal) return;
  seal.dataset.heirName = name;
  const tp = seal.querySelector('.inscription textPath');
  if (!tp) return;
  const stateWord = (tp.querySelector('.state') || {}).textContent || 'ALIVE';
  const vault = (tp.textContent.match(VAULT_RE) || ['VAULT 0042'])[0];
  const NS = 'http://www.w3.org/2000/svg';
  const st = () => { const t = document.createElementNS(NS, 'tspan'); t.setAttribute('class', 'state'); t.textContent = stateWord; return t; };
  tp.textContent = '';
  tp.append('DEAD MAN’S WALLET · ' + vault + ' · ', st(), ' · FOR ' + name.toUpperCase() + ' · ' + vault + ' · ', st(), ' ·');
  const no = seal.querySelector('.no');
  if (no && seal.getAttribute('data-state') === 'still') no.textContent = 'TO ' + name.toUpperCase();
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export const emit = (name, detail) => window.dispatchEvent(new CustomEvent('dmw:' + name, { detail }));
