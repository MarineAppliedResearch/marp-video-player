# Verification — inference watch player

## Approved scope

The human approved the watch-mode portions of this plan on 2026-09-14.

## Automated checks

- **R2-R5** — Run `test/unit/live-frame-presenter.test.js`.
- **R6** — Run the production build and host pack.

## System checks

- **R1-R7** — Exercise this player through a real watched inference job as described in the
  worker verification plan.

## Not covered

- Installer, distribution, activation, updates, volunteer controls, and remote viewing.

## Results

- **Presenter unit test — PASS.** `2 passed`.
- **Production build and offline host pack — PASS.** All three bundles built and the host
  archive contains `live.html`; the build reports one pre-existing duplicate `onUnitReady`
  warning in `src/audio-output.js`.
- **Real watched inference — PASS.** The player acknowledged all 300 frames from the real
  API/Jellyfin/GPU run. The visible run took 24.20 s (12.39 fps), versus 8.75 s headless,
  and produced the same 20,992-byte scientific artifact with SHA-256
  `78a42ec94592689391e2e92e8cc1db2004a841bc35da88b3714fd10dc4cee1e1`.
- **Concurrent full-video presentation — PASS.** Two full Dive 14 ranges completed together
  with `rockfish5`, followed by two full ranges with `Star4` (29,062 and 24,820 frames). A
  focused display-only regression also presented 900 annotated frames in each of two windows
  at 30 fps and closed both windows at completion.
- **Restore and occlusion handling — implemented.** The live page redraws its latest packet on
  focus, visibility restoration, and `pageshow`; acknowledgement uses the synchronous canvas
  update so a covered fullscreen window does not wait on a suspended animation callback.
- **Final focused check — PASS.** `test/unit/live-frame-presenter.test.js`: `2 passed`; the
  production build completed with the same pre-existing duplicate `onUnitReady` warning.
- **Installed laptop display — PASS.** Installer v17 used this player for API job 219. The
  watched CUDA run displayed real video, boxes, labels, model/job status, and progress at
  approximately 17 fps, then the API recorded all 1,000 requested frames as succeeded.
- **Render proof retained.** The diagnostic render-proof endpoint remains available for the
  next-computer rollout so a remote operator can distinguish host launch from canvas paint.
