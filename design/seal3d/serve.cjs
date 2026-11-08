// Tiny static server for the seal demo: serves the repo root with the site's headers (CSP script-src 'self').
//   node design/seal3d/serve.cjs [port]   ->   http://127.0.0.1:8093/design/seal3d/demo.html
const http = require('http'), fs = require('fs'), path = require('path');
const root = path.resolve(__dirname, '..', '..'), port = +process.argv[2] || 8093;
const hdrs = JSON.parse(fs.readFileSync(path.join(root, 'site', 'vercel.json'))).headers[0].headers;
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json' };
http.createServer((req, res) => {
  const u = decodeURIComponent(req.url.split('?')[0]);
  const f = path.join(root, path.normalize(u).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(root) || /node_modules|\.git/.test(f) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  hdrs.forEach((h) => res.setHeader(h.key, h.value));
  res.setHeader('Content-Type', types[path.extname(f)] || 'application/octet-stream');
  res.setHeader('Cache-Control', 'no-store');
  res.writeHead(200);
  fs.createReadStream(f).pipe(res);
}).listen(port, '127.0.0.1', () => console.log(`seal demo: http://127.0.0.1:${port}/design/seal3d/demo.html`));
