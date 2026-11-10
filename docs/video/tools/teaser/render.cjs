// usage: node render.cjs <w> <h> <outdir> [frame,frame,...]   (no list = every frame)
const { chromium } = require('playwright');
const path = require('path');
const [w, h, out, list] = process.argv.slice(2);
(async () => {
  const b = await chromium.launch({ args: ['--allow-file-access-from-files'] });
  const page = await b.newPage({ viewport: { width: +w, height: +h }, deviceScaleFactor: 1 });
  const errs = []; page.on('pageerror', (e) => errs.push(String(e))); page.on('console', (m) => { if (m.type() === 'error') errs.push(m.text()); });
  await page.goto('file://' + path.resolve(__dirname, 'teaser.html') + `?w=${w}&h=${h}`);
  await page.evaluate(() => window.ready);
  const n = await page.evaluate(() => window.FRAMES);
  const frames = list ? list.split(',').map(Number) : [...Array(n).keys()];
  const t0 = Date.now();
  for (const i of frames) {
    await page.evaluate((i) => window.renderFrame(i), i);
    await page.screenshot({ path: `${out}/f${String(i).padStart(4, '0')}.png`, type: 'png' });
  }
  console.log('frames', frames.length, 'of', n, 'in', ((Date.now() - t0) / 1000).toFixed(1) + 's', 'errors', JSON.stringify(errs.slice(0, 5)));
  await b.close();
})();
