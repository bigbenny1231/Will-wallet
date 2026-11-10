# Sound for the teaser: heartbeats that speed up, a riser, the flatline tone, six stamps, silence, one line, one last beat.
import numpy as np, wave, struct
SR = 48000; DUR = 10.6; N = int(SR * DUR)
t = np.arange(N) / SR
L = np.zeros(N); R = np.zeros(N)
rng = np.random.default_rng(42)

BEATS = [0.40, 1.15, 1.80, 2.35, 2.80, 3.15, 3.42, 3.64, 3.82, 3.96]
T_FLAT, T_TRIG, T_STEPS, STEP, T_SETTLED, T_END, T_LAST = 4.08, 4.50, 4.95, 0.45, 7.20, 7.65, 10.02

def add(sig, at, gain=1.0, pan=0.0):
    i = int(at * SR); n = min(len(sig), N - i)
    if n <= 0: return
    L[i:i+n] += sig[:n] * gain * (1 - max(0, pan)); R[i:i+n] += sig[:n] * gain * (1 + min(0, pan))

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

def thump(strength=1.0, bright=1.0):
    """One heart sound: a sub sweep you feel, harmonics a phone speaker can play, a soft skin click."""
    s = sweep(74, 40, 0.30, 0.070) * 1.0
    for part in (sweep(150, 82, 0.22, 0.045) * 0.55 * bright, sweep(300, 170, 0.12, 0.022) * 0.22 * bright,
                 lowpass(noise(0.03), 1800) * env(int(0.03 * SR), 0.006) * 0.9):
        s[:len(part)] += part
    return np.tanh(s * 1.6 * strength) * 0.85

def heartbeat(at, k=1.0, gain=1.0):
    add(thump(1.0), at, gain)                       # lub
    add(thump(0.8, 1.25), at + 0.115 * k, gain * 0.62)  # dub, a little higher

# I. the heart, faster and louder
for i, b in enumerate(BEATS):
    gap = (BEATS[i + 1] if i + 1 < len(BEATS) else T_FLAT) - b
    k = min(1.0, max(0.42, gap / 0.75))
    heartbeat(b, k, 0.70 + 0.045 * i)

# a riser under the last two seconds: filtered noise and a tone that climbs
r0, r1 = 2.1, T_FLAT; n = int((r1 - r0) * SR); x = np.arange(n) / n
ris = lowpass(noise(r1 - r0), 2600) * (x ** 2.4) * 0.34
f = 140 * (2 ** (x * 2.3)); ris += np.sin(2 * np.pi * np.cumsum(f) / SR) * (x ** 2.0) * 0.16
ris += np.sin(2 * np.pi * np.cumsum(f * 1.5) / SR) * (x ** 3.0) * 0.07
add(ris, r0, 1.0)

# II. the flatline: an impact, then the monitor tone
boom = sweep(70, 28, 1.1, 0.33) * 1.2
nb = lowpass(noise(0.6), 900) * env(int(0.6 * SR), 0.12) * 0.8; boom[:len(nb)] += nb
add(np.tanh(boom * 1.4), T_FLAT, 0.95)
n = int((T_SETTLED - T_FLAT) * SR); x = np.arange(n) / SR
tone = (np.sin(2 * np.pi * 880 * x) + 0.22 * np.sin(2 * np.pi * 1760 * x) + 0.08 * np.sin(2 * np.pi * 2640 * x)) * 0.115
tone *= np.minimum(1, x / 0.004) * np.minimum(1, (x[-1] - x) / 0.006)
add(tone, T_FLAT, 1.0)

# III. six stamps: a thud, a click, and a brass ping that climbs a step each time
def stamp(i):
    s = sweep(120, 48, 0.28, 0.060) * 1.0
    hi = noise(0.012)
    for part in (sweep(240, 120, 0.12, 0.028) * 0.4, (hi - lowpass(hi, 3000)) * env(int(0.012 * SR), 0.003) * 0.5):
        s[:len(part)] += part
    f = 660 * (2 ** (i / 6.0)); n = int(0.5 * SR); x = np.arange(n) / SR
    ping = (np.sin(2 * np.pi * f * x) + 0.5 * np.sin(2 * np.pi * f * 2.01 * x) + 0.25 * np.sin(2 * np.pi * f * 3.02 * x)) * env(n, 0.11) * 0.11
    out = np.zeros(max(len(s), n)); out[:len(s)] += np.tanh(s * 1.5) * 0.8; out[:n] += ping
    return out
add(stamp(0), T_TRIG, 0.85)
for i in range(5): add(stamp(i + 1), T_STEPS + i * STEP, 0.95, pan=(-0.25 + 0.125 * i))

# settled: one low close, then nothing
add(np.tanh(sweep(90, 36, 0.7, 0.16) * 1.3) * 0.7, T_SETTLED, 0.8)

# the end card: a low fifth under the voice, then the heart comes back once
n = int((DUR - T_END) * SR); x = np.arange(n) / SR
pad = (np.sin(2 * np.pi * 55 * x) + 0.6 * np.sin(2 * np.pi * 82.4 * x) + 0.45 * np.sin(2 * np.pi * 110 * x) + 0.2 * np.sin(2 * np.pi * 164.8 * x)) * 0.035
pad *= np.minimum(1, x / 0.9) * np.minimum(1, (x[-1] - x) / 0.35)
add(pad, T_END, 1.0)
heartbeat(T_LAST, 1.0, 1.0)
# a little room on the last beat
tail = np.zeros(N); i0 = int(T_LAST * SR)
for d, gdb in ((0.083, 0.30), (0.149, 0.20), (0.227, 0.12), (0.311, 0.07)):
    j = i0 + int(d * SR); m = N - j
    if m > 0: tail[j:] += lowpass(((L + R) / 2)[i0:i0 + m], 1400) * gdb
L += tail; R += tail

# the line
# vo.wav comes from vo.mp3:  ffmpeg -i vo.mp3 -af silenceremove=start_periods=1:start_threshold=-45dB -ar 48000 -ac 1 vo.wav
w = wave.open('vo.wav'); assert w.getframerate() == SR and w.getnchannels() == 1
vo = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').astype(float) / 32768
vo /= max(1e-9, np.max(np.abs(vo))); VO_AT = 7.55
vo = np.tanh(vo * 3.2) / np.tanh(3.2)      # gentle compression so the line carries on a phone speaker
add(vo, VO_AT, 0.92)

# master: soft clip, fades, peak at -1 dBFS
mix = np.stack([L, R]); mix = np.tanh(mix * 1.15)
mix[:, :int(0.01 * SR)] *= np.linspace(0, 1, int(0.01 * SR)); mix[:, -int(0.12 * SR):] *= np.linspace(1, 0, int(0.12 * SR))
mix *= 10 ** (-1 / 20) / np.max(np.abs(mix))
out = wave.open('teaser.wav', 'w'); out.setnchannels(2); out.setsampwidth(2); out.setframerate(SR)
out.writeframes((mix.T * 32767).astype('<i2').tobytes()); out.close()
print('wrote teaser.wav', DUR, 's, peak', round(float(np.max(np.abs(mix))), 3))
