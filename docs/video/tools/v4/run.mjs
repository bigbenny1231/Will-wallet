// v4 demo recording: drives the whole run with no manual steps and records the 1920x1080 stage as a constant 30 fps
// stream into raw.mp4. Same scenes as v3 (phone pulse, agent with a poisoned inbox, guardian pause, hold to stop,
// keeper to Settled); every moment the editor needs is written to events.json, so the cut is made from the events
// (autoedl.mjs) and not from hand-picked raw times.
//
//   node run.mjs        (record.sh runs it after setup.sh; env: REPO, S, FF, PW_MODULE, DMW_CONTRACT)
import fs from 'node:fs'; import { spawn, execSync } from 'node:child_process';
const { chromium } = await import(process.env.PW_MODULE || 'playwright');
const REPO = process.env.REPO, S = process.env.S || '/tmp/v4', FF = process.env.FF || 'ffmpeg', D = REPO + '/.demo';
const C = process.env.DMW_CONTRACT;
const TOKEN = fs.readFileSync(D + '/vault_id', 'utf8').trim();
const GUARD = `dmw-demo-guardian-${fs.readFileSync(D + '/suffix', 'utf8').trim()}.testnet`;
const PAIR = fs.readFileSync(S + '/pairing.url', 'utf8').trim();
const sleep = ms => new Promise(r => setTimeout(r, ms));
const T0 = Date.now() / 1000; const now = () => Date.now() / 1000;
const events = [];
const ev = (name, extra = {}) => {
  events.push({ t: now(), name, ...extra });
  const shown = name === 'kline' || name === 'aline' ? JSON.stringify(extra).slice(0, 120) : JSON.stringify(extra);
  console.log(new Date().toISOString().slice(11, 19), name, shown);
  fs.writeFileSync(S + '/events.json', JSON.stringify(events, null, 1));
};
fs.writeFileSync(S + '/agent.out', '');

