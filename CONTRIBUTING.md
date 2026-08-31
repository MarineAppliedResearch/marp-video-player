# Contributing to marp-video-player

Thank you for your interest in improving the MARP video player. This guide is written primarily for MARP developers, but it should also be useful to anyone outside MARE who wants to understand how contributions are made and reviewed.

This repository is one component of the [MARP platform](https://github.com/MarineAppliedResearch/MARP). Platform-wide architecture and cross-component work live in the umbrella repository; this guide covers the player itself.

## Introduction

Contributions that improve the following are welcome:

- playback correctness, especially frame accuracy and reverse playback
- media source support
- decode and scheduling performance
- the embedding API and its documentation
- native host integration
- tests
- maintainability

Contributions are encouraged but not required to use the player. If you embed it in your own application and never send a single pull request, that is a completely normal and supported way to use the project.

## Contribution license

By submitting a contribution, you agree that it may be distributed under the Apache License, Version 2.0.

## Getting set up

```bash
npm install
npm run build
npm test
```

The unit tests need nothing else — no server, no network, no media.

For the browser tests, copy `.env.example` to `.env` and fill it in, then:

```bash
npx playwright install chromium
npm run test:e2e
```

The browser suite starts its own server and downloads its own test media. See [README.md](README.md#development) for what each part does.

## Recommended workflow

1. Create a focused branch from `master`, named for the issue it addresses.
2. Keep the change limited to one concern.
3. Add or update tests. A behaviour worth fixing is worth a test that keeps it fixed.
4. Run `npm test` before opening a pull request. Run `npm run test:e2e` when you have touched playback, media sources, or the host bridge.
5. Rebuild (`npm run build`) if you changed `src/` and want to see it in the developer test page.
6. Open a pull request explaining what changed, why, and how it was verified.

## Things that will be asked of a change

- **Do not break the host contract without saying so.** The `MarpVideoEngine` global name, the `postMessage` protocol in `src/webview2-bridge.js`, and `app/player.html`'s query parameters are consumed by a C# WebView2 host in MARE's desktop application. Changing them is a breaking change for software that lives in a different repository.
- **Keep the bundles self-contained.** The player must have no runtime dependencies and must make no network requests when it loads — no CDN, no web fonts, no remote assets. It is deployed to ships and field sites without reliable connectivity.
- **No credentials, anywhere.** Not in source, not in tests, not in the developer page. Local configuration goes in `.env` or `app/dev-config.js`, both git-ignored.
- **No hardcoded hostnames or machine-specific paths.** Read them from the environment with no fallback, and fail with a message naming what to set.
- **Document non-obvious behaviour** where the reasoning would not be clear from the code. Much of this codebase encodes hard-won findings about decoder and transcoder behaviour; explain the why, not the what.

## Commit sign-off

A Developer Certificate of Origin-style sign-off is preferred but not required.

```text
Signed-off-by: Contributor Name <contributor@example.org>
```

Add it automatically with `git commit -s`.

## Pull-request expectations

- Keep pull requests focused on a single concern.
- Include reproducible testing steps.
- Update documentation alongside behaviour changes.
- Expect review from project maintainers before merge.

## Related documents

- [README.md](README.md) — what the player is, how to embed it, how to develop on it
- [LICENSE](LICENSE) — Apache License, Version 2.0
- [NOTICE](NOTICE) — third-party attribution for code bundled into the builds
- [MARP platform](https://github.com/MarineAppliedResearch/MARP) — the wider system this belongs to, and its governance
