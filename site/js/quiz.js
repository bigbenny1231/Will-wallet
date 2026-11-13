// Would your crypto arrive? Four single-tap questions, scored here in the page. Nothing is sent anywhere.
// The verdict is also drawn as a 1200x630 card on a canvas, in the house style, for "Download card".
const SITE = 'https://lastwordvault.vercel.app/#would-it-arrive';

// How likely heirs are to find and move a wallet, by where its keys live and what they were told.
const FIND = { hardware: 0.25, paper: 0.45, exchange: 0.7, head: 0 };
const TOLD = { written: 0.5, exists: 0.15, none: 0 };

const KEYS_LINE = {
  hardware: 'A hardware wallet keeps thieves out, and heirs too, unless they have its PIN and recovery phrase.',
  paper: 'A seed phrase on paper works if someone finds it and knows what it is.',
  exchange: 'Exchanges have estate processes. Expect paperwork with each one.',
  head: 'Keys that live only in your memory leave with you.',
};
const TOLD_LINE = {
  written: 'Written steps are the single biggest help you can leave.',
  exists: 'Knowing a wallet exists is a start. Knowing where, and how, is what moves it.',
  none: 'If no one knows, no one will look.',
};
const AGENT_LINE = {
  no: '',
  limits: 'An agent with limits keeps paying within them until someone stops it.',
  full: 'An agent holding a full key can keep acting after you, with nothing to stop it.',
};

const C = { ink: '#0B0C0F', bone: '#EDE7DC', bone2: '#A9A399', brass: '#C8A96A', hair: 'rgba(237,231,220,0.14)', life: '#3DDC84', warn: '#F5B942', still: '#7A7F87' };

function score(a) {
  const wallets = Number(a.chains);
  const p = a.keys === 'head' ? 0 : Math.min(1, FIND[a.keys] + TOLD[a.know]);
  const found = Math.max(0, Math.min(wallets, Math.round(wallets * p)));
  return { wallets, found };
}

function headline({ wallets, found }) {
  if (wallets === 1) return found ? 'Your wallet would likely be found.' : 'Your wallet would likely not be found.';
  return found + ' of ' + wallets + ' wallets would likely be found.';
}

function wrap(ctx, text, maxW) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  words.forEach((w) => {
    const t = line ? line + ' ' + w : w;
    if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t;
  });
  if (line) lines.push(line);
  return lines;
}

// The card: ink, grain, the seal coloured by the verdict, the headline in Instrument Serif, the site.
async function drawCard(canvas, s, lines) {
  try { await Promise.all(['400 72px "Instrument Serif"', 'italic 400 30px "Instrument Serif"', '400 22px "Inter Tight"', '500 16px "Inter Tight"'].map((f) => document.fonts.load(f))); } catch (_) { /* fall back */ }
  const ctx = canvas.getContext('2d');
  const W = 1200, H = 630;
  ctx.fillStyle = C.ink; ctx.fillRect(0, 0, W, H);
  // soft light behind the seal
  const g = ctx.createRadialGradient(930, 300, 10, 930, 300, 420);
  const tone = s.found === s.wallets ? C.life : s.found === 0 ? C.still : C.warn;
  g.addColorStop(0, tone + '22'); g.addColorStop(1, 'rgba(11,12,15,0)');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  // grain
  const rnd = (() => { let x = 42; return () => ((x = (x * 16807) % 2147483647) / 2147483647); })();
  for (let i = 0; i < 9000; i++) { ctx.fillStyle = `rgba(255,255,255,${rnd() * 0.05})`; ctx.fillRect(rnd() * W, rnd() * H, 1, 1); }

  // seal
  const cx = 930, cy = 300, R = 190;
  ctx.strokeStyle = C.brass; ctx.lineWidth = 1.6; ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.stroke();
  ctx.lineWidth = 0.8; ctx.beginPath(); ctx.arc(cx, cy, R - 7, 0, Math.PI * 2); ctx.stroke();
  ctx.beginPath(); ctx.arc(cx, cy, R - 46, 0, Math.PI * 2); ctx.stroke();
  // rim inscription
  ctx.save(); ctx.translate(cx, cy); ctx.fillStyle = C.brass; ctx.font = '500 14px "Inter Tight"';
  const rim = 'LASTWORD · WOULD IT ARRIVE? · LASTWORD · WOULD IT ARRIVE? · ';
  const step = (Math.PI * 2) / rim.length;
  [...rim].forEach((ch, i) => { ctx.save(); ctx.rotate(-Math.PI / 2 + i * step); ctx.translate(0, -(R - 26)); ctx.fillText(ch, -4, 5); ctx.restore(); });
  ctx.restore();
  // trace: alive if all would be found, stuttering if some, flat if none
  ctx.save(); ctx.beginPath(); ctx.arc(cx, cy, R - 47, 0, Math.PI * 2); ctx.clip();
  ctx.strokeStyle = tone; ctx.lineWidth = 2.6; ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  ctx.shadowColor = tone; ctx.shadowBlur = 10;
  ctx.beginPath();
  const y0 = cy - 4, x0 = cx - 150;
  if (s.found === 0) { ctx.moveTo(x0, y0); ctx.lineTo(cx + 150, y0); } else {
    const amp = s.found === s.wallets ? 1 : 0.5;
    const pts = [[0, 0], [68, 0], [74, -9 * amp], [86, 0], [106, 0], [111, 8 * amp], [121, -72 * amp], [131, 30 * amp], [137, 0], [153, 0], [166, -17 * amp], [182, 0], [300, 0]];
    pts.forEach(([dx, dy], i) => (i ? ctx.lineTo(x0 + dx, y0 + dy) : ctx.moveTo(x0 + dx, y0 + dy)));
  }
  ctx.stroke(); ctx.restore();
  ctx.fillStyle = C.bone; ctx.font = 'italic 400 34px "Instrument Serif"'; ctx.textAlign = 'center';
  ctx.fillText(s.found === s.wallets ? 'Arrives' : s.found === 0 ? 'Lost' : 'In part', cx, cy + 78);
  ctx.textAlign = 'left';

  // text
  ctx.fillStyle = C.brass; ctx.font = '500 16px "Inter Tight"';
  ctx.fillText('Would my crypto arrive?', 80, 120);
  ctx.fillStyle = C.bone; ctx.font = '400 66px "Instrument Serif"';
  const head = wrap(ctx, headline(s), 560);
  head.forEach((l, i) => ctx.fillText(l, 80, 200 + i * 70));
  let y = 200 + head.length * 70 + 18;
  ctx.fillStyle = C.bone2; ctx.font = '400 22px "Inter Tight"';
  lines.slice(0, 2).forEach((t) => { wrap(ctx, t, 560).slice(0, 2).forEach((l) => { ctx.fillText(l, 80, y); y += 31; }); y += 10; });
  ctx.strokeStyle = C.hair; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(80, 540); ctx.lineTo(1120, 540); ctx.stroke();
  ctx.fillStyle = C.bone2; ctx.font = '400 17px "Inter Tight"';
  ctx.fillText('A rough estimate from four answers, not advice.', 80, 576);
  ctx.textAlign = 'right'; ctx.fillStyle = C.bone; ctx.font = '400 24px "Instrument Serif"';
  ctx.fillText('Lastword  —  lastwordvault.vercel.app', 1120, 578);
  ctx.textAlign = 'left';
}

