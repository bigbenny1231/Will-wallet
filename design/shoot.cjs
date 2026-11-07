// Visual check and asset renderer for the landing page.
//   node design/shoot.cjs            -> site/screenshots/*.png and site/assets/poster.jpg
// Serves the repo on a local port (no network needed) and drives Chromium with Playwright.
const path = require('path');
const fs = require('fs');
const http = require('http');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'site', 'screenshots');
const TYPES = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.png': 'image/png', '.mp4': 'video/mp4' };

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if (p.endsWith('/')) p += 'index.html';
      const f = path.join(ROOT, p);
      if (!f.startsWith(ROOT) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
      res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(res);
    }).listen(0, '127.0.0.1', () => resolve(srv));
  });
}

async function scrollThrough(page) {
  await page.evaluate(async () => {
    const step = Math.round(innerHeight * 0.6);
    for (let y = 0; y < document.body.scrollHeight; y += step) { scrollTo(0, y); await new Promise(r => setTimeout(r, 120)); }
    await new Promise(r => setTimeout(r, 2200));
    scrollTo(0, 0);
    await new Promise(r => setTimeout(r, 300));
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const srv = await serve();
  const base = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch();
  const only = process.argv[2];

  // Poster: the seal on ink, 1280x720, rendered from design/seal.svg.
  if (!only || only === 'poster') {
    // The poster shows the end of the story: the settled seal, grey and still (DESIGN.md, Video).
    const seal = fs.readFileSync(path.join(__dirname, 'seal.svg'), 'utf8')
      .replace('--state:#3DDC84', '--state:#7A7F87')
      .replace(/>ALIVE</g, '>SETTLED<')
      .replace('>Alive<', '>Settled<')
      .replace('vault 0042: alive', 'vault 0042: settled')
      .replace(/ d="M50,196H118[^"]*"/g, ' d="M50,196H350"')
      .replace('class="trace trace-hi"', 'class="trace trace-hi" style="display:none"');
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
    await page.goto(`${base}/design/tokens.css`); // same origin as the fonts
    await page.setContent(`<!doctype html><html><head>
      <link rel="stylesheet" href="${base}/design/tokens.css">
      <link rel="stylesheet" href="${base}/site/styles.css">
      <style>
        body{margin:0;width:1280px;height:720px;overflow:hidden;display:grid;grid-template-columns:560px 1fr;align-items:center;padding:0 96px 0 72px;gap:64px}
        body::after{opacity:.05}
        .s{width:500px;height:500px}
        .s .glow{animation:none!important;opacity:.5}
        h1{font-size:76px;line-height:1;letter-spacing:-.015em;margin:0 0 22px}
        p{font-size:22px;color:var(--bone-2);margin:0;max-width:20em;line-height:1.45}
        .k{margin-top:40px;font:500 12px/1 var(--font-text);letter-spacing:.12em;text-transform:uppercase;color:var(--brass);padding-top:16px;border-top:1px solid var(--hair-strong);max-width:420px}
      </style></head><body><div class="s">${seal}</div>
      <div><h1>Dead Man&#8217;s Wallet</h1><p>A vault is created. The heartbeats stop. Sarah and Ben are paid on NEAR testnet.</p><div class="k">The demo, 2 minutes 39 seconds</div></div></body></html>`, { waitUntil: 'networkidle' });
    await page.evaluate(async () => { await Promise.all(['400 40px "Instrument Serif"', 'italic 400 40px "Instrument Serif"', '400 16px "Inter Tight"', '500 16px "Inter Tight"', '400 14px "JetBrains Mono"'].map(f => document.fonts.load(f))); await document.fonts.ready; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(ROOT, 'site', 'assets', 'poster.jpg'), type: 'jpeg', quality: 86 });
    await page.close();
  }

  if (!only || only === 'seal') {
    const page = await browser.newPage({ viewport: { width: 800, height: 800 }, deviceScaleFactor: 1 });
    const seal = fs.readFileSync(path.join(__dirname, 'seal.svg'), 'utf8');
    await page.goto(`${base}/design/tokens.css`);
    await page.setContent(`<!doctype html><html><head><link rel="stylesheet" href="${base}/design/tokens.css"><link rel="stylesheet" href="${base}/site/styles.css">
      <style>body{margin:0;width:800px;height:800px;display:grid;place-items:center}.s{width:640px;height:640px}
      .s .trace-hi,.s .glow{animation-play-state:paused!important;animation-delay:-0.62s!important}</style></head>
      <body><div class="s">${seal}</div></body></html>`, { waitUntil: 'networkidle' });
    await page.evaluate(async () => { await Promise.all(['400 40px "Instrument Serif"', 'italic 400 40px "Instrument Serif"', '400 16px "Inter Tight"', '500 16px "Inter Tight"', '400 14px "JetBrains Mono"'].map(f => document.fonts.load(f))); await document.fonts.ready; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, 'seal-800.png') });
    await page.close();
  }

  for (const [w, h, name] of [[1440, 900, 'desktop-1440'], [390, 844, 'mobile-390']]) {
    if (only && only !== 'page' && only !== name) continue;
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: w < 500 ? 2 : 1 });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(`${base}/site/index.html`, { waitUntil: 'networkidle' });
    await page.evaluate(async () => { await Promise.all(['400 40px "Instrument Serif"', 'italic 400 40px "Instrument Serif"', '400 16px "Inter Tight"', '500 16px "Inter Tight"', '400 14px "JetBrains Mono"'].map(f => document.fonts.load(f))); await document.fonts.ready; });
    await page.waitForTimeout(700);
    await page.screenshot({ path: path.join(OUT, `${name}-hero.png`) });
    await scrollThrough(page);
    await page.addStyleTag({ content: '.nav{position:relative!important}' });
    await page.screenshot({ path: path.join(OUT, `${name}-full.png`), fullPage: true });
    const fonts = await page.evaluate(() => [...document.fonts].filter(f => f.status === 'loaded').map(f => `${f.family} ${f.weight} ${f.style}`));
    console.log(name, 'fonts loaded:', fonts.join(', '));
    if (errors.length) console.log(name, 'errors:', errors.join(' | '));
    await page.close();
  }

  await browser.close();
  srv.close();
})();