// keeper log watcher
let kseen = 0;
const lineTimer = setInterval(() => {
  let t = ''; try { t = fs.readFileSync(D + '/keeper.log', 'utf8'); } catch { return; }
  const ls = t.split('\n').filter(x => x.trim());
  for (let i = kseen; i < ls.length; i++) ev('kline', { text: ls[i].replace(/\x1b\[[0-9;]*m/g, '').slice(0, 160) });
  kseen = Math.max(kseen, ls.length);
}, 250);
// agent transcript watcher: one event per line the stage turns into a ledger row
let aseen = 0;
const AKIND = [
  [/^\*\*Key audit passed\.\*\*/, 'audit'], [/^\*\*result:\*\* \d+ messages?/, 'inbox'], [/^- `msg-\d+` from \S+: URGENT/, 'inj'],
  [/^> \*\*thought:\*\* msg-\d+ is from the CEO/, 'thought'], [/^\*\*payment:\*\*/, 'payment'],
  [/^\| 1\. wallet wrapper \(local\) \| \*\*refused_locally/, 'refused'], [/^\| 2\. contract \(on-chain\) \| \*\*allowed\*\*/, 'allowed'],
  [/^\| 2\. contract \(on-chain\) \| \*\*denied/, 'denied'], [/^## Result/, 'result'],
];
const agentTimer = setInterval(() => {
  let t = ''; try { t = fs.readFileSync(S + '/agent.out', 'utf8'); } catch { return; }
  const ls = t.split('\n');
  for (let i = aseen; i < ls.length - 1; i++) { const l = ls[i].trim(); const k = AKIND.find(([re]) => re.test(l)); if (k) ev('aline', { kind: k[1] }); }
  aseen = Math.max(aseen, ls.length - 1);
}, 200);

const b = await chromium.launch({ args: ['--hide-scrollbars'] });
const ctx = await b.newContext({ viewport: { width: 1920, height: 1080 }, timezoneId: 'UTC', locale: 'en-GB' });
const page = await ctx.newPage();
await page.goto('http://localhost:5057/?c=' + encodeURIComponent(C));
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
await waitBeats(1, 90000); ev('phone_first_beat');
await sleep(4000);

const cdp = await ctx.newCDPSession(page);
// frames go straight into ffmpeg as a constant 30 fps stream (latest frame repeated on each tick)
const ff = spawn(FF, ['-y', '-v', 'error', '-f', 'image2pipe', '-c:v', 'mjpeg', '-framerate', '30', '-i', '-', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '14', '-pix_fmt', 'yuv420p', '-g', '60', S + '/raw.mp4'], { stdio: ['pipe', 'inherit', 'inherit'] });
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

// dashboard RPC trouble banners: cut from the edit
let banner = false;
const bannerTimer = setInterval(async () => {
  const on = /Could not refresh|Reconnecting\./.test(await dtext());
  if (on !== banner) { banner = on; ev(on ? 'banner_on' : 'banner_off'); }
}, 300);

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
const c1 = await run('make', ['agent', `TOKEN=${TOKEN}`, 'BRAIN=scripted'], S + '/agent.out');
ev('agent_a_exit', { code: c1 });
await sleep(2500);
fs.appendFileSync(S + '/agent.out', '\n');
const c2 = await run('make', ['agent', `TOKEN=${TOKEN}`, 'BRAIN=scripted', 'ARGS=--no-local-checks --scenario scenarios/attack-only.json --out ../.demo/agent-transcript-b.md'], S + '/agent.out');
ev('agent_b_exit', { code: c2 });
for (let i = 0; i < 40; i++) { if (((await dtext()).match(/\bdenied\b/g) || []).length >= 2) break; await sleep(500); }
ev('agent_dash_rows');
await sleep(5000);

// ---- guardian
await scrollTo('top');
await page.evaluate(() => setRight('phone'));
ev('guardian_scene');
let bb = lastBeats; await waitBeats(bb + 1); await sleep(2500);
ev('pause_send');
await run('node', ['contracts/tools/tx.mjs', 'call', GUARD, C, 'pause', JSON.stringify({ token_id: TOKEN }), '50', '1y'], S + '/pause.out');
ev('pause_done', { out: fs.readFileSync(S + '/pause.out', 'utf8').slice(-300) });
for (let i = 0; i < 40; i++) { if (/Paused\./.test(await dtext())) break; await sleep(250); }
ev('dash_paused');
bb = lastBeats; await waitBeats(bb + 1); ev('beat_after_pause');
for (let i = 0; i < 40; i++) { if (!/Paused\./.test(await dtext())) break; await sleep(250); }
ev('dash_unpaused');
await sleep(3000);

// ---- Act II: put the phone down (hold to stop, 2.4 s). The act label switches before the hold, so the act card
// that the edit puts in front of the hold never meets a stale label (a v3 patch).
await page.evaluate(() => setAct('II', 'Silence')); ev('act2');
bb = lastBeats; await waitBeats(bb + 1); await sleep(3000);
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
  // act III (label and keeper pane) starts at the trigger, before step I, so the act card meets the right label
  if (!actIII && (st.Triggered || events.some(e => e.name === 'kline' && /step 1\/5|poke/.test(e.text)))) { actIII = true; await page.evaluate(() => { setAct('III', 'Settlement'); setRight('keeper'); }); ev('act3'); }
  if (now() - T0 > 1200) { ev('timeout'); break; }
  await sleep(300);
}
await sleep(10000);
const f = dash();
const info = await f.evaluate(() => { const img = document.querySelector('section.grid figure img'); const m = document.body.innerText.match(/Will passed to\s+(\S+?)\.?\s*$/m); return { src: img ? img.src : null, heir: m ? m[1] : null }; });
fs.writeFileSync(S + '/endinfo.json', JSON.stringify({ token: TOKEN, contract: C, guardian: GUARD, ...info }, null, 1));
ev('record_end');
await cdp.send('Page.stopScreencast');
await sleep(300); clearInterval(tick); clearInterval(bannerTimer); ff.stdin.end(); const fc = await ffDone;
ev('raw_done', { code: fc, written, nFrames });
clearInterval(lineTimer); clearInterval(agentTimer);
await b.close();
console.log('DONE written', written, 'frames from the browser', nFrames, 'secs', (now() - T0).toFixed(0));
process.exit(st.Settled && fc === 0 ? 0 : 1);
