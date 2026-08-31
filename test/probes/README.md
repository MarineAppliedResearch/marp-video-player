# Probes

Scripts that check things the automated suites cannot. **No engine module
imports anything here**, and nothing here ships in the bundle.

These are not part of `npm test`. Each drives a real browser, and most need a
real Jellyfin server, so they are run deliberately rather than on every commit.
They exist because the unit and E2E suites verify timing, routing and decode
success, and none of them can answer "is the right picture on screen" or "did
the host actually receive the messages it needs".

## Prerequisites

- `npm install`, plus `npx playwright install chromium`.
- A served player. Run `npm run serve` in another terminal.
- For the Jellyfin probes, a **development** Jellyfin server. Configure with
  `JELLYFIN_URL`, `JELLYFIN_ITEM`, `JELLYFIN_USER`, `JELLYFIN_PASS`. There are
  no defaults; the probe exits if they are unset.
- For local-file probes, an MP4 on disk, passed as an argument or via
  `VIDEO_ENGINE_TEST_LOCAL_FILE`.

## What is here

| File | Answers | Needs |
|---|---|---|
| `frame-correctness.mjs` | Is the picture on the canvas the *right* picture? Compares captures against the source by PSNR. Nothing else in the project verifies content rather than timing. | Jellyfin, `FRAME_REFERENCE_FILE` |
| `host-messages.mjs` | What does `player.html` actually post to a WebView2 host? Verifies the message contract the C# host depends on. | Jellyfin |
| `player-page.mjs` | Exercises `player.html` the way a host does, by navigating with parameters. Covers both a Jellyfin item and a plain media URL. | Jellyfin |
| `behind-sessions.mjs` | Are behind sessions negotiated, and from inside the library? Transcode-path only. Not covered by any suite. | Jellyfin |
| `playback-reporting.mjs` | Does Jellyfin actually receive playback reports, on both paths? Reads `UserData.PlaybackPositionTicks` back from the server, because a client cannot tell whether its own report landed. | Jellyfin |
| `local-file-playback.mjs` | Do forward, reverse and frame stepping work on a local file? The one fully deterministic path: same bytes every run, no transcoder, no sessions, no network. | a local MP4 |
| `fixture-manifest.mjs` | Describes local MP4 fixtures and writes `manifest.json` beside them. Its box walk is also the non-faststart detector. | a fixture directory |

## Running them

```bash
npm run serve                                   # in another terminal
node test/probes/local-file-playback.mjs path/to/video.mp4
node test/probes/player-page.mjs
```

## Retired probes

The Phase 0 measurement probes were removed once their questions were
answered and the answers shipped:

| Removed | Question | Where the answer went |
|---|---|---|
| `directplay-index.mjs` | Can a `moov`-prefix fetch alone yield a full sample table, and can an arbitrary GOP be pulled by byte range? | Yes — implemented as `src/media-source-mp4-byte-range.js` |
| `harness/` (S1, S2) | Decode cost per GOP, and the retained-frame ceiling before `VideoFrame` allocation fails | Informed the decoded-frame cache default |
| `s3-throughput.mjs` | Direct Play throughput and seek latency by GOP landing position | Recorded in the media-source architecture notes |
| `s4-archive-survey.py` | Containers, codecs, resolutions and `moov` position across the real archive | One-time survey; decided the Direct Play index strategy |
| `lib/mp4-index.mjs` | Shared index helper used only by S3 and the S1/S2 harness | Removed with them |

They are in git history if a measurement ever needs redoing.
