import { chromium } from '/opt/npm-tools/node_modules/playwright/index.mjs';
import fs from 'node:fs'; import { spawn, execSync } from 'node:child_process';
const REPO = '/home/claude/deadmans-wallet', D = REPO + '/.demo', S = '/tmp/v3';
const TOKEN = fs.readFileSync(D + '/vault_id', 'utf8').trim();
const C = 'dmw-x8cx.testnet';
const GUARD = `dmw-demo-guardian-${fs.readFileSync(D + '/suffix', 'utf8').trim()}.testnet`;
const PAIR = fs.readFileSync(S + '/pairing.url', 'utf8').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now() / 1000; const now = () => Date.now() / 1000;
const events = []; const ev = (name, extra = {}) => { events.push({ t: now(), name, ...extra }); console.log(new Date().toISOString().slice(11, 19), name, JSON.stringify(extra)); fs.writeFileSync(S + '/events.json', JSON.stringify(events, null, 1)); };

fs.writeFileSync(S + '/agent.out', '');

// keeper log watcher
let kseen = 0;
const lineTimer = setInterval(() => { let t = ''; try { t = fs.readFileSync(D + '/keeper.log', 'utf8'); } catch { return; } const ls = t.split('\n').filter(x => x.trim()); for (let i = kseen; i < ls.length; i++) ev('kline', { text: ls[i].slice(0, 140) }); kseen = Math.max(kseen, ls.length); }, 250);

const b = await chromium.launch({ args: ['--hide-scrollbars'] });
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'UTC', locale: 'en-GB' });
const page = await ctx.newPage();
await page.goto('http://localhost:5057/');
await page.evaluate(t => { setVault(t); setFrame('http://localhost:5173/vault/' + t); }, TOKEN);
await sleep(5000);
// the owner's phone takes over the heartbeat: stop the CLI pulse daemon, then open the paired phone page
try { execSync(`pkill -f "src/cli.ts pulse"`); } catch {}
fs.rmSync(D + '/pulse.pid', { force: true });
ev('cli_pulse_stopped');
await page.evaluate(u => setPhone(u), PAIR);
const dash = () => page.frames().find(f => f.url().includes(':5173/vault/'));
const phone = () => page.frames().find(f => f.url().includes(':5173/pulse'));
const ptext = async () => { const f = phone(); if (!f) return ''; try { return await f.evaluate(() => document.body.innerText); } catch { return ''; } };
const dtext = async () => { const f = dash(); if (!f) return ''; try { return await f.evaluate(() => document.body.innerText); } catch { return ''; } };
const ribbon = async () => { const f = dash(); if (!f) return ''; try { return await f.evaluate(() => { const s = document.querySelector('section.grid span.display.italic'); return s ? s.textContent.trim() : ''; }); } catch { return ''; } };
const beatsSent = async () => { const m = (await ptext()).match(/(\d+) beats? sent/); return m ? +m[1] : 0; };
const waitBeats = async (n, max = 120000) => { const t = Date.now(); while (Date.now() - t < max) { const k = await beatsSent(); if (k >= n) return k; await sleep(250); } return -1; };
// wait for the phone's first beat before recording
await waitBeats(1, 60000); ev('phone_first_beat');
await sleep(4000);

const cdp = await ctx.newCDPSession(page);
// frames go straight into ffmpeg as a constant 30 fps stream (latest frame repeated on each tick): no JPEGs on disk
const ff = spawn('/usr/local/bin/ffmpeg', ['-y', '-v', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '30', '-i', '-', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', '60', S + '/raw.mp4'], { stdio: ['pipe', 'inherit', 'inherit'] });
const ffDone = new Promise(r => ff.on('exit', c => r(c)));
let latest = null, rawT0 = null, written = 0, nFrames = 0;
cdp.on('Page.screencastFrame', async ({ data, sessionId }) => {
  latest = Buffer.from(data, 'base64'); nFrames++;
  if (rawT0 === null) { rawT0 = Date.now(); ev('raw_t0', { wall: rawT0 / 1000 }); }
  try { await cdp.send('Page.screencastFrameAck', { sessionId }); } catch {}
});
const tick = setInterval(() => { if (rawT0 === null) return; const due = Math.floor((Date.now() - rawT0) * 30 / 1000); while (written < due) { ff.stdin.write(latest); written++; } }, 8);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1920, maxHeight: 1080, everyNthFrame: 1 });
ev('record_start');

