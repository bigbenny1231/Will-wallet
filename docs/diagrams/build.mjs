// Builds docs/diagrams/*.svg (fonts embedded) and *.png (Playwright), and the one-pager PDF.
// Usage: node docs/diagrams/build.mjs   (needs playwright; set PW to its module dir if not resolvable)
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath, pathToFileURL } from 'node:url'; import { createRequire } from 'node:module';
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');
const require = createRequire(import.meta.url);
const pwPath = process.env.PW || '/opt/npm-tools/node_modules/playwright';
const { chromium } = require(pwPath);
const fdir = path.join(root, 'site/fonts');
const face = (fam, file, weight, style = 'normal') =>
  `@font-face{font-family:'${fam}';font-weight:${weight};font-style:${style};src:url(data:font/woff2;base64,${fs.readFileSync(path.join(fdir, file)).toString('base64')}) format('woff2')}`;
const fonts = [
  face('Instrument Serif', 'instrument-serif-latin-400-normal.woff2', 400),
  face('Instrument Serif', 'instrument-serif-latin-400-italic.woff2', 400, 'italic'),
  face('Inter Tight', 'inter-tight-latin-400-normal.woff2', 400),
  face('Inter Tight', 'inter-tight-latin-500-normal.woff2', 500),
  face('Inter Tight', 'inter-tight-latin-600-normal.woff2', 600),
  face('JetBrains Mono', 'jetbrains-mono-latin-400-normal.woff2', 400),
].join('\n');
const css = fs.readFileSync(path.join(here, 'src/common.css'), 'utf8');
const names = ['architecture', 'state-machine', 'settlement-sequence', 'threat-model'];
const only = process.argv.slice(2);
const browser = await chromium.launch();
for (const n of names) {
  if (only.length && !only.includes(n)) continue;
  const src = fs.readFileSync(path.join(here, `src/${n}.svg`), 'utf8');
  const out = src.replace('/*STYLE*/', `${fonts}\n${css}`);
  const svgPath = path.join(here, `${n}.svg`);
  fs.writeFileSync(svgPath, out);
  const m = out.match(/viewBox="0 0 (\d+) (\d+)"/); const w = +m[1], h = +m[2];
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 2 });
  await page.setContent(`<html><body style="margin:0;background:#0B0C0F">${out}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: path.join(here, `${n}.png`), clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
  console.log('built', n, w, h);
}
if (!only.length || only.includes('one-pager')) {
  const html = path.join(root, 'docs/one-pager/attorney-one-pager.html');
  const page = await browser.newPage();
  await page.goto(pathToFileURL(html).href);
  await page.evaluate(() => document.fonts.ready);
  await page.pdf({ path: path.join(root, 'docs/one-pager/attorney-one-pager.pdf'), format: 'Letter', printBackground: true, margin: { top: '0', right: '0', bottom: '0', left: '0' }, preferCSSPageSize: true });
  await page.screenshot({ path: '/tmp/onepager-preview.png', fullPage: true });
  await page.close(); console.log('built one-pager');
}
await browser.close();
