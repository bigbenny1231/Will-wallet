// Renders the cold open, act cards, end card (as mp4 scenes) and the caption overlays (transparent PNGs).
import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const S = '/tmp/v3', A = S + '/assets', FF = '/usr/local/bin/ffmpeg';
fs.mkdirSync(A, { recursive: true });
const what = process.argv[2] || 'all';
const info = JSON.parse(fs.readFileSync(S + '/endinfo.json', 'utf8'));
const caps = JSON.parse(fs.readFileSync(S + '/captions.json', 'utf8'));
const b = await chromium.launch();
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 } });
const p = await ctx.newPage();
const ENC = ['-c:v', 'libx264', '-preset', 'slow', '-crf', '14', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60'];

if (what === 'all' || what === 'cards') {
  let seal = fs.readFileSync('/home/claude/deadmans-wallet/design/seal.svg', 'utf8');
  const no = String(info.token).padStart(4, '0');
  seal = seal.replaceAll('VAULT 0042', `VAULT ${no}`).replaceAll('NO. 0042', `NO. ${no}`).replaceAll('vault 0042', `vault ${no}`);
  await p.goto('http://localhost:5057/cards.html');
  const name = (info.heir.match(/^dmw-demo-([a-z]+)-/) || [, 'the heir'])[1]; const Name = name[0].toUpperCase() + name.slice(1);
  await p.evaluate(o => window.setup(o), { sealSvg: seal, endSeal: info.src, heir: info.heir, name: Name });
  const scenes = [['cold', 5, null], ['act1', 1.5, ['I', 'Alive']], ['act2', 1.5, ['II', 'Silence']], ['act3', 1.5, ['III', 'Settlement']], ['end', 6, null]];
  for (const [name, len, arg] of scenes) {
    const dir = `${A}/f_${name}`; fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir);
    const scene = name.startsWith('act') ? 'act' : name;
    const n = Math.round(len * 30);
    for (let i = 0; i < n; i++) {
      await p.evaluate(([s, t, f, len, arg]) => window.frame(s, t, f, len, arg), [scene, i / 30, i, len, arg]);
      await p.screenshot({ path: `${dir}/${String(i).padStart(4, '0')}.jpg`, type: 'jpeg', quality: 92 });
    }
    execFileSync(FF, ['-y', '-v', 'error', '-framerate', '30', '-i', `${dir}/%04d.jpg`, ...ENC, '-an', `${A}/${name}.tmp.mp4`]);
    fs.renameSync(`${A}/${name}.tmp.mp4`, `${A}/${name}.mp4`);
    console.log('scene', name, n);
  }
}
if (what === 'all' || what === 'caps') {
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
}
if (what === 'all' || what === 'caps') {
  const sp = await ctx.newPage(); await sp.setViewportSize({ width: 1920, height: 220 });
  const ed = JSON.parse(fs.readFileSync(S + '/edl.json', 'utf8')); await sp.goto('http://localhost:5057/caption.html');
  for (const k of Object.keys(ed.speeds)) {
    await sp.evaluate(h => { document.documentElement.innerHTML = h; }, `<head><style>@font-face{font-family:"Inter Tight";font-weight:500;src:url(/fonts/inter-tight-latin-500-normal.woff2)}
    html,body{margin:0;background:transparent;width:1920px;height:220px}
    div{position:absolute;right:56px;top:160px;font-family:"Inter Tight";font-weight:500;font-size:13px;letter-spacing:.16em;color:#C8A96A;text-transform:uppercase;display:flex;align-items:center;gap:10px}
    i{display:inline-block;width:14px;height:1px;background:#C8A96A}</style></head><body><div><i></i>${k}× speed</div></body>`); await sp.waitForTimeout(300);
    await sp.evaluate(() => document.fonts.ready);
    await sp.screenshot({ path: `${A}/speed_${k}.png`, omitBackground: true });
  }
}
await b.close();
