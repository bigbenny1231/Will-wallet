// Cuts raw.mp4 to the edl.json map (exact frame counts per part), then overlays captions and speed marks in one
// pass. Port of v3/edit.mjs without v3's run-specific patches. env: S, FF; argv[2] = output mp4 (1920x1080)
import fs from 'node:fs'; import { execFileSync } from 'node:child_process';
const S = process.env.S || '/tmp/v4', FF = process.env.FF || 'ffmpeg', A = S + '/assets', P = S + '/parts';
const OUT = process.argv[2];
const { map, capT, speeds, TOTAL } = JSON.parse(fs.readFileSync(S + '/edl.json', 'utf8'));
const run = a => execFileSync(FF, ['-y', '-v', 'error', ...a], { stdio: 'inherit' });
const ENC = ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '12', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60', '-an'];
fs.rmSync(P, { recursive: true, force: true }); fs.mkdirSync(P);
map.forEach((m, i) => {
  const f = `${P}/${String(i).padStart(3, '0')}.mp4`;
  if (m.e[0] === 'card') { fs.copyFileSync(`${A}/${m.e[1]}.mp4`, f); return; }
  const [a, b, s] = m.e; const n = Math.max(1, Math.round(m.len * 30));
  run(['-ss', String(a), '-i', S + '/raw.mp4', '-t', String((b - a) + 0.5), '-vf', `setpts=(PTS-STARTPTS)/${s},fps=30,trim=end_frame=${n}`, ...ENC, f]);
});
fs.writeFileSync(S + '/parts.txt', map.map((m, i) => `file '${P}/${String(i).padStart(3, '0')}.mp4'`).join('\n') + '\n');
run(['-f', 'concat', '-safe', '0', '-i', S + '/parts.txt', '-c', 'copy', S + '/main.mp4']);
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
fc.push(`[${last}]format=yuv420p[vout]`);
run([...inputs, '-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000', '-filter_complex', fc.join(';'),
  '-map', '[vout]', '-map', `${k}:a`, '-t', TOTAL.toFixed(3),
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '18', '-pix_fmt', 'yuv420p', '-r', '30', '-g', '60',
  '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', OUT]);
console.log('final', OUT, TOTAL.toFixed(2), 's');
