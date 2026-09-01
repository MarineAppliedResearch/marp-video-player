# Changelog

Notable changes to marp-video-player. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.2]

### Fixed
- The loading spinner starts when a load starts. It was driven entirely by
  engine events, and the listeners were attached only after the engine had been
  built -- so the slow part of a load, which is the negotiating, the first fetch
  and the first decode, reported nothing at all. A cold load looked like a click
  that had not registered.

### Changed
- Loading a video clears the previous one's picture back to the placeholder
  mark. A spinner over the last frame of the previous video read as "still
  playing that one".

## [0.3.1]

### Fixed
- A host is now told the frame playback paused on. Its clock came only from
  per-frame messages, which report the frame being displayed, so after a pause
  it could sit a frame or more behind the picture -- worse at higher speeds.
  Annotations are recorded against a frame, so this mattered.

### Changed
- The development server supports byte-range requests, so the player can load a
  URL source from it. It previously answered a range request with the whole
  file.

## [0.3.0]

### Added
- `VERSION` export reporting the build's own version, compiled in at build
  time.
- `player.html` puts that version in the page title, so a host can read
  `document.title` to see exactly which player is loaded.

## [0.2.1]

### Changed
- Releases publish through npm trusted publishing rather than a token, so
  there is no secret to leak or expire.

## [0.2.0]

First published version.

## [Unreleased]

### Added
- Extracted from `MARE_API`, where the player was developed as `video-engine/`.
- Three build outputs: ESM for `import`, IIFE for a plain script tag, and a
  minified single-file build for native hosts.
- `demo/` with three runnable embedding examples.
- Automated browser test suite that starts its own server and downloads its own
  test media.
- `CONTRIBUTING.md`, `NOTICE`, and `CLAUDE.md`.

### Fixed
- Dropping a video file onto the player now loads it. The listeners were on the
  canvas, which the centre overlay covers until the first frame is presented.
- The browser suite's `baseURL` pointed at the server root, so it could not run
  at all.

### Removed
- The Phase 0 measurement probes, whose questions were answered and shipped.

[Unreleased]: https://github.com/MarineAppliedResearch/marp-video-player/commits/master
