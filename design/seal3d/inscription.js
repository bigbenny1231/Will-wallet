// Pure text helpers shared by the 3D seal and its node tests (no DOM, no three.js).

const WORDS = { alive: 'Alive', warning: 'Warning', triggered: 'Triggered', settled: 'Settled' };
const ALIASES = { warn: 'warning', dead: 'triggered', still: 'settled', live: 'alive' };

// Canonical state name. Accepts the site's short names (warn / dead / still) too.
export function normState(state) {
  const s = String(state || '').toLowerCase().trim();
  if (WORDS[s]) return s;
  if (ALIASES[s]) return ALIASES[s];
  return 'alive';
}

export function stateWord(state) {
  return WORDS[normState(state)];
}

// Vault numbers are shown as four digits when numeric ("42" -> "0042"), otherwise upper-cased and trimmed.
export function vaultLabel(vaultNo) {
  const v = String(vaultNo == null ? '0042' : vaultNo).trim();
  if (/^\d+$/.test(v)) return v.padStart(4, '0').slice(-8);
  return v.toUpperCase().replace(/[^A-Z0-9 \-]/g, '').slice(0, 10) || '0042';
}

// One pass of the rim inscription, exactly as on the 2D seal: LASTWORD · VAULT 0042 · ALIVE
export function inscriptionText(state, vaultNo) {
  return `LASTWORD · VAULT ${vaultLabel(vaultNo)} · ${stateWord(state).toUpperCase()}`;
}

// The rim carries the inscription twice, each pass closed with a middle dot, like the SVG textPath.
export function inscriptionRing(state, vaultNo) {
  const one = inscriptionText(state, vaultNo);
  return `${one} · ${one} ·`;
}

// Heir names are shown in small caps under the state word; keep them short and printable.
export function heirLabel(name) {
  const n = String(name || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 28);
  return n ? n.toUpperCase() : '';
}
