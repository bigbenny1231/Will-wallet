// Screenshots + budget check for the 3D seal (Playwright, chromium, SwiftShader GL).
//   node design/seal3d/serve.cjs 8093 &   then   node design/seal3d/shoot.cjs [http://127.0.0.1:8093]
// Writes design/seal3d/shots/*.png and prints stats; exits 1 if the scene is over budget.
const path = require('path'), fs = require('fs');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }
const BASE = process.argv[2] || 'http://127.0.0.1:8093';
const OUT = path.join(__dirname, 'shots');
fs.mkdirSync(OUT, { recursive: true });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const BUDGET = { triangles: 60000, calls: 6 };   // base (body + face) + 4 extras

(async () => {
  const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--use-gl=angle', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
  const fails = [];
  const ctx = await browser.newContext({ viewport: { width: 760, height: 900 }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/design/seal3d/demo.html?nobeat', { waitUntil: 'networkidle' });
  await page.waitForFunction(() => document.documentElement.dataset.sealReady === '1', null, { timeout: 30000 });
  const stage = page.locator('#stage');
  const snap = async (name) => { await stage.screenshot({ path: path.join(OUT, name + '.png') }); console.log('shot', name); };
  await page.fill('#heir', 'Sarah');
  await wait(1500);
  await snap('alive');
  await page.evaluate(() => window.__seal.beat());
  await wait(260);
  await snap('alive-beat');
  await page.mouse.move(700, 120);
  await wait(2200);
  await snap('alive-tilt');
  await page.mouse.move(380, 330);
  await wait(1800);
  await page.click('button[data-state="warning"]');
  await wait(1200);
  await page.evaluate(() => window.__seal.beat());
  await wait(260);
  await snap('warning');
  await page.click('button[data-state="triggered"]');
  await wait(300);
  await snap('triggered-flattening');
  await wait(1200);
  await snap('triggered');
  await page.click('button[data-state="settled"]');
  await wait(1500);
  await snap('settled');

  // budget + timing: let it run a while, sample frame times
  await page.click('button[data-state="alive"]');
  await wait(800);
  const m = await page.evaluate(async () => {
    const ts = [];
    await new Promise((res) => { let n = 0; const f = (t) => { ts.push(t); if (++n < 60) requestAnimationFrame(f); else res(); }; requestAnimationFrame(f); });
    const d = ts.slice(1).map((t, i) => t - ts[i]);
    return { stats: window.__seal.stats(), avgFrameMs: d.reduce((a, b) => a + b, 0) / d.length, gl: (() => { const g = document.createElement('canvas').getContext('webgl2'); const e = g && g.getExtension('WEBGL_debug_renderer_info'); return e ? g.getParameter(e.UNMASKED_RENDERER_WEBGL) : 'n/a'; })() };
  });
  console.log('stats', JSON.stringify(m));
  if (m.stats.triangles > BUDGET.triangles) fails.push(`triangles ${m.stats.triangles} > ${BUDGET.triangles}`);
  if (m.stats.calls > BUDGET.calls) fails.push(`draw calls ${m.stats.calls} > ${BUDGET.calls}`);

  // hidden tab pauses rendering: frame counter must not advance while the canvas is off-screen
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.setViewportSize({ width: 760, height: 900 });
  const paused = await page.evaluate(async () => {
    const c = document.getElementById('seal3d');
    c.style.marginTop = '4000px';   // push off-screen
    await new Promise((r) => setTimeout(r, 400));
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    let draws = 0; const orig = gl.drawElements.bind(gl); gl.drawElements = (...a) => { draws++; return orig(...a); };
    await new Promise((r) => setTimeout(r, 700));
    gl.drawElements = orig; c.style.marginTop = '';
    return draws;
  });
  console.log('draws while off-screen:', paused);
  if (paused > 0) fails.push('rendering did not pause off-screen');

  // reduced motion still renders and tilts
  const rctx = await browser.newContext({ viewport: { width: 760, height: 900 }, reducedMotion: 'reduce' });
  const rp = await rctx.newPage();
  await rp.goto(BASE + '/design/seal3d/demo.html', { waitUntil: 'networkidle' });
  await rp.waitForFunction(() => document.documentElement.dataset.sealReady === '1', null, { timeout: 30000 });
  await rp.mouse.move(60, 60);
  await wait(2500);
  await rp.locator('#stage').screenshot({ path: path.join(OUT, 'reduced-motion-tilt.png') });
  console.log('shot reduced-motion-tilt');

  if (errors.length) { console.log('console:', errors.join('\n')); }
  if (errors.some((e) => /error/i.test(e) && !/GPU stall|swiftshader|WebGL: INVALID_ENUM|Automatic fallback/i.test(e))) fails.push('console errors');
  await browser.close();
  if (fails.length) { console.log('FAIL', fails.join('; ')); process.exit(1); }
  console.log('OK budget', JSON.stringify(BUDGET));
})().catch((e) => { console.error(e); process.exit(1); });
