"""Beat grid, downbeats, key, energy and lift/resolve candidates from a song.

python film/audio/beats.py song.mp3 [--out film/data/launch-beats.json] [--start S] [--len L]
python film/audio/beats.py --placeholder 96 100 [--out ...]

beats[] are KICK-PEAK times (the sample a kick's low band peaks at), relative to --start, so a sound whose
own peak is placed on a beat lands on the kick. peak_off = median(kick peak - kick onset) in seconds.
"""
import argparse
import json
import os
import subprocess

import numpy as np
from scipy import signal as sg

SR = 44100
NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']
KMAJ = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
KMIN = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def decode(path, start, length):
    cmd = ['ffmpeg', '-v', 'error', '-ss', str(start)]
    if length:
        cmd += ['-t', str(length)]
    cmd += ['-i', path, '-f', 'f32le', '-ac', '1', '-ar', str(SR), '-']
    return np.frombuffer(subprocess.run(cmd, capture_output=True, check=True).stdout, dtype='<f4').astype(np.float64)


def bp(x, lo, hi):
    sos = sg.butter(3, [lo / (SR / 2), hi / (SR / 2)], 'bandpass', output='sos')
    return sg.sosfiltfilt(sos, x)


def flux(x, n_fft=2048, hop=256):
    f, t, Z = sg.stft(x, SR, nperseg=n_fft, noverlap=n_fft - hop, boundary=None, padded=False)
    m = np.log1p(30 * np.abs(Z))
    d = np.maximum(0, np.diff(m, axis=1)).sum(axis=0)
    d = np.concatenate([[0], d])
    d -= sg.medfilt(d, 41) if len(d) > 41 else 0
    return t + 0.0, np.maximum(d, 0)  # t: window centres


def fold_score(t, o, periods, nb=48):
    best = (-1, None, None)
    out = []
    for p in periods:
        ph = (t % p) / p
        h = np.bincount((ph * nb).astype(int) % nb, weights=o, minlength=nb)
        h = h + np.roll(h, 1) * 0.5 + np.roll(h, -1) * 0.5
        sc = h.max() / (h.mean() + 1e-12)
        out.append(sc)
        if sc > best[0]:
            best = (sc, p, (np.argmax(h) + 0.5) / nb * p)
    return best, np.array(out)


def estimate(x, start=0.0):
    # fine fused onset signal at 1 kHz: kick-band envelope rise + spectral flux
    ts, fl = flux(x)
    tf = np.arange(0, len(x) / SR, 0.001)
    kb = np.abs(sg.hilbert(bp(x, 40, 120)))
    kb = sg.sosfiltfilt(sg.butter(2, 40 / (SR / 2), 'lowpass', output='sos'), kb)
    kb_f = np.interp(tf, np.arange(len(x)) / SR, kb)
    # sharper 40-250 Hz magnitude (the 40-120 Hz band alone peaks ~20 ms late) for locating the peak sample itself
    kp = sg.sosfiltfilt(sg.butter(2, 300 / (SR / 2), 'lowpass', output='sos'), np.abs(bp(x, 40, 250)))
    kp_f = np.interp(tf, np.arange(len(x)) / SR, kp)
    rise = np.maximum(0, np.gradient(kb_f))
    rise /= rise.max() + 1e-12
    fl_f = np.interp(tf, ts, fl)
    fl_f /= fl_f.max() + 1e-12
    o = 0.65 * rise + 0.35 * fl_f

    periods = np.arange(60 / 110, 60 / 80 + 1e-9, 0.0002)
    (sc, p, ph0), _ = fold_score(tf, o, periods)
    # raw: unconstrained search (55-190 BPM); reports what the plain tempo estimate would say
    (_, praw, _), _ = fold_score(tf, o, np.arange(60 / 190, 60 / 55, 0.0004))
    return dict(tf=tf, o=o, kb=kb_f, kp=kp_f, period=p, phase=ph0, bpm_raw=60 / praw, ts=ts, fl=fl)


def refine(e, dur):
    """Place a grid on kick peaks and regress period/phase from them."""
    tf, o, kb, kp = e['tf'], e['o'], e['kb'], e['kp']
    p, ph = e['period'], e['phase']
    for _ in range(2):
        ks = np.arange(0, int((dur - ph) / p) + 1)
        pk, onset_off = [], []
        for k in ks:
            c = ph + k * p
            lo, hi = int((c - 0.06) * 1000), int((c + 0.08) * 1000)
            if lo < 0 or hi >= len(kb):
                continue
            seg = kb[lo:hi]
            if seg.max() < 0.25 * kb.max():
                continue
            coarse = lo + np.argmax(seg)
            w0 = max(0, coarse - 30)
            pk.append((w0 + np.argmax(kp[w0:coarse + 31])) / 1000)
            ko = o[lo:hi]
            onset_off.append(pk[-1] - (lo / 1000 + np.argmax(ko) / 1000))
        if len(pk) < 4:
            break
        pk = np.array(pk)
        idx = np.round((pk - ph) / p)
        for _r in range(3):  # robust line fit, drop >20 ms outliers
            A = np.polyfit(idx, pk, 1)
            res = pk - np.polyval(A, idx)
            keep = np.abs(res) < 0.02
            if keep.all() or keep.sum() < 4:
                break
            idx, pk = idx[keep], pk[keep]
        p, ph = A[0], A[1]
        poff = float(np.median(onset_off)) if onset_off else 0.0
        e['peak_off'] = poff
    e['period'], e['phase'] = p, ph
    e.setdefault('peak_off', 0.0)
    return e


