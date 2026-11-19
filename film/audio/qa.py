"""QA tools for a rendered film.

qa.py contact <video.mp4> <out.png> [--fps 1] [--cols 8] [--w 320]   storyboard sheet, timestamp burned in
qa.py diff <video.mp4> [--seams seams.json] [--out report.json]       frame-difference scan
qa.py audio <video.mp4>                                               loudness, true peak, 12 loudest onsets
"""
import argparse
import json
import math
import os
import re
import subprocess

import numpy as np

FONT = 'C\\:/Windows/Fonts/consola.ttf' if os.name == 'nt' else '/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf'


def probe(video):
    r = subprocess.run(['ffprobe', '-v', 'error', '-select_streams', 'v:0', '-show_entries',
                        'stream=r_frame_rate,width,height:format=duration', '-of', 'json', video],
                       capture_output=True, text=True, check=True)
    j = json.loads(r.stdout)
    n, d = j['streams'][0]['r_frame_rate'].split('/')
    return float(j['format']['duration']), float(n) / float(d), j['streams'][0]['width'], j['streams'][0]['height']


def contact(video, out, fps=1.0, cols=8, w=320):
    dur, _, _, _ = probe(video)
    count = int(math.ceil(dur * fps))
    rows = int(math.ceil(count / cols))
    txt = "drawtext=fontfile='%s':text='%%{eif\\:t\\:d}s':x=6:y=h-th-6:fontsize=%d:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=3" % (FONT, max(12, w // 22))
    vf = 'fps=%s,scale=%d:-2,%s,tile=%dx%d:padding=4:color=0x202020' % (fps, w, txt, cols, rows)
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    subprocess.run(['ffmpeg', '-y', '-v', 'error', '-i', video, '-vf', vf, '-frames:v', '1', out], check=True)
    print('contact sheet: %s (%d frames, %dx%d)' % (out, count, cols, rows))


def load_times(path):
    if not path:
        return []
    j = json.load(open(path))
    if isinstance(j, list):
        return [float(v) for v in j]
    ts = []
    for k in ('seams', 'hits'):
        ts += [float(v) for v in j.get(k, [])]
    return ts


def diff(video, seams=None, out=None, floor=3.0, ratio=4.0, win=15, tol=0.1):
    dur, fps, w, h = probe(video)
    sw, sh = 96, 54
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', video, '-vf', 'scale=%d:%d:flags=area,format=gray' % (sw, sh),
                          '-f', 'rawvideo', '-'], capture_output=True, check=True).stdout
    fr = np.frombuffer(raw, np.uint8).reshape(-1, sh * sw).astype(np.float32)
    d = np.abs(np.diff(fr, axis=0)).mean(axis=1)  # d[i] = change into frame i+1
    times = (np.arange(len(d)) + 1) / fps
    planned = load_times(seams)
    flagged = []
    for i, v in enumerate(d):
        lo, hi = max(0, i - win), min(len(d), i + win + 1)
        nb = np.delete(d[lo:hi], i - lo)
        med = float(np.median(nb)) if len(nb) else 0.0
        if v > floor and v > ratio * max(med, 1e-3):
            near = [p for p in planned if abs(p - times[i]) <= tol]
            flagged.append(dict(t=round(float(times[i]), 3), frame=i + 1, diff=round(float(v), 2),
                                median=round(med, 2), planned=bool(near)))
    print('%d frames, %.2f fps, %.1fs; flagged %d (diff > %.0fx rolling median and > %.1f)' % (len(fr), fps, dur, len(flagged), ratio, floor))
    if flagged:
        print('  time     frame   diff  median  status')
        for f in flagged:
            print('  %7.3f %6d %6.2f %7.2f  %s' % (f['t'], f['frame'], f['diff'], f['median'], 'planned (seam/hit)' if f['planned'] else 'UNPLANNED'))
    bad = [f for f in flagged if not f['planned']]
    print('unplanned jumps: %d' % len(bad))
    if out:
        json.dump(dict(video=video, fps=fps, flagged=flagged, unplanned=len(bad)), open(out, 'w'), indent=1)
        print('report:', out)
    return flagged


def audio(video, n=12):
    r = subprocess.run(['ffmpeg', '-nostats', '-i', video, '-vn', '-af', 'ebur128=peak=true', '-f', 'null', '-'],
                       capture_output=True, text=True)
    s = r.stderr.split('Summary:')[-1]
    i = re.search(r'I:\s+(-?[\d.]+) LUFS', s)
    p = re.search(r'Peak:\s+(-?[\d.]+) dBFS', s)
    print('integrated %s LUFS, true peak %s dBTP' % (i.group(1) if i else '?', p.group(1) if p else '?'))
    sr = 48000
    raw = subprocess.run(['ffmpeg', '-v', 'error', '-i', video, '-vn', '-f', 'f32le', '-ac', '1', '-ar', str(sr), '-'],
                         capture_output=True, check=True).stdout
    x = np.abs(np.frombuffer(raw, '<f4'))
    if not len(x):
        print('no audio')
        return []
    k = int(0.002 * sr)
    env = np.convolve(x, np.ones(k) / k, mode='same')
    order = np.argsort(-env)
    picked = []
    for j in order:
        if env[j] < 1e-4 or len(picked) >= n:
            break
        if all(abs(j - q) > 0.15 * sr for q in picked):
            picked.append(int(j))
    print('%d loudest sound peaks (time of the peak sample, as mix.py places them):' % len(picked))
    for j in sorted(picked):
        print('  %8.3f s  %6.1f dBFS' % (j / sr, 20 * np.log10(env[j])))
    return sorted(j / sr for j in picked)


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest='cmd', required=True)
    c = sub.add_parser('contact')
    c.add_argument('video')
    c.add_argument('out')
    c.add_argument('--fps', type=float, default=1.0)
    c.add_argument('--cols', type=int, default=8)
    c.add_argument('--w', type=int, default=320)
    d = sub.add_parser('diff')
    d.add_argument('video')
    d.add_argument('--seams')
    d.add_argument('--out')
    a = sub.add_parser('audio')
    a.add_argument('video')
    g = ap.parse_args()
    if g.cmd == 'contact':
        contact(g.video, g.out, g.fps, g.cols, g.w)
    elif g.cmd == 'diff':
        diff(g.video, g.seams, g.out)
    else:
        audio(g.video)


if __name__ == '__main__':
    main()
