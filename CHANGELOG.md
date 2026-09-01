# Changelog

Notable changes to marp-video-player. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

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
