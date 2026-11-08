// v3 landing page screenshots. Needs a server for site/ that applies site/vercel.json headers, e.g.
//   node design/serve.cjs site 8091 &      then      node design/shoot-v3.cjs [http://127.0.0.1:8091] [prefix]
// Writes site/screenshots/<prefix>-*.png (prefix defaults to v3). The live strip needs network access to NEAR testnet.
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const BASE = process.argv[2] || 'http://127.0.0.1:8091';
const PREFIX = process.argv[3] || 'v3';
const OUT = path.resolve(__dirname, '..', 'site', 'screenshots');
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function shots(browser, w, h, mobile) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: mobile ? 2 : 1, isMobile: !!mobile, hasTouch: !!mobile });
  const page = await ctx.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  const f = (n) => path.join(OUT, `${PREFIX}-${n}-${w}.png`);
  await page.screenshot({ path: f('hero-idle') });

  // hold the control for real: 1.6 s
  const box = await page.locator('#hold').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await wait(700);
  await page.screenshot({ path: f('hero-holding') });
  await wait(950);
  await page.mouse.up();
  await wait(6200);
  await page.screenshot({ path: f('hero-sim') });
  await wait(5600);
  await page.screenshot({ path: f('hero-settled') });

  // act II in the middle of the screen
  await page.evaluate(() => document.querySelectorAll('.act')[1].scrollIntoView({ block: 'center' }));
  await wait(1400);
  await page.screenshot({ path: f('act2') });
  await page.evaluate(() => document.querySelector('.act-settle').scrollIntoView({ block: 'center' }));
  await wait(4200);
  await page.screenshot({ path: f('act3') });

  await page.locator('#live').scrollIntoViewIfNeeded();
  await page.waitForFunction(() => document.getElementById('live-grid').getAttribute('aria-busy') === 'false', null, { timeout: 15000 }).catch(() => {});
  await wait(400);
  await page.locator('#live').screenshot({ path: f('live') });

  await page.locator('#would-it-arrive').scrollIntoViewIfNeeded();
  await wait(500);
  for (const [n, v] of [['keys', 'paper'], ['know', 'exists'], ['agent', 'limits'], ['chains', '3']]) {
    await page.locator(`input[name="${n}"][value="${v}"]`).locator('xpath=..').click();
  }
  await wait(400);
  await page.locator('#would-it-arrive').screenshot({ path: f('quiz') });
  await page.locator('#builders').screenshot({ path: f('builders') });
  await page.screenshot({ path: f('full'), fullPage: true });
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
