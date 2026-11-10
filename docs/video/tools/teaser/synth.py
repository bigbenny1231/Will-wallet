# Teaser sound: one deep voice, three lines, over continuous music. The picture is cut to these words
# (vo/timeline.json is built from the voice's word timings). ElevenLabs music (a composed build and hit), ElevenLabs riser, impact and closing chord,
# an ElevenLabs voice for both lines, and the synthesised heart, monitor tone and stamps that are cut to the picture.
# usage: python3 synth.py vo teaser.wav      vo/ holds timeline.json, align.json and a.mp3, b.mp3, c.mp3 (build.py)
import numpy as np, wave, subprocess, sys
VOICE, OUT = sys.argv[1], sys.argv[2]
import json
TL = json.load(open(f'{VOICE}/timeline.json'))
SR = 48000; DUR = TL['DUR']; N = int(SR * DUR)
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(42)
BEATS = TL['BEATS']
T_FLAT, T_TRIG, T_STEPS, STEP, T_SETTLED, T_END, T_LAST = (TL[k] for k in ('T_FLAT', 'T_TRIG', 'T_STEPS', 'STEP', 'T_SETTLED', 'T_END', 'T_LAST'))

def load(path, ch=2):
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', path, '-ac', str(ch), '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
    a = np.frombuffer(raw, dtype='<f4').astype(float)
    return a.reshape(-1, ch).T if ch == 2 else a
def put(sig, at, gain=1.0):
    """sig: mono (n,) or stereo (2,n). gain: scalar or per-sample array."""
    s = np.stack([sig, sig]) if sig.ndim == 1 else sig
    i = int(round(at * SR)); j0 = max(0, -i); i = max(0, i); n = min(s.shape[1] - j0, N - i)
    if n <= 0: return
    g = gain[j0:j0 + n] if hasattr(gain, '__len__') else gain
    L[i:i + n] += s[0, j0:j0 + n] * g; R[i:i + n] += s[1, j0:j0 + n] * g
def env(n, tau): return np.exp(-np.arange(n) / (tau * SR))
def sweep(f0, f1, dur, tau):
    n = int(dur * SR); x = np.arange(n) / SR
    f = f1 + (f0 - f1) * np.exp(-x / (dur * 0.25))
    return np.sin(2 * np.pi * np.cumsum(f) / SR) * env(n, tau)
def lowpass(x, fc):
    a = np.exp(-2 * np.pi * fc / SR); y = np.empty_like(x); acc = 0.0
    for i, v in enumerate(x): acc = (1 - a) * v + a * acc; y[i] = acc
    return y
def noise(dur): return rng.standard_normal(int(dur * SR))
def ramp(n, a, b, p=1.0): return a + (b - a) * (np.linspace(0, 1, n) ** p)
def fades(n, fin, fout):
    g = np.ones(n); a = int(fin * SR); b = int(fout * SR)
    if a: g[:a] *= np.linspace(0, 1, a)
    if b: g[-b:] *= np.linspace(1, 0, b)
    return g
def rms(x): return float(np.sqrt(np.mean(x ** 2)) + 1e-12)

# ---------- the heart, the tone and the stamps (synthesised, cut to the frames) ----------
def thump(strength=1.0, bright=1.0):
    s = sweep(74, 40, 0.30, 0.070)
    for part in (sweep(150, 82, 0.22, 0.045) * 0.55 * bright, sweep(300, 170, 0.12, 0.022) * 0.22 * bright,
                 lowpass(noise(0.03), 1800) * env(int(0.03 * SR), 0.006) * 0.9):
        s[:len(part)] += part
    return np.tanh(s * 1.6 * strength) * 0.85
def heartbeat(at, k=1.0, gain=1.0):
    put(thump(1.0), at, gain); put(thump(0.8, 1.25), at + 0.115 * k, gain * 0.62)
for i, b in enumerate(BEATS):
    gap = (BEATS[i + 1] if i + 1 < len(BEATS) else T_FLAT) - b
    heartbeat(b, min(1.0, max(0.42, gap / 0.75)), 0.58 + 0.05 * i)

