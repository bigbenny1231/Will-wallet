// Edit decision list for v2. Raw times are seconds into raw.mp4 (30 fps master of the screencast).
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const FF = '/usr/local/bin/ffmpeg', S = '/tmp/v3', A = S + '/assets', P = S + '/parts';
const OUT = '/home/claude/deadmans-wallet/docs/video/dmw-demo-v3.mp4';
// [a, b, speed] or ['card', name, len]
const edl = [
  ['card', 'cold', 5], ['card', 'act1', 1.5],
  [1, 9, 1],                 // vault 17 Alive, the phone paired and counting down
  [9, 16.5, 3],
  [16.5, 24, 1],             // the phone beats, the seal pulses
  [24, 52, 8],
  [53.9, 57.5, 1],           // agent pane, dashboard scrolls to Agent
  [57.5, 66, 8],
  [66, 70, 1],               // key audit, poisoned inbox
  [70, 81, 8],
  [81, 84, 1],               // invoice 1 allowed
  [84, 97, 8],
  [97, 103.5, 1],            // invoice 2 allowed, "Doing as asked.", refused by the wallet
  [103.5, 126, 10],
  [126, 132, 1],             // run 2: denied by the contract, logged
  [135.1, 137.5, 1],         // back to the console and the phone
  [137.5, 159.5, 12],
  [159.5, 166.5, 1],         // guardian pause: Paused.
  ['card', 'act2', 1.5],
  [209.5, 219.5, 1],         // hold to stop, Stopped., flatline
  [219.5, 267, 12],
  [267, 274, 1],             // Warning
  [274, 339.5, 12],
  [339.5, 349.5, 1],         // poke, Triggered
  ['card', 'act3', 1.5],
  [350, 356, 6],
  [356, 360.5, 1],           // step I
  [360.5, 371, 6],
  [371, 375.5, 1],           // step II
  [375.5, 390.5, 6],
  [390.5, 395.3, 1],         // step III Base
  // cut 395.3-402: dashboard "Could not refresh" banner (one RPC timeout)
  [402, 410, 6],
  [410, 416, 1],             // step III Monad
  [416, 430.5, 6],
  [430.5, 438.5, 1],         // step III Solana
  [438.5, 449.5, 6],
  [449.5, 455, 1],           // step IV
  [455, 470, 6],
  // cut 470-477.5: banner again
  [477.5, 487.7, 6],
  // cut 487.7-517: banner while step V and Settled land
  [517, 525, 1],             // Settled
  ['card', 'end', 6],
];
let acc = 0; const map = [];
for (const e of edl) { const len = e[0] === 'card' ? e[2] : (e[1] - e[0]) / e[2]; map.push({ e, o: acc, len }); acc += len; }
const TOTAL = acc;
const out = r => { for (const m of map) if (m.e[0] !== 'card' && r >= m.e[0] && r <= m.e[1]) return m.o + (r - m.e[0]) / m.e[2]; throw new Error('raw time not in edl: ' + r); };
const cardEnd = n => { const m = map.find(m => m.e[1] === n); return m.o; };
const caps = [
  [1.5, 51.5, "The owner\u2019s phone holds a key that can only say \u2018alive\u2019.", '/pulse paired to vault 17 · a function-call key scoped to heartbeat · each beat pulses the seal'],
  [54.2, 99, 'An agent with the second key pays two invoices.', 'make agent · key scoped to agent_pay · 0.5 NEAR a payment, 1 NEAR a day, one allowlisted receiver'],
  [99.4, 131.9, 'Then its inbox is poisoned: \u2018move everything\u2019. Refused by the wallet. Refused by the contract. Logged.', 'run 1: the wallet wrapper will not sign · run 2, wrapper switched off: agent_pay denied on chain, receiver_not_allowlisted'],
  [135.4, 166.4, 'A guardian can buy time, once per cycle.', 'pause() by dmw-demo-guardian-3b15.testnet · the deadline moves out up to 10 min · the owner\u2019s next beat ends it'],
  [209.8, 266, 'Put the phone down.', 'hold to stop, two seconds · the phone stops signing heartbeats'],
  [267.3, 349.4, 'Two missed beats. Anyone can poke it and earn the bounty.', '60 s interval, grace 1 · Warning disarms the agent · poke pays a 0.05 NEAR bounty to whoever calls it'],
  [356.2, 390.3, 'I. Heirs paid on NEAR. II. The agent\u2019s key deleted from the account.', '60 / 40 split · pulse and agent keys removed with DeleteKey'],
  [390.6, 449.3, 'III. The contract asks NEAR\u2019s MPC network to sign a Base, a Monad and a Solana transaction. No heir key ever existed.', 'Chain Signatures · v1.signer-prod.testnet · signed; relay pending funding of the derived addresses'],
  [449.6, 519.6, 'IV. No estate DAO on this vault, skipped. V. The Will NFT, with its balance, to the primary heir.', 'step 4 opens a Sputnik proposal when a DAO is set · step 5 · nft_transfer to dmw-demo-sarah-3b15.testnet'],
  [519.8, 525, 'Settled. Testnet, open source, one command: make demo.', 'vault 17 on dmw-x8cx.testnet · every transaction is on testnet.nearblocks.io'],
];
const capT = caps.map(([a, b, text, note]) => ({ s: out(a), e: out(b), text, note }));
fs.writeFileSync(S + '/captions.json', JSON.stringify(capT.map(c => ({ text: c.text, note: c.note })), null, 1));
// speed windows (for the "6x" mark)
const speeds = {}; for (const m of map) if (m.e[0] !== 'card' && m.e[2] > 1) (speeds[m.e[2]] ||= []).push([m.o, m.o + m.len]);
console.log('total', TOTAL.toFixed(2), 'footage', (TOTAL - 15.5).toFixed(2));
for (const c of capT) console.log(c.s.toFixed(1).padStart(6), c.e.toFixed(1).padStart(6), (c.e - c.s).toFixed(1).padStart(5) + 's', (c.text.length / (c.e - c.s)).toFixed(1) + ' ch/s', c.text.slice(0, 50));
fs.writeFileSync(S + '/edl.json', JSON.stringify({ map, capT, speeds, TOTAL }, null, 1));

