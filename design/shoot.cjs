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
      <div><h1>Dead Man&#8217;s Wallet</h1><p>A vault is created. Its agent is refused. The heartbeats stop, and settlement runs on NEAR testnet.</p><div class="k">The demo, 2 minutes 50 seconds, vault 17</div></div></body></html>`, { waitUntil: 'networkidle' });
    await page.evaluate(async () => { await Promise.all(['400 40px "Instrument Serif"', 'italic 400 40px "Instrument Serif"', '400 16px "Inter Tight"', '500 16px "Inter Tight"', '400 14px "JetBrains Mono"'].map(f => document.fonts.load(f))); await document.fonts.ready; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(ROOT, 'site', 'assets', 'poster.jpg'), type: 'jpeg', quality: 86 });
    await page.close();
  }

  // Open Graph card, v4: the mark and wordmark (design/logo.svg), the WebGL seal (site/js/seal3d.bundle.js; the SVG
  // seal if WebGL is unavailable), the headline, and the line: heartbeats that flatline into the five settlement ticks. 1200x630 PNG (site/assets/og.png).
  if (!only || only === 'og') {
    const seal = fs.readFileSync(path.join(__dirname, 'seal.svg'), 'utf8');
    const mark = fs.readFileSync(path.join(__dirname, 'logo.svg'), 'utf8').match(/<g\b[\s\S]*?<\/g>/)[0];
    const P = require(path.join(__dirname, 'pulse.js'));
    let line = '';
    for (let i = 0; i < 4; i++) line += P.complex(40 + i * 120, 60, 0.8).replace(/^M/, i ? 'L' : 'M') + ' L' + (40 + i * 120 + 120) + ',60';
    const ticks = ['I', 'II', 'III', 'IV', 'V'].map((n, i) => { const x = 610 + i * 104; return `<path d="M${x},50V70" stroke="#C8A96A" stroke-width="1.2"/><text x="${x}" y="96" text-anchor="middle" fill="#C8A96A" font-family="Instrument Serif" font-size="19">${n}</text>`; }).join('');
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.goto(`${base}/design/tokens.css`);
    await page.setContent(`<!doctype html><html><head>
      <link rel="stylesheet" href="${base}/design/tokens.css">
      <link rel="stylesheet" href="${base}/site/styles.css">
      <style>
        body{margin:0;width:1200px;height:630px;overflow:hidden;position:relative;background:radial-gradient(640px 520px at 905px 270px, rgba(61,220,132,.075), transparent 70%), #0B0C0F}
        body::after{opacity:.05}
        .b{position:absolute;left:80px;top:58px;display:flex;align-items:center;gap:12px;font:400 44px/1 var(--font-display);color:var(--bone)}
        .b svg{width:38px;height:38px;margin-top:-4px}
        .t{position:absolute;left:80px;top:142px;width:640px}
        h1{font-size:82px;line-height:.96;letter-spacing:-.016em;margin:0 0 26px}
        p{font-size:23px;color:var(--bone-2);margin:0;max-width:24em;line-height:1.4}
        .s{position:absolute;right:66px;top:34px;width:430px;height:430px}
        .s canvas{position:absolute;inset:-8%;width:116%;height:116%}
        .s .seal{width:100%;height:100%}
        .s .trace-hi,.s .glow{animation-play-state:paused!important;animation-delay:-0.62s!important}
        .s.is-3d .seal{opacity:0}
        .l{position:absolute;left:0;right:0;bottom:22px;height:120px}
        .k{position:absolute;left:80px;bottom:150px;font:400 16px/1 var(--font-text);color:var(--bone-2);max-width:none;white-space:nowrap}
      </style></head><body>
      <div class="b"><svg viewBox="0 0 32 32">${mark}</svg>Dead Man&#8217;s Wallet</div>
      <div class="t"><h1>Your crypto shouldn&#8217;t die with you.</h1><p>While you&#8217;re alive, nothing happens. When you&#8217;re not, your vault pays the people you chose.</p></div>
      <div class="s" id="s">${seal}<canvas id="c"></canvas></div>
      <svg class="l" viewBox="0 0 1200 120"><path d="${line} L560,60" fill="none" stroke="#3DDC84" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
        <path d="M560,60 H1160" fill="none" stroke="#7A7F87" stroke-width="1.6"/>${ticks}</svg>
      <script type="module">
        try {
          const m = await import('${base}/site/js/seal3d.bundle.js');
          if (m.supportsWebGL()) { const s = m.createSeal3D(document.getElementById('c'), { state: 'alive', vaultNo: '0042', heir: 'Sarah', autoBeat: 0 }); await s.ready; s.setPointer(-0.35, -0.2); s.beat(); await new Promise(r => setTimeout(r, 900)); document.getElementById('s').classList.add('is-3d'); }
        } catch (e) { console.log('og: SVG seal', e); }
        window.__ogReady = true;
      </script></body></html>`, { waitUntil: 'networkidle' });
    await page.evaluate(async () => { await Promise.all(['400 40px "Instrument Serif"', 'italic 400 40px "Instrument Serif"', '400 16px "Inter Tight"', '500 16px "Inter Tight"'].map(f => document.fonts.load(f))); await document.fonts.ready; });
    await page.waitForFunction(() => window.__ogReady, null, { timeout: 20000 }).catch(() => {});
    await page.waitForTimeout(400);
    console.log('og: 3D seal', await page.evaluate(() => document.getElementById('s').classList.contains('is-3d')));
    await page.screenshot({ path: path.join(ROOT, 'site', 'assets', 'og.png'), type: 'png' });
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