n = int((T_SETTLED - T_FLAT) * SR); x = np.arange(n) / SR
tone = (np.sin(2 * np.pi * 880 * x) + 0.22 * np.sin(2 * np.pi * 1760 * x) + 0.08 * np.sin(2 * np.pi * 2640 * x)) * 0.085
put(tone * np.minimum(1, x / 0.004) * np.minimum(1, (x[-1] - x) / 0.006), T_FLAT)

def stamp(i):
    s = sweep(120, 48, 0.28, 0.060); hi = noise(0.012)
    for part in (sweep(240, 120, 0.12, 0.028) * 0.4, (hi - lowpass(hi, 3000)) * env(int(0.012 * SR), 0.003) * 0.5):
        s[:len(part)] += part
    f = 660 * (2 ** (i / 6.0)); m = int(0.5 * SR); xx = np.arange(m) / SR
    ping = (np.sin(2 * np.pi * f * xx) + 0.5 * np.sin(2 * np.pi * f * 2.01 * xx) + 0.25 * np.sin(2 * np.pi * f * 3.02 * xx)) * env(m, 0.11) * 0.11
    out = np.zeros(max(len(s), m)); out[:len(s)] += np.tanh(s * 1.5) * 0.8; out[:m] += ping
    return out
for i in range(5): put(stamp(i + 1), T_STEPS + i * STEP, 0.9)
put(np.tanh(sweep(90, 36, 0.45, 0.085) * 1.3) * 0.7, T_SETTLED, 0.7)

# ---------- ElevenLabs music: the composed cue, placed so its hit lands on the flatline ----------
cue = load('el/cueA.mp3'); mono = cue.mean(axis=0); hop = int(0.005 * SR)
lv = np.array([rms(mono[i:i + hop * 4]) for i in range(0, len(mono) - hop * 4, hop)])
lo, hi_ = int(9.0 / 0.005), int(12.5 / 0.005)
# the cue's own impact: the first moment the level stands well clear of the second before it
hit = None
for q in range(lo, hi_):
    if lv[q] > 2.6 * np.median(lv[q - 200:q - 4]): hit = q * 0.005; break
assert hit is not None, 'no impact found in the cue'
off = hit - T_FLAT
seg = cue[:, int(off * SR):int((off + T_SETTLED) * SR)]
m = seg.shape[1]; k = int(T_FLAT * SR)
pre_gain = 0.085 / rms(seg[:, int(2.0 * SR):k].mean(axis=0))      # the build sits at a set level, then swells
g = np.ones(m)
g[:k] = ramp(k, 0.55, 1.7, 1.6) * pre_gain
post = 0.40 / max(np.max(np.abs(seg[:, k:k + SR])), 1e-6)            # the hit peaks at a set level
g[k:] = post * ramp(m - k, 1.0, 0.55)
g *= fades(m, 0.35, 0.05)
put(seg, 0.0, g)
print(f'cue hit found at {hit:.3f} s of the cue; cue offset {off:.3f} s')

# ElevenLabs riser: its last moment lands on the flatline
ris = load('el/sfx_riser.mp3'); rm = ris.mean(axis=0); rl = np.array([rms(rm[i:i + 480]) for i in range(0, len(rm) - 480, 480)])
rend = (int(np.max(np.nonzero(rl > rl.max() * 0.1)[0])) + 1) * 0.01
ris = ris[:, :int(rend * SR)]; ris = ris / np.max(np.abs(ris))
put(ris * fades(ris.shape[1], 0.05, 0.004), T_FLAT - rend, 0.34)
# ElevenLabs impact on the flatline, out before "Settled."
hitS = load('el/sfx_hit.mp3'); hitS = hitS / np.max(np.abs(hitS))
hm = min(hitS.shape[1], int((T_SETTLED - T_FLAT) * SR)); put(hitS[:, :hm] * fades(hm, 0.0, 0.25), T_FLAT, 0.62)
# ElevenLabs chord under the end card
ch = load('el/sfx_chord.mp3'); ch = ch / np.max(np.abs(ch)); cm = min(ch.shape[1], int((DUR - T_END) * SR))
put(ch[:, :cm] * fades(cm, 0.25, 0.5), T_END - 0.03, 0.50)

