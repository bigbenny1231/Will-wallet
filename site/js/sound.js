// Optional sound, off by default. Synthesized with WebAudio; there are no audio files.
//   dmw:beat      -> a heartbeat: two short low sine bursts ("lub-dub")
//   dmw:flatline  -> one sustained 220 Hz tone with a slow decay
//   dmw:settled   -> silence (any tone still sounding fades out)
let ctx = null;
let master = null;
let tone = null;
let on = false;

function ensure() {
  if (ctx) return ctx;
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return null;
  ctx = new AC();
  master = ctx.createGain();
  master.gain.value = 0.9;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 900;
  master.connect(lp).connect(ctx.destination);
  return ctx;
}

function burst(at, freq, peak) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq, at);
  o.frequency.exponentialRampToValueAtTime(freq * 0.62, at + 0.16);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + 0.2);
  o.connect(g).connect(master);
  o.start(at);
  o.stop(at + 0.24);
}

export function thump(delay = 0) {
  if (!on || !ensure()) return;
  const t = ctx.currentTime + 0.01 + delay;
  burst(t, 72, 0.55);
  burst(t + 0.19, 58, 0.36);
}

export function flatline() {
  if (!on || !ensure()) return;
  silence(0.05);
  const t = ctx.currentTime + 0.02;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = 'sine';
  o.frequency.value = 220;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.04);
  g.gain.setValueAtTime(0.09, t + 1.6);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 6.5);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + 6.6);
  tone = { o, g };
  o.onended = () => { if (tone && tone.o === o) tone = null; };
}

export function silence(fade = 0.8) {
  if (!ctx || !tone) return;
  const t = ctx.currentTime;
  tone.g.gain.cancelScheduledValues(t);
  tone.g.gain.setValueAtTime(Math.max(tone.g.gain.value, 0.0001), t);
  tone.g.gain.exponentialRampToValueAtTime(0.0001, t + fade);
  tone.o.stop(t + fade + 0.05);
  tone = null;
}

export function setOn(v) {
  on = !!v;
  if (on) { if (ensure() && ctx.state === 'suspended') ctx.resume(); }
  else { silence(0.2); if (ctx) ctx.suspend(); }
  return on;
}

export const isOn = () => on;

let wired = false;
export function wire() {
  if (wired) return;
  wired = true;
  window.addEventListener('dmw:beat', (e) => thump((e.detail && e.detail.delay) || 0));
  window.addEventListener('dmw:flatline', () => flatline());
  window.addEventListener('dmw:settled', () => silence(1.6));
}
