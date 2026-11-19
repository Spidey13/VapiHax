"""Soft UI sound synth for the Branch Voice launch film.

Every function returns (signal, peak_index): signal is float32 stereo shaped (n, 2) at 48 kHz,
peak_index is the sample of the sound's own absolute peak (mix.py puts that sample on cue.t).
Everything is deterministic: variants come from a seed, never from global randomness.
Tonal sounds take key=(tonic, mode) and pick notes from that key's pentatonic scale (default D major).
"""
import numpy as np
from scipy import signal as sg

SR = 48000
NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
DEFAULT_KEY = ('D', 'major')
PENT = {'major': [0, 2, 4, 7, 9], 'minor': [0, 3, 5, 7, 10]}

# native peak levels (cue gain multiplies these): ticks sit >= 20 dB under the notes at cue gains 0.12-0.2 vs 0.8+
LEVEL = dict(tick=0.35, press=0.45, release=0.30, glass=0.80, fork=0.80, fix=0.30, back=0.25,
             compare=0.70, merge=0.85, settle=0.30, metro=0.30, metro_accent=0.42)


# ---------- helpers ----------
def _t(dur):
    return np.arange(int(dur * SR)) / SR


def _rng(seed):
    return np.random.default_rng(int(seed) + 7919)


def _band(x, lo, hi, order=2):
    nyq = SR / 2
    if lo and hi:
        sos = sg.butter(order, [lo / nyq, hi / nyq], 'bandpass', output='sos')
    elif hi:
        sos = sg.butter(order, hi / nyq, 'lowpass', output='sos')
    else:
        sos = sg.butter(order, lo / nyq, 'highpass', output='sos')
    return sg.sosfilt(sos, x)


def _pan_gains(pan):
    th = (np.clip(pan, -1, 1) + 1) * np.pi / 4  # constant power
    return np.cos(th), np.sin(th)


def _stereo(mono, pan=0.0):
    gl, gr = _pan_gains(pan)
    return np.stack([mono * gl * np.sqrt(2), mono * gr * np.sqrt(2)], axis=1)


def _stereo_pan_env(mono, pan_env):
    th = (np.clip(pan_env, -1, 1) + 1) * np.pi / 4
    return np.stack([mono * np.cos(th) * np.sqrt(2), mono * np.sin(th) * np.sqrt(2)], axis=1)


def _fit(sig, level):
    """Scale so the absolute peak equals `level`; return (sig, peak_index)."""
    a = np.max(np.abs(sig), axis=1)
    i = int(np.argmax(a))
    sig = sig * (level / max(a[i], 1e-9))
    return sig.astype(np.float32), i


def _verb(sig, mix=0.12, tail=0.45, seed=3):
    """Tiny dark room: exponentially decaying noise IR, low-passed. Adds air, not echo."""
    n = int(tail * SR)
    t = np.arange(n) / SR
    out = []
    for ch in range(2):
        r = _rng(seed + ch).standard_normal(n) * np.exp(-t / (tail / 5.5))
        r = _band(r, None, 3800)
        r[0] = 0
        r /= np.sqrt(np.sum(r ** 2)) + 1e-9
        out.append(sg.fftconvolve(sig[:, ch], r)[:len(sig)])
    wet = np.stack(out, axis=1)
    return sig * (1 - mix * 0.5) + wet * mix * 2.2


def _pad(sig, n):
    if len(sig) >= n:
        return sig[:n]
    return np.concatenate([sig, np.zeros((n - len(sig), 2))])


def _scale(key):
    tonic, mode = key if key else DEFAULT_KEY
    mode = 'minor' if mode == 'minor' else 'major'
    pc = NAMES.index(tonic) if isinstance(tonic, str) else int(tonic) % 12
    return pc, PENT[mode]


def note_hz(note, key=None, octave=5):
    """note = scale-degree index in the key's pentatonic (0 = tonic of `octave`, 5 = octave above, -1 = below)."""
    pc, deg = _scale(key)
    oct_, d = divmod(int(note), 5)
    midi = 12 * (octave + 1) + pc + deg[d] + 12 * oct_
    return 440.0 * 2 ** ((midi - 69) / 12)


def tonic_hz(key=None, octave=5):
    return note_hz(0, key, octave)


# ---------- glass partial voice ----------
_RAT = np.array([1.0, 2.76, 5.40, 8.93])
_AMP = np.array([1.0, 0.34, 0.14, 0.05])
_DEC = np.array([1.0, 0.55, 0.30, 0.18])  # higher partials die faster


def _glass_voice(f0_t, dur, decay=1.2, attack=0.004, chorus=0.0025):
    """Inharmonic soft bell. f0_t: scalar or per-sample fundamental (Hz). Returns mono."""
    n = int(dur * SR)
    t = np.arange(n) / SR
    f0 = np.broadcast_to(np.asarray(f0_t, float), (n,))
    env_a = np.where(t < attack, 0.5 - 0.5 * np.cos(np.pi * np.clip(t / attack, 0, 1)), 1.0)
    out = np.zeros(n)
    for detune in (-chorus, chorus):  # slight chorus: two copies a few cents apart
        for r, a, d in zip(_RAT, _AMP, _DEC):
            ph = 2 * np.pi * np.cumsum(f0 * r * (1 + detune)) / SR
            out += a * np.sin(ph) * np.exp(-t / (decay * d / 4.6)) * 0.5
    return out * env_a


