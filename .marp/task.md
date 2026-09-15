---
task: MarineAppliedResearch/marp-inference-worker#11
repos: [marp-inference-worker, marp-video-player]
status: ready-for-pr
needs: []
---

## Goal

An inference job may open a local screensaver-style MARP window showing the exact frames
being processed, with the model's detections and tracks drawn as they happen.

## Requirements

- **R1** — Display requires both a worker screen option and `params.watch: true`.
- **R2** — The player accepts already-decoded inference frames without decoding media.
- **R3** — Frames are drawn in order without pacing or dropping.
- **R4** — Each species has one stable box/label colour. The top label is centered over
  and sized to its box and contains only the species name. A centered bottom label shows
  confidence while retaining track id and persistence.
- **R5** — Status shows frame number, achieved rate, and live-track count.
- **R6** — Existing player APIs and offline host behavior remain compatible.
- **R7** — Escape leaves fullscreen for the normal app window; its close control closes
  the display. There is no pause, audio, or scrubbing.
- **R8** — Installer and distribution work are outside this issue.

## Open assumptions

- [x] **A1 · product/UI · blocking** — answered 2026-09-14: use marp-video-player for the
  live presentation with window and fullscreen modes.
- [x] **A2 · performance · blocking** — answered 2026-09-14: present every inference frame
  in order as fast as inference produces it.
- [x] **A3 · environment · blocking** — corrected 2026-09-14: use the development checkout
  for #11; package design is separate later work.

## Decisions

- **2026-09-14** — Add an external live-frame presenter beside normal media playback.
- **2026-09-14** — Use species identity for annotation colour, split the label above and
  below its box, and let Chromium return Escape to windowed mode.

## Plan

1. Add an offline live host page and presenter.
2. Draw the required overlays and status without changing existing player contracts.
3. Verify presenter behavior and the production build.

## Acceptance criteria

- The live page displays ordered frames and the required readable track information.
- Existing player consumers continue to build unchanged.

## Test plan

See `.marp/verification.md`.

## Status

- **Gate:** verified; ready for pull request.
- **Notes:** The live presenter is implemented; installer controls were removed from scope.
