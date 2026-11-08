// Set a seal's state: colour (via DMWPulse), the word in its centre, the rim inscription and its title.
export function setSeal(seal, state, word) {
  if (!seal) return;
  if (window.DMWPulse) window.DMWPulse.setState(seal, state);
  else seal.setAttribute('data-state', state);
  const w = seal.querySelector('.word');
  if (w) w.textContent = word;
  seal.querySelectorAll('.inscription .state').forEach((t) => { t.textContent = word.toUpperCase(); });
  const title = seal.querySelector('title');
  if (title) title.textContent = title.textContent.replace(/: .*$/, ': ' + word.toLowerCase());
}

export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