def _glass_mono(freq, dur, decay=1.2):
    return _glass_voice(freq, dur, decay)


# ---------- the sounds ----------
def tick(seed=0):
    """Very soft word tick: ~6 ms of band-passed noise plus a tiny sine body. Seed varies centre/body slightly."""
    r = _rng(seed)
    n = int(0.05 * SR)
    t = np.arange(n) / SR
    cf = 3200 * (1 + 0.18 * (r.random() - 0.5))
    noise = _band(r.standard_normal(n), cf * 0.6, cf * 1.5) * np.exp(-t / 0.0016)
    bf = 1050 * (1 + 0.22 * (r.random() - 0.5))
    body = np.sin(2 * np.pi * bf * t) * np.exp(-t / 0.0045) * 0.55
    x = _band(noise + body, None, 7000)
    x = np.concatenate([np.zeros(int(0.002 * SR)), x])
    x = x * np.minimum(1, np.arange(len(x)) / (0.0006 * SR + 1) + 0.0)  # no hard edge
    return _fit(_stereo(x, (r.random() - 0.5) * 0.12), LEVEL['tick'])


def press(seed=0):
    """Soft trackpad down-click: low thock plus a dull noise edge."""
    r = _rng(seed + 31)
    n = int(0.09 * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * (170 + 60 * np.exp(-t / 0.008)) * t) * np.exp(-t / 0.014)
    edge = _band(r.standard_normal(n), 900, 3000) * np.exp(-t / 0.0035) * 0.9
    x = _band(body + edge, 60, 5000)
    return _fit(_stereo(x), LEVEL['press'])


def release(seed=0):
    """Up-click: smaller, higher and shorter than press."""
    r = _rng(seed + 57)
    n = int(0.07 * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * 260 * t) * np.exp(-t / 0.008)
    edge = _band(r.standard_normal(n), 1500, 4500) * np.exp(-t / 0.0022) * 0.8
    x = _band(body * 0.7 + edge, 90, 6000)
    return _fit(_stereo(x), LEVEL['release'])


def glass(note=0, key=None, pan=0.0, octave=5, decay=1.2):
    """Soft glass/bell tone, ~4 ms attack, ~1.2 s decay, gentle chorus."""
    f = note_hz(note, key, octave)
    m = _glass_mono(f, 1.9, decay)
    x = _verb(_stereo(m, pan), 0.10)
    x = _band(x.T, None, 9000).T
    return _fit(x, LEVEL['glass'])


def fork(key=None):
    """One glass note that splits in two: voices drift to -0.6 / +0.6, one glides up a fifth, over ~0.5 s."""
    f = note_hz(0, key, 5)
    n = int(2.0 * SR)
    t = np.arange(n) / SR
    k = np.clip(t / 0.5, 0, 1)
    sm = k * k * (3 - 2 * k)  # smoothstep
    fb = f * (1 + (1.5 - 1) * sm)  # unison -> perfect fifth
    fa = f * (1 - 0.0 * sm)
    va = _glass_voice(fa, 2.0, 1.2)
    vb = _glass_voice(fb, 2.0, 1.2) * (0.55 + 0.0 * sm)
    a = _stereo_pan_env(va * 0.8, -0.6 * sm)
    b = _stereo_pan_env(vb, 0.6 * sm)
    x = _verb(a + b, 0.10)
    x = _band(x.T, None, 9000).T
    return _fit(x, LEVEL['fork'])


def fix(seed=0):
    """Felt-damped tick: dull and short, no tonal tail."""
    r = _rng(seed + 101)
    n = int(0.05 * SR)
    t = np.arange(n) / SR
    body = np.sin(2 * np.pi * 420 * t) * np.exp(-t / 0.006)
    nz = _band(r.standard_normal(n), 700, 2200) * np.exp(-t / 0.003) * 0.8
    x = _band(body + nz, None, 2600, 3)
    x = np.concatenate([np.zeros(int(0.002 * SR)), x])
    return _fit(_stereo(x), LEVEL['fix'])


def back():
    """Soft low air: band-passed noise swell, ~0.8 s, very quiet. Crest at ~0.28 s."""
    r = _rng(404)
    n = int(1.0 * SR)
    t = np.arange(n) / SR
    rise, fall = 0.28, 0.5
    env = np.where(t < rise, np.sin(0.5 * np.pi * t / rise) ** 2, np.exp(-(t - rise) / (fall / 3)))
    env *= np.clip((0.95 - t) / 0.15, 0, 1)
    # sweep the band downward a touch: the air "goes back"
    x = _band(r.standard_normal(n), 140, 700, 2) * env
    y = _band(r.standard_normal(n), 140, 380, 2) * env * (t / 1.0)
    st = np.stack([x + y * 0.5, np.roll(x, 90) + y * 0.5], axis=1)  # decorrelated width
    return _fit(st, LEVEL['back'])