const scrollTo = async (which, ms = 1300) => {
  const f = dash(); if (!f) return;
  await f.evaluate(([which, ms]) => new Promise(res => {
    let y = 0;
    if (which !== 'top') { const h = [...document.querySelectorAll('h2')].find(h => h.textContent.trim() === which); if (h) y = h.closest('section').getBoundingClientRect().top + scrollY - 6; }
    const y0 = scrollY, t0 = performance.now(), e = t => 1 - Math.pow(1 - t, 5);
    const step = n => { const k = Math.min(1, (n - t0) / ms); window.scrollTo(0, y0 + (y - y0) * e(k)); k < 1 ? requestAnimationFrame(step) : res(); };
    requestAnimationFrame(step);
  }), [which, ms]);
  ev('scroll', { which });
};
const run = (cmd, args, out, cwd = REPO) => { const p = spawn(cmd, args, { cwd, env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' } }); const w = fs.createWriteStream(out, { flags: 'a' }); p.stdout.pipe(w); p.stderr.pipe(w); return new Promise(r => p.on('exit', c => r(c))); };

// beat watcher (phone beat count + dashboard last beat)
let lastBeats = await beatsSent();
const beatTimer = setInterval(async () => { const k = await beatsSent(); if (k > lastBeats) { lastBeats = k; ev('phone_beat', { n: k }); } }, 300);

// ---- Act I: alive, the phone beats
const b0 = lastBeats;
await waitBeats(b0 + 2); ev('two_beats');
await sleep(4000);

// ---- agent
ev('agent_start');
await page.evaluate(() => setRight('agent'));
await sleep(900);
await scrollTo('Agent');
await sleep(1500);
let c1 = await run('make', ['agent', `TOKEN=${TOKEN}`, 'BRAIN=scripted'], S + '/agent.out');
ev('agent_a_exit', { code: c1 });
await sleep(2500);
fs.appendFileSync(S + '/agent.out', '\n');
let c2 = await run('make', ['agent', `TOKEN=${TOKEN}`, 'BRAIN=scripted', 'ARGS=--no-local-checks --scenario scenarios/attack-only.json --out ../.demo/agent-transcript-b.md'], S + '/agent.out');
ev('agent_b_exit', { code: c2 });
for (let i = 0; i < 40; i++) { if (((await dtext()).match(/\bdenied\b/g) || []).length >= 2) break; await sleep(500); }
ev('agent_dash_rows');
await sleep(5000);

// ---- guardian
await scrollTo('top');
await page.evaluate(() => setRight('phone'));
ev('guardian_scene');
// pause right after a beat lands, so the pause is visible until the next beat clears it
let bb = lastBeats; await waitBeats(bb + 1); await sleep(2500);
ev('pause_send');
await run('node', ['contracts/tools/tx.mjs', 'call', GUARD, C, 'pause', JSON.stringify({ token_id: TOKEN }), '50'], S + '/pause.out');
ev('pause_done', { out: fs.readFileSync(S + '/pause.out', 'utf8').slice(-300) });
for (let i = 0; i < 40; i++) { if (/Paused\./.test(await dtext())) break; await sleep(250); }
ev('dash_paused');
// next phone beat clears the pause
bb = lastBeats; await waitBeats(bb + 1); ev('beat_after_pause');
for (let i = 0; i < 40; i++) { if (!/Paused\./.test(await dtext())) break; await sleep(250); }
ev('dash_unpaused');
await sleep(3000);

// ---- Act II: put the phone down (hold to stop, 2 s)
bb = lastBeats; await waitBeats(bb + 1); await sleep(3000);
await page.evaluate(() => setAct('II', 'Silence'));
const pf = phone();
const box = await pf.locator('button.hold').boundingBox();
ev('hold_start', { box });
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await sleep(2400);
await page.mouse.up();
ev('hold_end');
for (let i = 0; i < 20; i++) { if (/Stopped\./.test(await ptext())) break; await sleep(200); }
ev('phone_stopped');
clearInterval(beatTimer);

const st = {}; let actIII = false;
while (!st.Settled) {
  const r = await ribbon();
  if (r && !st[r]) { st[r] = true; ev('dash_state', { state: r }); }
  if (!actIII && events.some(e => e.name === 'kline' && /step 1\/5/.test(e.text))) { actIII = true; await page.evaluate(() => { setAct('III', 'Settlement'); setRight('keeper'); }); ev('act3'); }
  if (now() - T0 > 900) { ev('timeout'); break; }
  await sleep(300);
}
await sleep(10000);
const f = dash();
const info = await f.evaluate(() => { const img = document.querySelector('section.grid figure img'); const m = document.body.innerText.match(/Will passed to\s+(\S+?)\.?\s*$/m); return { src: img ? img.src : null, heir: m ? m[1] : null }; });
fs.writeFileSync(S + '/endinfo.json', JSON.stringify({ token: TOKEN, ...info }, null, 1));
ev('record_end');
await cdp.send('Page.stopScreencast');
await sleep(300); clearInterval(tick); ff.stdin.end(); const fc = await ffDone;
ev('raw_done', { code: fc, written, nFrames });
clearInterval(lineTimer);
await b.close();
console.log('DONE written', written, 'secs', (now() - T0).toFixed(0));
process.exit(0);
