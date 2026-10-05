---
task: MarineAppliedResearch/marp-video-player#20
repos: [marp-video-player]
status: verified
needs: []
---

## Goal

A transcoded (HLS) video shows the frame it says it is showing, even when Jellyfin starts
the transcode partway into the file. Today, opening or seeking a transcode away from where
Jellyfin's job already is can show a picture up to ten seconds from the reported time,
because the stock Jellyfin we run starts that job at the source keyframe before the
requested segment while still labelling the output as the requested segment. The fix is in
the player: Jellyfin is not patched.

## Requirements

- **R1** — A transcode segment whose frames are not from its own playlist time range is
  never displayed at that playlist time. After a cold start, the frame shown at time `t` is
  the source frame at `t`, and its own timestamp agrees with the reported time.
- **R2** — Each unit holds exactly the decoded frames whose own timestamps fall inside its
  playlist time range, from whichever fetched segments contain them.
- **R3** — No fetched segment is decoded twice to build units. Its frames are shared between
  the units they belong to.
- **R4** — A segment whose first frame is within half a frame of its playlist start is used
  exactly as today: one segment, one unit, same trim. A job started at 0, Direct Play and
  local files are unaffected.
- **R5** — The sound of a cold-started transcode is placed by its own timestamps, the same
  way, so it stays with the picture.
- **R6** — Frames held for a unit that is not yet complete are bounded and closed when
  dropped, so a shifted job cannot grow memory without limit.
- **R7** — A transcode sample's time is its presentation time: its composition time less
  the track's edit-list start. Jellyfin's transcode starts video at two frames (1024 of
  12800 ticks); ignoring it showed every picture two frames before its time.

## Open assumptions

- [x] **A1 · architectural · blocking** — answered 2026-09-26: the fix lives in the player,
  not in Jellyfin. The marp-jellyfin fork's server fix is not deployed.
- [x] **A2 · performance · blocking** — answered 2026-09-26: no double decoding. Each fetched
  segment is decoded once and its frames are shared between the units they belong to.
- [x] **A3 · architectural · blocking** — answered 2026-09-26: the scheduler's fetch
  priority, caching, eviction and behind sessions stay as they are; the change is in the
  transcode media source and the frame store.
- [x] **A5 · scientific/data-meaning · non-blocking** — answered 2026-10-05: fix it here; existing data is not touched (MARP_API#181 A7). Decides a separate change no longer. Direct Play and local
  files use the same raw composition times and ignore the original file's edit list too
  (0.12 s, three frames, on the dives), so they show a picture three frames before the
  reported time. Fixing that changes which frame the desktop shows for a given time,
  including in VIDEO_PROCESSING_GUI. Is it fixed in this change, separately, or not at all?
  This change applies the edit list to the transcode path only.
- [ ] **A4 · behavioural · non-blocking** — when two Jellyfin jobs leave a gap inside a unit
  (a cached segment from one job beside one from another), the missing segment is fetched
  again so the job now running serves it, a bounded number of times, and the unit then
  fails like any other decode failure. Chosen because it never shows a wrong frame.

## Decisions

- **2026-09-26** — measured against the live Jellyfin (10.11.11, stock), fMP4, 720p: a
  job started at 0 has no shift; a job cold-started at segment N begins at the source
  keyframe at or before N's start (7.000 s early at 267 s on 20200621_000532_Fwd, about
  9 s at 600 s on 20260611_161158_Fwd); the shift is constant for the rest of that job;
  every segment starts on a keyframe; and the frame timestamps are the true source times —
  segment 89's first picture matches the original's 260 s frame (41 dB PSNR against about
  33 dB for its neighbours). The dives have one keyframe every 10 s, which bounds the shift.
- **2026-09-26** — the player read transcode sample times without the fMP4 edit list, so a
  segment Jellyfin made exactly (from 0) still looked 0.08 s off its label. With the edit
  list applied, segment 0 is 0.000 to 2.960 and a cold start at 267 s is exactly 7.000 s
  early, measured through the player's own demuxer on the live Jellyfin. This is the
  "B-frame video lands two frames early" of #20, on the transcode path.
- **2026-09-26** — `_frameTimestampToMediaTimeSeconds` pins each unit's first frame to its
  playlist start. It stays: once units are assembled by true time, their first frame is at
  their start, and the mapping is right.

- **2026-10-05** — Direct Play and local files apply the original's edit list too (A5):
  they showed every picture three frames early. Measured after: the reported frame is the
  best match at 45-48 dB against 27-32 for its neighbours, at 250, 300 and 600 s.
- **2026-10-05** — Jellyfin restarts a job when a segment is asked for behind it or more
  than 8 ahead (its DynamicHlsController). A unit built from a shifted job walks that job
  forward, so while it does, fetches that would restart it are held, and the walk asks the
  job that served its first segment even after routing moves.
- **2026-10-05** — on a source whose frames carry true timeline times, the scheduler uses
  them and no longer pins a unit's first frame to its label: that read a frame up to one
  frame early (639.964 for 640.000 on 20260611_161158_Fwd).
- **2026-10-05, verification** -- Android emulator (Pixel 7, Android 15, Chrome) against the
  live Jellyfin, 720p transcode, every point scored against the original's frames: 2026 dive
  600, 640, 560 s and 2020 dive 267, 250, 600 s all show the reported frame (37.5-40 dB
  against 27-35), the reported time equals the frame's own, no content-mismatch warning,
  no failed unit, no frame-pool failure, no crash. Released 0.5.3 at the same points: 4-9 s
  off, 14 content-mismatch warnings. Seeks: 6-16 s on the emulator, most of it Jellyfin
  transcoding forward from the keyframe before the target.

## Plan

1. `src/unit-assembly.js`: the pure rules — a segment's shift, which unit a timestamp
   belongs to, whether a unit's frames cover it, and which segment to fetch next.
2. `FrameStore`: for a source that says its units may arrive shifted, decode a segment once,
   file its frames under their units, promote a unit when complete, bound the partials.
3. `JellyfinTranscodeMediaSource`: declare it; place audio by true timestamps for a shifted
   unit; `SegmentFetcher.discardRawBytes` for a segment that has to be fetched again.
4. Unit tests with a fake shifted job; then the emulator against the live Jellyfin.

## Acceptance criteria

- The cold-start case measured above shows the original's frame at the reported time, to
  the frame, on a phone (Android emulator) and on the desktop, on both dives.
- The scheduler's CONTENT MISMATCH warning does not fire during a cold-started transcode.
- Normal forward playback of a transcode from 0 decodes the same number of segments as
  before.

## Test plan

- Unit: the assembly rules; a FrameStore fed a fake job shifted by 7 s builds units whose
  frames are exactly their own time range, decodes each segment once, and closes what it
  drops; an unshifted job takes today's path.
- Real: the Android emulator harness against the live Jellyfin, comparing the displayed
  frame's timestamp with the reported time and the picture with the original file.