def compare(key=None):
    """Two soft glass notes, one left, one right, 60 ms apart (a fifth apart)."""
    n = int(2.2 * SR)
    x = np.zeros((n, 2))
    for i, (deg, pan, amp) in enumerate([(0, -0.8, 1.0), (4, 0.8, 0.88)]):
        m = _glass_mono(note_hz(deg, key, 5), 1.9, 1.1) * amp
        s = _stereo(m, pan)
        o = int(0.06 * SR * i)
        x[o:o + len(s)] += s[:n - o]
    x = _verb(x, 0.10)
    x = _band(x.T, None, 9000).T
    return _fit(x, LEVEL['compare'])


def merge(key=None):
    """Two notes L/R glide toward each other in pitch and pan, then resolve to one centred note with a bloom.
    Peak (cue point) is the resolve at 1.0 s."""
    f1 = note_hz(2, key, 5)   # third
    f2 = note_hz(3, key, 5)   # fifth
    ft = note_hz(0, key, 5)   # resolves to the tonic
    n = int(3.0 * SR)
    t = np.arange(n) / SR
    g = 1.0
    k = np.clip(t / g, 0, 1)
    sm = k * k * (3 - 2 * k)
    fa = f1 + (ft - f1) * sm
    fb = f2 + (ft * 1.0 - f2) * sm
    fb = np.where(t < g, fb, ft)
    fa = np.where(t < g, fa, ft)
    swell = np.minimum(1, t / 0.35) ** 2 * np.where(t < g, 1.0, np.exp(-(t - g) / 0.18))
    swell *= 0.45
    glide = np.zeros((n, 2))
    for f, p0 in ((fa, -0.75), (fb, 0.75)):
        ph = 2 * np.pi * np.cumsum(f) / SR
        v = (np.sin(ph) + 0.25 * np.sin(2 * ph) * 0.7 + 0.1 * np.sin(2.76 * ph)) * swell
        glide += _stereo_pan_env(v, p0 * (1 - sm))
    # bloom: tonic glass + octave shimmer + a low soft root, 4 ms attack, long decay
    nb = int(2.0 * SR)
    bloom_m = _glass_mono(ft, 2.0, 1.5) + 0.35 * _glass_mono(ft * 2, 2.0, 1.1) + 0.3 * _glass_mono(ft / 2, 2.0, 1.3)
    bloom = _stereo(bloom_m, 0.0) * 0.9
    o = int(g * SR)
    x = glide.copy()
    x[o:o + nb] += bloom[:n - o]
    x = _verb(x, 0.14, 0.6)
    x = _band(x.T, None, 9000).T
    # fit so the bloom (global peak) is the cue
    return _fit(x, LEVEL['merge'])


def settle(key=None):
    """Tiny soft click and a faint high shimmer of the key."""
    r = _rng(88)
    n = int(1.6 * SR)
    t = np.arange(n) / SR
    c = _band(r.standard_normal(n), 1200, 4200) * np.exp(-t / 0.0018) + np.sin(2 * np.pi * 380 * t) * np.exp(-t / 0.006) * 0.5
    sh = _glass_mono(tonic_hz(key, 6), 1.6, 0.9) * 0.20
    sh = np.concatenate([np.zeros(int(0.012 * SR)), sh])[:n]
    x = _stereo(c * 0.9 + sh)
    x = _band(x.T, None, 9000).T
    return _fit(x, LEVEL['settle'])


def metronome(accent=False):
    """Quiet woodblock-like click; accented downbeats are higher and a touch louder."""
    n = int(0.06 * SR)
    t = np.arange(n) / SR
    f = 1900 if accent else 1350
    x = (np.sin(2 * np.pi * f * t) + 0.4 * np.sin(2 * np.pi * f * 2.3 * t)) * np.exp(-t / 0.010)
    x = _band(x + _band(_rng(5).standard_normal(n), 1500, 5000) * np.exp(-t / 0.0015) * 0.4, 500, 6000)
    return _fit(_stereo(x), LEVEL['metro_accent'] if accent else LEVEL['metro'])


# kind -> factory(index, key) used by mix.py
def make(kind, i=0, key=None):
    if kind == 'tick':
        return tick(i)
    if kind == 'press':
        return press(i)
    if kind == 'release':
        return release(i)
    if kind == 'fork':
        return fork(key)
    if kind == 'fix':
        return fix(i)
    if kind == 'back':
        return back()
    if kind == 'compare':
        return compare(key)
    if kind == 'merge':
        return merge(key)
    if kind == 'settle':
        return settle(key)
    if kind == 'glass':
        return glass(0, key)
    raise ValueError('unknown cue kind: %s' % kind)


KINDS = ['tick', 'press', 'release', 'fork', 'fix', 'back', 'compare', 'merge', 'settle']