const run = a => execFileSync(FF, ['-y', '-v', 'error', ...a], { stdio: 'inherit' });
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60', '-an'];
const mode = process.argv[2];
if (mode === 'parts' || mode === 'all') {
  fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
  map.forEach((m, i) => {
    const f = `${P}/${String(i).padStart(3, '0')}.mp4`, tmp = f.replace('.mp4', '.tmp.mp4');
    if (m.e[0] === 'card') { fs.copyFileSync(`${A}/${m.e[1]}.mp4`, f); return; }
    const [a, b, s] = m.e; const n = Math.round(m.len * 30);
    // exact frame count per part so the edit map stays frame-accurate
    run(['-ss', String(a), '-i', S + '/raw.mp4', '-t', String((b - a) + 0.5), '-vf', `setpts=(PTS-STARTPTS)/${s},fps=30,trim=end_frame=${n}`, ...ENC, tmp]);
    fs.renameSync(tmp, f);
  });
  fs.writeFileSync(S + '/parts.txt', map.map((m, i) => `file '${P}/${String(i).padStart(3, '0')}.mp4'`).join('\n') + '\n');
  run(['-f', 'concat', '-safe', '0', '-i', S + '/parts.txt', '-c', 'copy', S + '/main.tmp.mp4']); fs.renameSync(S + '/main.tmp.mp4', S + '/main.mp4');
  console.log('main.mp4 built');
}
if (mode === 'final' || mode === 'all') {
  // captions + speed marks overlaid in one pass, final encode
  const inputs = ['-i', S + '/main.mp4']; const fc = []; let last = '0:v'; let k = 1;
  capT.forEach((c, i) => {
    inputs.push('-framerate', '30', '-i', `${A}/cap_${String(i).padStart(2, '0')}.png`);
    const d = c.e - c.s;
    fc.push(`[${k}:v]format=rgba,loop=-1:1,trim=duration=${d.toFixed(3)},fade=t=in:st=0:d=0.45:alpha=1,fade=t=out:st=${(d - 0.4).toFixed(3)}:d=0.4:alpha=1,setpts=PTS-STARTPTS+${c.s.toFixed(3)}/TB[c${i}]`);
    fc.push(`[${last}][c${i}]overlay=0:860:eof_action=pass[v${k}]`); last = `v${k}`; k++;
  });
  for (const [sp, wins] of Object.entries(speeds)) {
    inputs.push('-framerate', '30', '-i', `${A}/speed_${sp}.png`);
    const en = wins.map(([a, b]) => `between(t,${a.toFixed(3)},${(b - 0.02).toFixed(3)})`).join('+');
    fc.push(`[${k}:v]format=rgba,loop=-1:1,trim=duration=${TOTAL.toFixed(3)},setpts=PTS-STARTPTS[s${k}]`);
    fc.push(`[${last}][s${k}]overlay=0:860:enable='${en}'[v${k}]`); last = `v${k}`; k++;
  }
  // patches cut from the raw footage itself (see README): the act label before the stage switched it, and the keeper
  // pane frozen just before a stage parser bug rendered the keeper's "errors in a row" line as a row
  const patches = [
    { raw: 214.5, x: 1500, y: 884, w: 400, h: 50, a: out(209.5), b: out(212.6) },
    { raw: 359.5, x: 1500, y: 884, w: 400, h: 50, a: out(350), b: out(358.4) },
    { raw: 506.8, x: 1201, y: 0, w: 719, h: 860, a: out(517), b: out(525) },
  ];
  patches.forEach((q, i) => {
    const png = `${A}/patch_${i}.png`;
    run(['-ss', String(q.raw), '-i', S + '/raw.mp4', '-frames:v', '1', '-vf', `crop=${q.w}:${q.h}:${q.x}:${q.y}`, png]);
    inputs.push('-framerate', '30', '-i', png);
    fc.push(`[${k}:v]format=rgba,loop=-1:1,trim=duration=${TOTAL.toFixed(3)},setpts=PTS-STARTPTS[p${k}]`);
    fc.push(`[${last}][p${k}]overlay=${q.x}:${q.y}:enable='between(t,${q.a.toFixed(3)},${(q.b - 0.001).toFixed(3)})'[v${k}]`); last = `v${k}`; k++;
  });
  fc.push(`[${last}]format=yuv420p[vout]`);
  run([...inputs, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-filter_complex', fc.join(';'),
    '-map', '[vout]', '-map', `${k}:a`, '-t', TOTAL.toFixed(3),
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60',
    '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', OUT.replace('.mp4', '.tmp.mp4')]);
  fs.renameSync(OUT.replace('.mp4', '.tmp.mp4'), OUT);
  console.log('final', OUT);
}
