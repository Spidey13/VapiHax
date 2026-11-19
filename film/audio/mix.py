"""Mix cues (+ optional song window, + optional metronome) to a 48 kHz 16-bit stereo WAV.

python film/audio/mix.py --cues cues.json --beats film/data/launch-beats.json --dur 80 \
    [--song song.mp3 --song-start 12.5] [--metronome] --out mix.wav
"""
import argparse
import json
import os
import re
import subprocess
import sys

import numpy as np
from scipy import signal as sg
from scipy.io import wavfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import sfx  # noqa: E402

SR = sfx.SR
SONG_GAIN, SFX_GAIN, MET_GAIN = 0.5, 0.62, 0.55
TARGET_TP_DB = -1.0


def decode_song(path, start, dur):
    cmd = ['ffmpeg', '-v', 'error', '-ss', str(start), '-t', str(dur), '-i', path,
           '-f', 'f32le', '-ac', '2', '-ar', str(SR), '-']
    raw = subprocess.run(cmd, capture_output=True, check=True).stdout
    return np.frombuffer(raw, dtype='<f4').reshape(-1, 2).astype(np.float64)


def place(buf, sig, peak_index, t, gain=1.0, pan=0.0):
    """Add `sig` so its own peak sample lands on time t (seconds). Pan is a stereo balance."""
    gl, gr = min(1.0, 1.0 - pan), min(1.0, 1.0 + pan)
    start = int(round(t * SR)) - peak_index
    a, b = max(0, start), min(len(buf), start + len(sig))
    if b <= a:
        return
    seg = sig[a - start:b - start].astype(np.float64) * gain
    seg[:, 0] *= gl
    seg[:, 1] *= gr
    buf[a:b] += seg


def true_peak(x):
    return np.max(np.abs(sg.resample_poly(x, 4, 1, axis=0)))


def loudness(path):
    r = subprocess.run(['ffmpeg', '-nostats', '-i', path, '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                       capture_output=True, text=True)
    s = r.stderr.split('Summary:')[-1]
    i = re.search(r'I:\s+(-?[\d.]+) LUFS', s)
    p = re.search(r'Peak:\s+(-?[\d.]+) dBFS', s)
    return (float(i.group(1)) if i else None, float(p.group(1)) if p else None)


def build(cues, beats, dur, song=None, song_start=0.0, metronome=False, key=None):
    n = int(round(dur * SR))
    sfx_buf = np.zeros((n, 2))
    cache = {}
    tick_i = 0
    for c in sorted(cues, key=lambda c: c['t']):
        kind = c['kind']
        gain, pan = float(c.get('gain', 1.0)), float(c.get('pan', 0.0))
        if kind == 'tick':
            # variant by index; tiny deterministic gain wobble (golden-ratio walk, +-5%)
            gain *= 1 + 0.05 * np.sin(tick_i * 2.399963)
            sig, pk = sfx.tick(tick_i)
            tick_i += 1
        else:
            if kind not in cache:
                cache[kind] = sfx.make(kind, 0, key)
            sig, pk = cache[kind]
        place(sfx_buf, sig, pk, c['t'], gain, pan)
    out = sfx_buf * SFX_GAIN
    if metronome and beats:
        downs = set(round(d, 4) for d in beats.get('downbeats', []))
        m = np.zeros((n, 2))
        ms = {False: sfx.metronome(False), True: sfx.metronome(True)}
        for b in beats['beats']:
            if b < dur:
                acc = round(b, 4) in downs
                place(m, *ms[acc], b, 1.0)
        out += m * MET_GAIN
    if song:
        s = decode_song(song, song_start, dur)
        s = np.pad(s, ((0, max(0, n - len(s))), (0, 0)))[:n]
        t = np.arange(n) / SR
        fade = np.minimum(1, t / 0.6) * np.minimum(1, np.maximum(0, (dur - t) / 2.5))
        out += s * fade[:, None] * SONG_GAIN
    pk = true_peak(out)
    if pk > 0:
        out *= 10 ** (TARGET_TP_DB / 20) / pk
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--cues', required=True)
    ap.add_argument('--beats')
    ap.add_argument('--dur', type=float, required=True)
    ap.add_argument('--song')
    ap.add_argument('--song-start', type=float, default=0.0)
    ap.add_argument('--metronome', action='store_true')
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    raw = json.load(open(a.cues))
    cues = raw['cues'] if isinstance(raw, dict) else raw
    beats = json.load(open(a.beats)) if a.beats and os.path.exists(a.beats) else None
    key = None
    if beats and beats.get('key'):
        key = (beats['key']['tonic'], beats['key']['mode'])
    out = build(cues, beats, a.dur, a.song, a.song_start, a.metronome, key)
    os.makedirs(os.path.dirname(os.path.abspath(a.out)), exist_ok=True)
    wavfile.write(a.out, SR, np.round(np.clip(out, -1, 1) * 32767).astype('<i2'))
    lufs, peak = loudness(a.out)
    print('wrote %s  %.2fs  %d cues  key=%s' % (a.out, a.dur, len(cues), key or 'D major (default)'))
    print('loudness: %s LUFS integrated, sample peak %s dBFS (target about -16 LUFS, -1 dBTP; not looped)' % (lufs, peak))


if __name__ == '__main__':
    main()
