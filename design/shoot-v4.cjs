// v4 landing page screenshots. Needs a server for site/ that applies site/vercel.json headers, e.g.
//   node design/serve.cjs site 8091 &      then      node design/shoot-v4.cjs [http://127.0.0.1:8091] [prefix] [only]
// Writes site/screenshots/<prefix>-*-<width>.png (prefix defaults to v4): hero idle / mid-simulation / settled with a
// custom heir name, the vault 17 story at three scroll positions, the live estate graph, the quiz card.
// The graph needs network access to NEAR testnet (the proxy in HTTPS_PROXY is used if set).
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const BASE = process.argv[2] || 'http://127.0.0.1:8091';
const PREFIX = process.argv[3] || 'v4';
const ONLY = process.argv[4] || '';
const OUT = path.resolve(__dirname, '..', 'site', 'screenshots');
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const want = (k) => !ONLY || ONLY.split(',').includes(k);

async function shots(browser, w, h, mobile) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: !!mobile, hasTouch: !!mobile, ignoreHTTPSErrors: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const f = (n) => path.join(OUT, `${PREFIX}-${n}-${w}.png`);

  if (want('hero')) {
    await page.fill('#heir-name', 'Maria');
    await page.locator('#heir-name').blur();
    // first interaction loads the WebGL seal (the SVG seal stays until it is ready)
    if (!mobile) { await page.mouse.move(w * 0.5, h * 0.5); await page.mouse.move(w * 0.8, h * 0.36, { steps: 8 }); }
    else await page.tap('#hero-h');
    await page.waitForFunction(() => document.getElementById('hero-seal').classList.contains('is-3d'), null, { timeout: 15000 }).catch(() => console.log(w, 'no 3D seal'));
    await wait(1600);
    await page.screenshot({ path: f('hero-idle') });
    await page.locator('#hold').focus();
    await page.keyboard.press('Enter');
    await wait(6400);
    await page.screenshot({ path: f('hero-sim') });
    await wait(5400);
    await page.screenshot({ path: f('hero-settled') });
  }

  if (want('story')) {
    const at = async (sel, name, pause = 1800) => {
      await page.evaluate((s) => { const el = document.querySelector(s); const y = el.getBoundingClientRect().top + scrollY - innerHeight * 0.45; scrollTo(0, y); }, sel);
      await wait(pause);
      await page.screenshot({ path: f(name) });
    };
    await at('.ev-chip.no', 'story-alive');
    await at('[data-kin="silence"]', 'story-silence-a', 900);
    await page.evaluate(() => scrollBy(0, innerHeight * 0.55));
    await wait(1800);
    await page.screenshot({ path: f('story-silence') });
    await at('.ev-final', 'story-settled', 2600);
  }

  if (want('graph')) {
    await page.locator('#live').scrollIntoViewIfNeeded();
    await page.waitForFunction(() => document.getElementById('graph').getAttribute('aria-busy') === 'false', null, { timeout: 20000 }).catch(() => {});
    await page.evaluate(() => { const g = document.getElementById('graph'); scrollTo(0, g.getBoundingClientRect().top + scrollY - 90); });
    await wait(900);
    await page.screenshot({ path: f('graph') });
    const node = page.locator('.node[data-id="rbase"]');
    if (await node.count()) { await node.click(); await wait(600); await page.locator('#live').screenshot({ path: f('graph-detail') }); }
  }

  if (want('quiz')) {
    await page.locator('#would-it-arrive').scrollIntoViewIfNeeded();
    await wait(500);
    for (const [n, v] of [['keys', 'paper'], ['know', 'exists'], ['agent', 'limits'], ['chains', '3']]) {
      await page.locator(`input[name="${n}"][value="${v}"]`).locator('xpath=..').click();
    }
    await wait(900);
    await page.locator('#verdict').screenshot({ path: f('quiz-card') });
    if (!mobile) {
      const dataUrl = await page.evaluate(() => document.getElementById('verdict-canvas').toDataURL('image/png'));
      require('fs').writeFileSync(path.join(OUT, `${PREFIX}-quiz-card.png`), Buffer.from(dataUrl.split(',')[1], 'base64'));
    }
  }
  if (ONLY.split(',').includes('full')) {   // only on request: full-page PNGs are large
    await page.evaluate(async () => { for (let y = 0; y < document.body.scrollHeight; y += 500) { scrollTo(0, y); await new Promise((r) => setTimeout(r, 60)); } });
    await wait(1500);
    await page.screenshot({ path: f('full'), fullPage: true });
  }
  const sideScroll = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  console.log(w, 'errors:', errors.length ? errors : 'none', 'horizontal scroll:', sideScroll);
  await ctx.close();
}

(async () => {
  const browser = await chromium.launch({ proxy });
  await shots(browser, 390, 844, true);
  await shots(browser, 1440, 900, false);
  await browser.close();
})();