def chroma(x, n_fft=8192, hop=4096):
    f, t, Z = sg.stft(x, SR, nperseg=n_fft, noverlap=n_fft - hop, boundary=None, padded=False)
    P = np.abs(Z) ** 2
    ok = (f > 60) & (f < 2000)
    midi = 69 + 12 * np.log2(f[ok] / 440.0)
    pc = np.round(midi).astype(int) % 12
    C = np.zeros((12, P.shape[1]))
    for k in range(12):
        C[k] = P[ok][pc == k].sum(axis=0)
    return t, C


def key_of(C):
    c = np.log1p(C.sum(axis=1) / (C.sum() + 1e-12) * 100)
    best = (-2, 0, 'major')
    for pc in range(12):
        for mode, prof in (('major', KMAJ), ('minor', KMIN)):
            r = np.corrcoef(c, np.roll(prof, pc))[0, 1]
            if r > best[0]:
                best = (r, pc, mode)
    return best[1], best[2]


def analyse(path, start, length):
    x = decode(path, start, length)
    dur = len(x) / SR
    e = refine(estimate(x), dur)
    p, ph = e['period'], e['phase']
    beats = np.arange(ph, dur, p)
    beats = beats[beats >= 0]
    # downbeats: accent = onset strength + kick height at each beat, summed over 4 phases
    acc = []
    for b in beats:
        i = int(b * 1000)
        w = slice(max(0, i - 40), min(len(e['o']), i + 40))
        acc.append(e['o'][w].max() + 0.5 * e['kb'][w].max() / (e['kb'].max() + 1e-12))
    acc = np.array(acc)
    sc = [acc[k::4].mean() if len(acc[k::4]) else 0 for k in range(4)]
    d0 = int(np.argmax(sc))
    downs = beats[d0::4]
    # energy per beat
    energy = []
    for i, b in enumerate(beats):
        nxt = beats[i + 1] if i + 1 < len(beats) else min(dur, b + p)
        seg = x[int(b * SR):int(nxt * SR)]
        energy.append(dict(t=round(float(b), 4), rms=round(float(np.sqrt(np.mean(seg ** 2))) if len(seg) else 0.0, 5)))
    rms = np.array([q['rms'] for q in energy])
    # lifts: biggest sustained rises (next 4 beats mean vs previous 4 beats), snapped to downbeats, spaced 8 beats
    lifts = []
    if len(rms) >= 9:
        score = np.zeros(len(rms))
        for i in range(4, len(rms) - 3):
            score[i] = rms[i:i + 4].mean() - rms[i - 4:i].mean()
        order = np.argsort(-score)
        for i in order:
            if score[i] <= 0.05 * max(rms.max(), 1e-9):
                break
            if all(abs(i - j) >= 8 for j in lifts):
                lifts.append(int(i))
            if len(lifts) >= 5:
                break
        lifts = sorted(float(downs[np.argmin(np.abs(downs - beats[i]))]) for i in lifts)
    # key and resolve
    tc, C = chroma(x)
    pc, mode = key_of(C)
    resolve = None
    third = 4 if mode == 'major' else 3
    thr = 0.5 * np.percentile(rms, 90) if len(rms) else 0
    for d in downs[::-1]:
        if d < dur * 0.5:
            break
        m = (tc >= d) & (tc < d + 2 * p)
        if m.sum() == 0:
            continue
        cc = C[:, m].sum(axis=1)
        tri = cc[pc] + cc[(pc + third) % 12] + cc[(pc + 7) % 12]
        r = rms[np.argmin(np.abs(np.array([q['t'] for q in energy]) - d))]
        if tri / (cc.sum() + 1e-12) > 0.7 and r >= thr:
            resolve = float(d)
            break
    return dict(bpm=round(60 / p, 3), bpm_raw=round(float(e['bpm_raw']), 3), period=round(float(p), 6),
                peak_off=round(float(e['peak_off']), 4), beats=[round(float(b), 4) for b in beats],
                downbeats=[round(float(b), 4) for b in downs], key=dict(tonic=NAMES[pc], mode=mode),
                energy=energy, lifts=[round(v, 4) for v in lifts],
                resolve=None if resolve is None else round(resolve, 4), start=start, len=round(dur, 3))


def placeholder(bpm, dur):
    p = 60.0 / bpm
    beats = np.arange(0, dur, p)
    return dict(bpm=bpm, bpm_raw=bpm, period=round(p, 6), peak_off=0.0,
                beats=[round(float(b), 4) for b in beats], downbeats=[round(float(b), 4) for b in beats[::4]],
                key=None, energy=[], lifts=[], resolve=None, start=0, len=dur)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('song', nargs='?')
    ap.add_argument('--out', default='film/data/launch-beats.json')
    ap.add_argument('--start', type=float, default=0.0)
    ap.add_argument('--len', type=float, default=0.0)
    ap.add_argument('--placeholder', nargs=2, type=float, metavar=('BPM', 'DUR'))
    a = ap.parse_args()
    if a.placeholder:
        r = placeholder(*a.placeholder)
    elif a.song:
        r = analyse(a.song, a.start, a.len)
    else:
        ap.error('give a song or --placeholder BPM DUR')
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    json.dump(r, open(a.out, 'w'))
    print('wrote %s  bpm=%s (raw %s)  beats=%d downbeats=%d key=%s lifts=%s resolve=%s' % (
        a.out, r['bpm'], r['bpm_raw'], len(r['beats']), len(r['downbeats']), r['key'], r['lifts'], r['resolve']))


if __name__ == '__main__':
    main()
