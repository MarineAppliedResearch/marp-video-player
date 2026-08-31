#!/usr/bin/env python3
"""S4 -- what is actually in the media archive.

Answers the R4/R7 questions: which containers and codecs exist, what
resolutions and framerates, and how many files are non-faststart (moov after
mdat), which decides whether the Direct Play index strategy works on raw
camera output or needs a fallback probe.

Deliberately sampled: it takes a bounded number of files per top-level
directory rather than walking everything, because this runs on production
hardware. The moov check reads only box headers -- a few hundred bytes even
from a 30 GB file -- so the I/O cost is dominated by ffprobe.

Usage: python3 s4-archive-survey.py [root] [per-dir-sample] [out.json]
"""

import json
import os
import random
import struct
import subprocess
import sys

ROOT = sys.argv[1] if len(sys.argv) > 1 else "/mnt/rov-video-new"
CENSUS = len(sys.argv) > 2 and sys.argv[2] == "census"
PER_DIR = int(sys.argv[2]) if len(sys.argv) > 2 and not CENSUS else 3
OUT = sys.argv[3] if len(sys.argv) > 3 else "/tmp/s4-archive-survey.json"

VIDEO_EXT = (".mp4", ".mkv", ".avi", ".mov", ".mts", ".m2ts", ".mpg", ".mpeg", ".wmv", ".m4v", ".webm")
FFPROBE = "/usr/lib/jellyfin-ffmpeg/ffprobe" if os.path.exists("/usr/lib/jellyfin-ffmpeg/ffprobe") else "ffprobe"


def top_level_boxes(path, limit=64):
    """Walks top-level MP4/MOV boxes reading only 16-byte headers."""
    boxes = []
    size = os.path.getsize(path)
    with open(path, "rb") as f:
        offset = 0
        while offset < size and len(boxes) < limit:
            f.seek(offset)
            header = f.read(16)
            if len(header) < 8:
                break
            box_size = struct.unpack(">I", header[0:4])[0]
            box_type = header[4:8].decode("latin1", "replace")
            header_size = 8
            if box_size == 1:
                if len(header) < 16:
                    break
                box_size = struct.unpack(">Q", header[8:16])[0]
                header_size = 16
            elif box_size == 0:
                box_size = size - offset
            if box_size < header_size:
                break
            boxes.append((box_type, offset, box_size))
            offset += box_size
    return boxes


def faststart(path):
    """True when moov precedes mdat; None when the layout is unrecognisable."""
    try:
        types = [b[0] for b in top_level_boxes(path)]
        if "moov" not in types or "mdat" not in types:
            return None
        return types.index("moov") < types.index("mdat")
    except OSError:
        return None


def probe(path):
    cmd = [FFPROBE, "-v", "error", "-print_format", "json", "-show_format",
           "-show_streams", "-select_streams", "v:0", path]
    try:
        raw = subprocess.run(cmd, capture_output=True, timeout=120).stdout
        data = json.loads(raw or b"{}")
    except Exception as exc:  # unreadable file, timeout, bad ffprobe output
        return {"error": str(exc)}
    streams = data.get("streams") or [{}]
    v = streams[0]
    fmt = data.get("format", {})
    num, _, den = (v.get("r_frame_rate") or "0/0").partition("/")
    fps = round(int(num) / int(den), 3) if den not in ("", "0") else None
    return {
        "format": fmt.get("format_name"),
        "codec": v.get("codec_name"),
        "profile": v.get("profile"),
        "level": v.get("level"),
        "width": v.get("width"),
        "height": v.get("height"),
        "fps": fps,
        "pix_fmt": v.get("pix_fmt"),
        "durationSeconds": round(float(fmt.get("duration", 0) or 0), 1),
        "bitrateMbps": round(int(fmt.get("bit_rate", 0) or 0) / 1e6, 2),
    }


# Census mode: moov position for every file, no ffprobe. Header-only reads,
# so this is cheap enough to run exhaustively where the full survey is not.
if CENSUS:
    counts = {True: 0, False: 0, None: 0}
    late = []
    for dirpath, _dirnames, filenames in os.walk(ROOT):
        for name in filenames:
            if not name.lower().endswith((".mp4", ".mov", ".m4v")):
                continue
            path = os.path.join(dirpath, name)
            state = faststart(path)
            counts[state] += 1
            if state is not True:
                late.append(path)
    total = sum(counts.values())
    print(f"{total} files: faststart={counts[True]}, moov-at-end={counts[False]}, unreadable={counts[None]}")
    for path in late[:40]:
        print(f"  not-faststart: {path}")
    if len(late) > 40:
        print(f"  ... and {len(late) - 40} more")
    sys.exit(0)

# Sample per top-level directory so every project/year is represented.
groups = {}
for entry in sorted(os.listdir(ROOT)):
    base = os.path.join(ROOT, entry)
    if not os.path.isdir(base):
        continue
    found = []
    for dirpath, _dirnames, filenames in os.walk(base):
        for name in filenames:
            if name.lower().endswith(VIDEO_EXT):
                found.append(os.path.join(dirpath, name))
    if found:
        random.seed(entry)  # stable sample across runs
        groups[entry] = random.sample(found, min(PER_DIR, len(found)))
        groups[entry].append(found[0])  # always include a deterministic one

results = []
for group, paths in groups.items():
    for path in dict.fromkeys(paths):
        info = probe(path)
        info["path"] = path
        info["group"] = group
        info["bytes"] = os.path.getsize(path)
        info["faststart"] = faststart(path) if path.lower().endswith((".mp4", ".mov", ".m4v")) else None
        results.append(info)
        print(
            f"{group:<24} {os.path.basename(path)[:40]:<40} "
            f"{info.get('codec')} {info.get('profile')} {info.get('width')}x{info.get('height')} "
            f"@{info.get('fps')}fps {info.get('bitrateMbps')}Mbps faststart={info['faststart']}",
            flush=True,
        )

print("\n== summary ==")


def tally(key):
    counts = {}
    for r in results:
        counts[r.get(key)] = counts.get(r.get(key), 0) + 1
    return dict(sorted(counts.items(), key=lambda kv: -kv[1]))


for key in ("codec", "profile", "faststart", "fps", "pix_fmt"):
    print(f"{key}: {tally(key)}")
print("resolutions:", tally_res := {})
for r in results:
    res = f"{r.get('width')}x{r.get('height')}"
    tally_res[res] = tally_res.get(res, 0) + 1
print("  " + json.dumps(dict(sorted(tally_res.items(), key=lambda kv: -kv[1]))))

with open(OUT, "w") as f:
    json.dump(results, f, indent=2)
print(f"\nwrote {OUT} ({len(results)} files sampled)")
