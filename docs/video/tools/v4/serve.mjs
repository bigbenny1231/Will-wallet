// Stage server on :5057 for the v4 recording and the card/caption renders: the stage pages from this folder, the
// self-hosted fonts from site/fonts, and two live logs (/logs/keeper = .demo/keeper.log, /logs/agent = $S/agent.out).
import http from 'node:http'; import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = process.env.REPO, S = process.env.S || '/tmp/v4';
const TYPES = { '.html': 'text/html; charset=utf-8', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png', '.js': 'text/javascript' };
const logs = { keeper: REPO + '/.demo/keeper.log', agent: S + '/agent.out' };
http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'); let file;
  if (u.pathname.startsWith('/logs/')) { const f = logs[u.pathname.slice(6)]; res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' }); return res.end(f && fs.existsSync(f) ? fs.readFileSync(f) : ''); }
  if (u.pathname.startsWith('/fonts/')) file = path.join(REPO, 'site', 'fonts', path.basename(u.pathname));
  else file = path.join(here, u.pathname === '/' ? 'stage.html' : path.basename(u.pathname));
  if (!fs.existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream' }); res.end(fs.readFileSync(file));
}).listen(5057, () => console.log('stage on :5057'));