export function init() {
  const form = document.getElementById('quiz');
  const wait = document.getElementById('verdict-wait');
  const count = document.getElementById('quiz-count');
  const card = document.getElementById('verdict-card');
  const head = document.getElementById('verdict-head');
  const lines = document.getElementById('verdict-lines');
  const copy = document.getElementById('copy-result');
  const dl = document.getElementById('download-card');
  const canvas = document.getElementById('verdict-canvas');
  const copyStatus = document.getElementById('copy-status');
  const names = ['keys', 'know', 'agent', 'chains'];
  let summary = '';

  async function update() {
    const a = {};
    names.forEach((n) => { const c = form.querySelector('input[name="' + n + '"]:checked'); if (c) a[n] = c.value; });
    const done = Object.keys(a).length;
    count.textContent = done + ' of 4 answered.';
    if (done < 4) return;
    const s = score(a);
    head.textContent = headline(s);
    const items = [KEYS_LINE[a.keys], TOLD_LINE[a.know], AGENT_LINE[a.agent]];
    if (s.wallets > 1) items.push('Each chain is a separate search for your heirs.');
    items.push('A vault covers what you move into it. At settlement it pays your heirs on NEAR, has NEAR’s network sign Base, Monad and Solana payouts, and deletes its agent key. Testnet today.');
    lines.textContent = '';
    items.filter(Boolean).forEach((t) => { const li = document.createElement('li'); li.textContent = t; lines.append(li); });
    summary = 'Would my crypto arrive? ' + headline(s) + ' (A four-question check by Lastword; a rough estimate, not advice.) ' + SITE;
    wait.hidden = true;
    card.hidden = false;
    copyStatus.textContent = '';
    await drawCard(canvas, s, items.filter(Boolean));
  }

  form.addEventListener('change', update);
  form.addEventListener('submit', (e) => e.preventDefault());

  dl.addEventListener('click', () => {
    canvas.toBlob((blob) => {
      if (!blob) { copyStatus.textContent = 'The card could not be made here.'; return; }
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'would-my-crypto-arrive.png';
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      copyStatus.textContent = 'Card downloaded.';
    }, 'image/png');
  });

  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(summary);
      copyStatus.textContent = 'Copied.';
    } catch (_) {
      const t = document.createElement('textarea');
      t.value = summary; t.setAttribute('readonly', ''); t.style.position = 'fixed'; t.style.opacity = '0';
      document.body.append(t); t.select();
      const ok = document.execCommand && document.execCommand('copy');
      t.remove();
      copyStatus.textContent = ok ? 'Copied.' : 'Copy did not work here. Select the result and copy it.';
    }
  });
}
