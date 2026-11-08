// Records site/screenshots/v4-tour.mp4: a ~18 s scroll through the v4 page (hero with the 3D seal and a custom heir,
// the vault 17 story drawn by scroll, the live estate graph, the quiz card).
//   node design/serve.cjs site 8091 &   then   node design/tour-v4.cjs [http://127.0.0.1:8091]
// Needs ffmpeg (FFMPEG env or /usr/local/bin/ffmpeg). The graph needs network access to NEAR testnet.
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const BASE = process.argv[2] || 'http://127.0.0.1:8091';
const FFMPEG = process.env.FFMPEG || '/usr/local/bin/ffmpeg';
const OUT = path.resolve(__dirname, '..', 'site', 'screenshots', 'v4-tour.mp4');
const TMP = fs.mkdtempSync('/tmp/dmw-tour-');
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const browser = await chromium.launch({ proxy });
  const W = 1280, H = 800;
  // warm-up visit so fonts, the graph data and the 3D bundle are cached before recording
  const warm = await browser.newContext({ viewport: { width: W, height: H }, ignoreHTTPSErrors: true });
  const wp = await warm.newPage();
  await wp.goto(BASE + '/?heir=Maria&seal3d', { waitUntil: 'networkidle' });
  await wait(1500);
  await warm.close();

  const ctx = await browser.newContext({ viewport: { width: W, height: H }, ignoreHTTPSErrors: true, recordVideo: { dir: TMP, size: { width: W, height: H } } });
  const page = await ctx.newPage();
  const t0 = Date.now();
  await page.goto(BASE + '/?heir=Maria&seal3d', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForFunction(() => document.getElementById('hero-seal').classList.contains('is-3d'), null, { timeout: 15000 }).catch(() => {});
  const lead = (Date.now() - t0) / 1000;

  // hero: the pointer drifts across the seal, which tilts toward it
  // (few pointer steps: each one re-renders the WebGL seal, which is slow in a software-GL recorder)
  const tHero = Date.now();
  for (const [x, y] of [[1120, 270], [870, 470], [1000, 360]]) { await page.mouse.move(x, y, { steps: 3 }); await wait(500); }
  const heroSlow = Math.max(0, (Date.now() - tHero) / 1000 - 3.2);

  // one smooth scroll: hero -> story (drawn by scroll) -> estate graph -> quiz
  const glide = (to, ms) => page.evaluate(([to, ms]) => new Promise((res) => {
    const from = scrollY, t0 = performance.now();
    const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
    const tick = (now) => { const t = Math.min(1, (now - t0) / ms); scrollTo({ top: from + (to - from) * ease(t), behavior: 'instant' }); if (t < 1) requestAnimationFrame(tick); else res(); };
    requestAnimationFrame(tick);
  }), [to, ms]);
  const top = (sel, off = 0) => page.evaluate(([s, o]) => document.querySelector(s).getBoundingClientRect().top + scrollY - o, [sel, off]);

  await page.mouse.move(640, 760, { steps: 10 });
  await glide(await top('#how', 40), 1600);
  await glide(await top('.ev-final', 380), 9000);
  await wait(900);
  await glide(await top('#graph', 110), 1700);
  await wait(1700);
  await page.locator('.node[data-id="h0"]').hover();
  await wait(900);
  await glide(await top('#would-it-arrive', 70), 1200);
  for (const [n, v] of [['keys', 'paper'], ['know', 'exists'], ['agent', 'limits'], ['chains', '3']]) {
    await page.locator(`input[name="${n}"][value="${v}"]`).locator('xpath=..').click();
    await wait(160);
  }
  await wait(1500);
  const total = (Date.now() - t0) / 1000;
  await ctx.close();
  await browser.close();

  const webm = fs.readdirSync(TMP).find((f) => f.endsWith('.webm'));
  // the recorder runs slower than real time (software GL); speed the clip up to land at about 19 s
  const dur = total - lead, speed = Math.max(1, dur / 19);
  execFileSync(FFMPEG, ['-y', '-ss', lead.toFixed(2), '-i', path.join(TMP, webm), '-t', dur.toFixed(2),
    '-vf', `setpts=PTS/${speed.toFixed(3)},fps=30,scale=1280:-2`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '30', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-an', OUT], { stdio: 'inherit' });
  console.log('hero took', heroSlow.toFixed(1), 's longer than planned');
  console.log('tour:', OUT, (fs.statSync(OUT).size / 1048576).toFixed(2) + ' MB', (dur / speed).toFixed(1) + ' s, recorded ' + dur.toFixed(1) + ' s');
})();
