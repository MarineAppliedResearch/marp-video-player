# Probes (#36 Phase 0)

Throwaway measurement code for the media-source investigation. **No engine
module imports anything here**, and nothing here is part of the shipped
bundle — these exist so the numbers in
`docs/developer/media-source-architecture.md` can be re-derived instead of
trusted.

They live in the repo rather than a scratchpad because the scratchpad keeps
getting wiped, and each of these measurements cost real time to establish.

## Prerequisites

- `node_modules` installed (`mp4box` and, for the harness driver, `playwright`).
- Network access to the dev Jellyfin server on **port 8097** — never 8096,
  that is live production. Override with `JELLYFIN_URL`, `JELLYFIN_ITEM`,
  `JELLYFIN_USER`, `JELLYFIN_PASS`.
- Fixtures for `fixture-manifest.mjs` live outside the repo in
  `/home/mare/test-fixtures/video-engine/fixtures/` (see below).

## What is here

| File | Answers |
|---|---|
| `directplay-index.mjs` | The original feasibility proof: can a `moov`-prefix fetch alone yield a full sample table, and can an arbitrary GOP be pulled by byte range and assembled into WebCodecs chunks? |
| `s3-throughput.mjs` | **S3.** Cold index cost, whole-GOP fetch cost, seek cost as a function of landing position within a GOP, sustained sequential throughput, and what a constrained link implies. |
| `s4-archive-survey.py` | **S4.** Containers, codecs, resolutions, framerates and `moov` position across the real archive. Runs *on the Jellyfin box*, not here. |
| `harness/` | **S1 and S2.** Decode cost, time-to-target-frame, backward-step re-decode cost, and the retained-frame ceiling. Browser-only. |
| `fixture-manifest.mjs` | Describes the local MP4 fixtures and writes `manifest.json` beside them. Its box walk is also the non-faststart detector. |
| `lib/mp4-index.mjs` | Shared helper: range reader, `moov`-prefix index, GOP list, sub-GOP byte ranges, chunk assembly. Used by S3 and the harness so both measure an identically-built index. |

## Running them

```bash
node video-engine/test/probes/directplay-index.mjs
node video-engine/test/probes/s3-throughput.mjs
node video-engine/test/probes/fixture-manifest.mjs
```

### S1/S2 harness

Needs a real GPU. **Numbers measured in the dev sandbox are invalid** — it has
software-only SwiftShader decode. Serve it (localhost is a secure context,
which WebCodecs requires; `file://` is not a reliable substitute):

```bash
node video-engine/test/probes/harness/serve.mjs 8099
# then open http://localhost:8099/video-engine/test/probes/harness/
```

The server is rooted at the repo root so the browser can import `mp4box` from
`node_modules` and reuse `lib/mp4-index.mjs` unchanged.

S2 deliberately allocates until it fails, and **may crash the tab rather than
throw** — that crash is the result. It logs every 50 retained frames, so the
last line printed brackets the ceiling.

### S4 archive survey

Runs on the Jellyfin box, read-only:

```bash
scp video-engine/test/probes/s4-archive-survey.py jellyfin-dev-server:~/
ssh jellyfin-dev-server 'python3 ~/s4-archive-survey.py /mnt/rov-video-new 3 ~/s4.json'
ssh jellyfin-dev-server 'python3 ~/s4-archive-survey.py /mnt/rov-video-new census'
```

Sampled mode ffprobes a few files per top-level project directory. Census mode
checks `moov` position for *every* file and skips ffprobe entirely — header
reads only, so it is cheap enough to run exhaustively.

## Fixtures

Generated once from the real 1080p source with ffmpeg, into
`/home/mare/test-fixtures/video-engine/fixtures/` (outside the repo — they are
large and are not test inputs the suite depends on yet):

| Fixture | What it is |
|---|---|
| `long-gop-faststart.mp4` | 30 s stream-copied from the real source, so real ~190-frame GOPs survive intact. `moov` first. |
| `long-gop-nonfaststart.mp4` | Identical content, `moov` after `mdat` — the 1.2 % of the archive that looks like this. |
| `short-gop-faststart.mp4` | 10 s re-encoded at 2 s GOPs, matching the transcode path's granularity for A/B comparison. |
| `tiny.mp4` | 2 s, 320×240 — a fast fixture for tests that only need a decodable file. |

Regenerate with the commands recorded in the session log, then re-run
`fixture-manifest.mjs`.
