// Renders the cold open, act cards and end card (mp4 scenes) and the caption and speed overlays (transparent PNGs),
// from the stage server on :5057. Port of v3/assets.mjs with paths from the environment. env: REPO, S, FF, PW_MODULE
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const { chromium } = await import(process.env.PW_MODULE || 'playwright');
const REPO = process.env.REPO, S = process.env.S || '/tmp/v4', A = S + '/assets', FF = process.env.FF || 'ffmpeg';
fs.mkdirSync(A, { recursive: true });
const info = JSON.parse(fs.readFileSync(S + '/endinfo.json', 'utf8'));
const caps = JSON.parse(fs.readFileSync(S + '/captions.json', 'utf8'));
const ed = JSON.parse(fs.readFileSync(S + '/edl.json', 'utf8'));
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } });
const p = await ctx.newPage();
const ENC = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60'];

let seal = fs.readFileSync(REPO + '/design/seal.svg', 'utf8');
const no = String(info.token).padStart(4, '0');
seal = seal.replaceAll('VAULT 0042', `VAULT ${no}`).replaceAll('NO. 0042', `NO. ${no}`).replaceAll('vault 0042', `vault ${no}`);
await p.goto('http://localhost:5057/cards.html');
const heir = info.heir || 'dmw-demo-sarah.testnet';
const name = (heir.match(/^dmw-demo-([a-z]+)-/) || [, 'the heir'])[1]; const Name = name[0].toUpperCase() + name.slice(1);
// the end card shows the vault's own on-chain Will NFT image; without one, the cold-open seal stands in
const endSeal = info.src || ('data:image/svg+xml;base64,' + Buffer.from(seal).toString('base64'));
await p.evaluate(o => window.setup(o), { sealSvg: seal, endSeal, heir, name: Name });
for (const [nm, len, arg] of [['cold', 5, null], ['act1', 1.5, ['I', 'Alive']], ['act2', 1.5, ['II', 'Silence']], ['act3', 1.5, ['III', 'Settlement']], ['end', 6, null]]) {
  const dir = `${A}/f_${nm}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
  const scene = nm.startsWith('act') ? 'act' : nm; const n = Math.round(len * 30);
  for (let i = 0; i < n; i++) {
    await p.evaluate(([s, t, f, len, arg]) => window.frame(s, t, f, len, arg), [scene, i / 30, i, len, arg]);
    await p.screenshot({ path: `${dir}/${String(i).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 92 });
  }
  execFileSync(FF, ['-y', '-v', 'error', '-framerate', '30', '-i', `${dir}/%04d.jpg`, ...ENC, '-an', `${A}/${nm}.mp4`]);
  console.log('scene', nm, n);
}
const cp = await ctx.newPage(); await cp.setViewportSize({ width: 1920, height: 220 });
await cp.goto('http://localhost:5057/caption.html'); await cp.evaluate(() => document.fonts.ready);
for (const [i, c] of caps.entries()) {
  const lines = await cp.evaluate(([t, n]) => {
    const cap = document.getElementById('cap');
    cap.innerHTML = t.replace(/(^|\. )(I|II|III|IV|V)\. /g, (m, a, r) => `${a}<span class="rn">${r}.</span> `);
    document.getElementById('note').textContent = n || '';
    return Math.round(cap.getBoundingClientRect().height / (48 * 1.16));
  }, [c.text, c.note]);
  if (lines > 2) console.log('WARN caption >2 lines', i, c.text);
  await cp.screenshot({ path: `${A}/cap_${String(i).padStart(2, '0')}.png`, omitBackground: true });
  console.log('cap', i, lines + ' lines');
}
const sp = await ctx.newPage(); await sp.setViewportSize({ width: 1920, height: 220 });
await sp.goto('http://localhost:5057/caption.html');
for (const k of Object.keys(ed.speeds)) {
  await sp.evaluate(h => { document.documentElement.innerHTML = h; }, `<head><style>@font-face{font-family:"Inter Tight";font-weight:500;src:url(/fonts/inter-tight-latin-500-normal.woff2)}
  html,body{margin:0;background:transparent;width:1920px;height:220px}
  div{position:absolute;right:56px;top:160px;font-family:"Inter Tight";font-weight:500;font-size:13px;letter-spacing:.16em;color:#C8A96A;text-transform:uppercase;display:flex;align-items:center;gap:10px}
  i{display:inline-block;width:14px;height:1px;background:#C8A96A}</style></head><body><div><i></i>${k}× speed</div></body>`);
  await sp.waitForTimeout(300); await sp.evaluate(() => document.fonts.ready);
  await sp.screenshot({ path: `${A}/speed_${k}.png`, omitBackground: true });
}
await b.close();