# the heart comes back once, with a little room
heartbeat(T_LAST, 1.0, 0.95)
tail = np.zeros(N); i0 = int(T_LAST * SR); dry = (L + R) / 2
for d, gg in ((0.083, 0.30), (0.149, 0.20), (0.227, 0.12), (0.311, 0.07)):
    j = i0 + int(d * SR); mm = N - j
    if mm > 0: tail[j:] += lowpass(dry[i0:i0 + mm], 1400) * gg
L += tail; R += tail

# ---------- the bed is finished here: saturate it on its own, so the voice never passes through it ----------
bed = np.tanh(np.stack([L, R]) * 1.1); bed *= 0.72 / np.max(np.abs(bed))

# ---------- the voice: one deep, serious voice, three lines, clean ----------
al = json.load(open(f'{VOICE}/align.json'))
def duck(a, b, depth):
    i, j = max(0, int(a * SR)), min(N, int(b * SR)); f = int(0.10 * SR); g = np.ones(N)
    g[i:j] = depth; g[max(0, i - f):i] = np.linspace(1, depth, i - max(0, i - f)); g[j:min(N, j + f)] = np.linspace(depth, 1, min(N, j + f) - j)
    bed[:] *= g
def line(key):
    # a low voice over a low bed: rumble out below the voice, even compression, a little presence so the words cut through
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', f'{VOICE}/{key}.mp3', '-af', 'highpass=f=55,acompressor=threshold=-20dB:ratio=3:attack=6:release=140:makeup=2,equalizer=f=2800:t=q:w=1.1:g=2.5', '-ac', '1', '-ar', str(SR), '-f', 'f32le', '-'], capture_output=True).stdout
    a = np.frombuffer(raw, dtype='<f4').astype(float); end = al[key]['end']
    w = int(0.05 * SR); fr = np.array([rms(a[i:i + w]) for i in range(0, len(a) - w, w)])
    a = a * (0.17 / np.sqrt(np.mean(fr[fr > fr.max() * 0.15] ** 2)))
    return a[:int((end + 0.3) * SR)], end
voice = np.zeros(N)
for key in ('a', 'b', 'c'):
    a, end = line(key); at = TL['VO'][key]
    duck(at, at + end, 0.75 if key == 'c' else 0.42)
    i = int(at * SR); n = min(len(a), N - i); voice[i:i + n] += a[:n] * 1.2
    print(f'  line {key}: {at:5.2f} to {at + end:5.2f} s')
mix = bed + np.stack([voice, voice])
mix[:, :int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR)); mix[:, -int(0.15 * SR):] *= np.linspace(1, 0, int(0.15 * SR))
subprocess.run(['ffmpeg', '-y', '-v', 'error', '-f', 'f32le', '-ar', str(SR), '-ac', '2', '-i', '-', '-af', 'alimiter=limit=0.80:attack=4:release=80:level=disabled', '-c:a', 'pcm_s16le', OUT], input=mix.T.astype('<f4').tobytes())
bm = bed.mean(axis=0)
for a, b, name in ((0.0, TL['VO']['a'], 'open: music and heart'), (TL['VO']['a'], TL['VO']['a'] + al['a']['end'], 'line 1'), (TL['VO']['b'], TL['VO']['b'] + al['b']['end'], 'line 2'), (TL['VO']['c'], TL['VO']['c'] + al['c']['end'], 'tagline')):
    v = voice[int(a * SR):int(b * SR)]; bb = bm[int(a * SR):int(b * SR)]
    print(f"  {name:22s} voice {20 * np.log10(rms(v)):7.1f} dB   bed {20 * np.log10(rms(bb)):6.1f} dB")
