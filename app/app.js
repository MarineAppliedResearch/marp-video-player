/**
 * Mounts the player library on the test-harness page.
 *
 * Everything this file used to do -- build the controls, wire 41 listeners,
 * own the load paths -- now lives in the library (video-engine/src/ui/), so
 * a consumer gets the same player from one call. What is left here is only
 * what a library must not ship: the dev server's credentials, the dev item
 * id, and the page globals the Playwright suite and the probes drive.
 *
 * @fileoverview Test-harness page glue: mounts MarpVideoEngine's player.
 * @author Isaac Travers
 */

"use strict";

/**
 * Optional prefill for the player's login form, for convenience during manual
 * testing. Read from window.MARP_DEV_CONFIG, which you set in an untracked
 * local file -- see app/dev-config.example.js.
 *
 * Never hardcode credentials here. This repository is public, and an earlier
 * revision of this file carried a real server address, username, and password
 * in source.
 */
const DEV_JELLYFIN = (window.MARP_DEV_CONFIG && window.MARP_DEV_CONFIG.jellyfin) || {
    serverUrl: "",
    username: "",
    password: "",
};

/** Item used for manual testing, prefilled into the player's item-id field. */
const DEV_ITEM_ID = (window.MARP_DEV_CONFIG && window.MARP_DEV_CONFIG.itemId) || "";

// --- Fake WebView2 host channel ---------------------------------------
//
// Stands in for chrome.webview so this page receives exactly the messages
// MareMediaElement receives. The mock scrub bar below is drawn from these
// strings alone -- never from getSegmentStates() or the player's DOM -- so
// if it can render, the wire format carries everything a C# host needs.
const hostChannel = {
    duration: NaN,
    currentTime: 0,
    segments: [],
    states: "",
    messageCount: 0,
};

window.chrome = window.chrome || {};
window.chrome.webview = {
    postMessage: (raw) => {
        handleHostMessage(String(raw));
    },
};

/**
 * Parses one host message, the way MareMediaElement's
 * CoreWebView2_WebMessageReceived handler does.
 * Inputs: raw message string.
 * Output: none (updates hostChannel, redraws the mock bar).
 */
function handleHostMessage(raw) {
    hostChannel.messageCount += 1;
    const bar = raw.indexOf("|");
    const kind = bar === -1 ? raw : raw.slice(0, bar);
    const body = bar === -1 ? "" : raw.slice(bar + 1);

    if (kind === "metadata") {
        // metadata|<duration>|<width>|<height>
        hostChannel.duration = parseFloat(body.split("|")[0]);
    } else if (kind === "frame") {
        // frame|<mediaTime>|... -- the host's clock
        hostChannel.currentTime = parseFloat(body.split("|")[0]);
    } else if (kind === "status" && body.startsWith("seeked currentTime=")) {
        // Paused seeks present a frame, but this is the authoritative value.
        hostChannel.currentTime = parseFloat(body.slice("seeked currentTime=".length));
    } else if (kind === "segmentindex") {
        // segmentindex|<count>|<start,end;start,end;...>
        const parts = body.split("|");
        hostChannel.segments = (parts[1] || "")
            .split(";")
            .filter(Boolean)
            .map((pair) => {
                const [start, end] = pair.split(",");
                return { start: parseFloat(start), end: parseFloat(end) };
            });
        hostChannel.states = "";
        buildHostSegmentBlocks();
    } else if (kind === "segments") {
        // segments|<digits> -- 1 fetched, 2 decoded, 4 pinned
        hostChannel.states = body;
        paintHostSegmentBlocks();
    }

    drawHostHandle();
}

const player = MarpVideoEngine.createMarpVideoPlayer(document.getElementById("playerMount"), {
    prefill: DEV_JELLYFIN,
    defaultItemId: DEV_ITEM_ID,
    // The e2e suite and the probes wait on window.marpVideo, which is also
    // the integration contract the C# host depends on.
    exposeGlobals: true,
    // Feeds the fake host channel above, so the mock bar gets the same
    // messages the real host will.
    webview2Bridge: true,
    segmentUpdates: true,
    // The harness owns the keyboard (see HARNESS_KEYMAP below), exactly as
    // the C# host does. Without this the library's own hotkeys would fire
    // too whenever the player had focus, and space would toggle playback
    // twice -- the double-binding this option exists to prevent. The
    // built-in buttons still work; only input on the video is off.
    input: false,
});

window.marpPlayer = player;

/**
 * Loads an item, exposed as a page global because the Playwright suite
 * calls it directly to force a specific quality tier (Direct Play vs a
 * transcode ladder rung) rather than clicking through the menu.
 *
 * @param {string} itemId - Jellyfin item id.
 * @param {Object} [qualityOption] - Tier to load; the first tier when omitted.
 * @returns {Promise<Object|null>} The loaded engine, or null on failure.
 */
window.loadItem = (itemId, qualityOption) => player.loadItem(itemId, qualityOption);

// --- Page-wide drop target ----------------------------------------------
//
// This page constructs the player with `input: false` above, so the library's
// own drag-and-drop listeners are never attached here -- dropping a file did
// nothing but make the browser navigate away and play it itself, losing the
// page. Input stays off, because the page owns the keyboard exactly as the C#
// host does; the drop is handled here instead.
//
// Document-level rather than on #playerMount: the player is one box on a
// taller page, and a file dropped on the margins or the panels below would
// still be taken by the browser.
/** The player's root, for the same drag feedback the library shows. */
const playerRoot = () => document.querySelector(".marp-player");

document.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    const root = playerRoot();
    if (root) root.classList.add("marp-drag-over");
});

document.addEventListener("dragleave", (event) => {
    // Fires between children too; only clear when the pointer left the window.
    if (event.relatedTarget === null) {
        const root = playerRoot();
        if (root) root.classList.remove("marp-drag-over");
    }
});

document.addEventListener("drop", (event) => {
    event.preventDefault();
    const root = playerRoot();
    if (root) root.classList.remove("marp-drag-over");
    const file = event.dataTransfer && event.dataTransfer.files && event.dataTransfer.files[0];
    if (file) {
        player.loadFile(file);
    }
});

// Toggles the built-in GUI from outside the player, which is what a host
// with its own transport and scrub bar does. Only visibility changes --
// input handling is fixed at construction (the `input` option), so the
// hotkeys this harness player was built with stay live either way.
const toggleControlsButton = document.getElementById("toggleControlsButton");
const harnessBarNote = document.getElementById("harnessBarNote");


// --- Host-simulator panel ---------------------------------------------
//
// Everything below drives the player through its public API only, never by
// reaching into its DOM. That is the point: this panel is the same surface
// MareMediaElement has from C#, so anything that cannot be done from here
// cannot be done from the host either.

/** Shorthand for the panel's own elements (all ids prefixed `h`, so they cannot collide with the library's). */
const h = (id) => document.getElementById(id);

/** Logs a labelled value to the console, where the engine's own logs go. */
function report(label, value) {
    console.log(`[host] ${label}`, value);
}

h("hPlay").addEventListener("click", () => player.play());
h("hPause").addEventListener("click", () => player.pause());
h("hStepFwd").addEventListener("click", () => {
    player.currentTime = player.currentTime + 1 / player.fps;
});
h("hStepBack").addEventListener("click", () => {
    player.currentTime = Math.max(0, player.currentTime - 1 / player.fps);
});
h("hMute").addEventListener("click", () => {
    player.muted = !player.muted;
    report("muted", player.muted);
});
h("hVolume").addEventListener("input", (event) => {
    player.volume = Number(event.target.value);
    report("volume", player.volume);
});
h("hFullscreen").addEventListener("click", () => player.toggleFullscreen());

/** Sets the rate through the same path the built-in speed input uses. */
function setRate(rate) {
    player.setPlaybackRate(rate);
    h("hRateInput").value = String(rate);
}

h("hRateRev").addEventListener("click", () => setRate(-1));
h("hRateHalf").addEventListener("click", () => setRate(0.5));
h("hRateOne").addEventListener("click", () => setRate(1));
h("hRateFast").addEventListener("click", () => setRate(6));
h("hRateSet").addEventListener("click", () => {
    const rate = parseFloat(h("hRateInput").value);
    if (!Number.isNaN(rate)) {
        setRate(rate);
    }
});

h("hSeekTo").addEventListener("click", () => {
    player.currentTime = parseFloat(h("hSeekInput").value) || 0;
});
h("hSeekBack10").addEventListener("click", () => {
    player.currentTime = Math.max(0, player.currentTime - 10);
});
h("hSeekFwd10").addEventListener("click", () => {
    player.currentTime = Math.min(player.duration, player.currentTime + 10);
});
h("hSeekStart").addEventListener("click", () => {
    player.currentTime = 0;
});
h("hSeekEnd").addEventListener("click", () => {
    // Just short of the end: seeking exactly to duration has no frame to land on.
    player.currentTime = Math.max(0, player.duration - 1);
});

// Sign-in goes through the player's own Jellyfin client, so the built-in
// menu and this panel share one session.
h("hServer").value = DEV_JELLYFIN.serverUrl;
h("hUser").value = DEV_JELLYFIN.username;
h("hPass").value = DEV_JELLYFIN.password;
h("hItem").value = DEV_ITEM_ID;

h("hLogin").addEventListener("click", async () => {
    try {
        await player.jellyfinClient.login(h("hServer").value.trim(), h("hUser").value.trim(), h("hPass").value);
        player.updateLoginStatus();
        report("signed in to", player.jellyfinClient.serverUrl);
    } catch (err) {
        report("sign-in FAILED", err.message);
    }
});

h("hLogout").addEventListener("click", () => {
    player.jellyfinClient.logout();
    player.updateLoginStatus();
    report("signed out", true);
});

h("hLoadItem").addEventListener("click", () => player.loadItem(h("hItem").value.trim(), null));

h("hProbe").addEventListener("click", async () => {
    const select = h("hQuality");
    try {
        const tiers = await player.probeQualityOptions(h("hItem").value.trim());
        select.innerHTML = "";
        for (const tier of tiers) {
            const option = document.createElement("option");
            option.value = tier.name;
            option.textContent = tier.name;
            select.appendChild(option);
        }
        // Kept so "Load at quality" can pass the real tier object back,
        // not just its name.
        window.hostQualityTiers = tiers;
        report("quality tiers", tiers.map((t) => t.name));
    } catch (err) {
        report("probe FAILED", err.message);
    }
});

h("hLoadQuality").addEventListener("click", () => {
    const tiers = window.hostQualityTiers || [];
    const tier = tiers.find((t) => t.name === h("hQuality").value);
    if (!tier) {
        report("no tier selected", "probe first");
        return;
    }
    player.loadItem(h("hItem").value.trim(), tier);
});

h("hFile").addEventListener("change", () => {
    const file = h("hFile").files && h("hFile").files[0];
    if (file) {
        player.loadFile(file);
    }
});

h("hLoadUrl").addEventListener("click", () => {
    const url = h("hUrl").value.trim();
    if (url) {
        player.loadUrl(url);
    }
});

h("hApplyCache").addEventListener("click", () => {
    const gib = 1024 * 1024 * 1024;
    report("raw cache", player.setRawSegmentCacheBudgetBytes(Math.floor(parseFloat(h("hRawGiB").value) * gib)));
    report("decoded cache", player.setDecodedCacheBudgetBytes(Math.floor(parseFloat(h("hDecodedGiB").value) * gib)));
});

h("hReadCache").addEventListener("click", () => report("cache config", player.getCacheConfig()));
h("hDump").addEventListener("click", () => player.dumpEngineState());
h("hSegments").addEventListener("click", () => report("segment states", player.getSegmentStates()));

h("hEncoded").addEventListener("click", () => {
    // Exactly what a WebView2 host receives as segments| -- one digit per
    // segment, 1 fetched / 2 decoded / 4 pinned.
    const states = player.getSegmentStates() || [];
    report("segments| wire format", MarpVideoEngine.encodeSegmentStates(states));
    report("segmentindex| wire format", MarpVideoEngine.encodeSegmentGeometry(states).slice(0, 120) + "...");
});

h("hClose").addEventListener("click", () => {
    if (player.engine) {
        player.engine.close();
        player.engine = null;
        report("engine closed", true);
    }
});

/** Mirrors the state a host would read, so the panel shows the API's answers rather than the player's own UI. */
function updateReadout() {
    const readout = h("hostReadout");
    if (!player.engine) {
        readout.textContent = "no engine loaded";
        return;
    }

    const states = player.getSegmentStates() || [];
    const count = (key) => states.filter((s) => s[key]).length;
    readout.textContent =
        `time ${player.currentTime.toFixed(2)} / ${player.duration.toFixed(2)}s   ` +
        `rate ${player.playbackRate}x   ${player.paused ? "paused" : "playing"}` +
        `${player.seeking ? "   seeking" : ""}   muted ${player.muted}\n` +
        `${player.videoWidth}x${player.videoHeight} @ ${player.fps}fps   ` +
        `segments ${states.length}: ${count("fetched")} fetched, ${count("decoded")} decoded, ${count("pinned")} pinned   ` +
        `controls ${player.getControlsVisible() ? "visible" : "hidden"}`;
}

setInterval(updateReadout, 250);

toggleControlsButton.addEventListener("click", () => {
    const nowVisible = !player.getControlsVisible();
    player.setControlsVisible(nowVisible);
    toggleControlsButton.textContent = nowVisible ? "Hide player controls" : "Show player controls";
    harnessBarNote.textContent = nowVisible
        ? "Simulates a host that draws its own chrome (controls: false)."
        : "Controls hidden. Drive playback from the console: marpPlayer.play(), .pause(), .currentTime = 30, .getSegmentStates()";
});


// --- Mock host scrub bar ----------------------------------------------
//
// Deliberately built from hostChannel only. Seeking writes
// window.marpVideo.currentTime, which is what the host does through
// ExecuteScriptAsync -- the one direction the message channel does not
// cover.

const hostScrubTrack = h("hostScrubTrack");
const hostScrubHandle = h("hostScrubHandle");
const hostScrubReadout = h("hostScrubReadout");

/** Creates one block per segment, positioned from the geometry message. */
function buildHostSegmentBlocks() {
    // Keep the handle; replace the blocks.
    [...hostScrubTrack.querySelectorAll(".host-seg")].forEach((el) => el.remove());

    const total = hostChannel.segments.length
        ? hostChannel.segments[hostChannel.segments.length - 1].end
        : 0;
    if (!total) {
        return;
    }

    for (const segment of hostChannel.segments) {
        const block = document.createElement("div");
        block.className = "host-seg";
        block.style.left = `${(segment.start / total) * 100}%`;
        block.style.width = `${((segment.end - segment.start) / total) * 100}%`;
        hostScrubTrack.appendChild(block);
    }
}

/** Colours each block from the digit string: 1 fetched, 2 decoded, 4 pinned. */
function paintHostSegmentBlocks() {
    const blocks = hostScrubTrack.querySelectorAll(".host-seg");
    let fetched = 0;
    let decoded = 0;
    let pinned = 0;

    blocks.forEach((block, index) => {
        const bits = Number(hostChannel.states[index] || 0);
        // Decoded wins the fill over fetched, matching the built-in bar;
        // pinned is a ring, so it layers on either.
        block.classList.toggle("decoded", (bits & 2) !== 0);
        block.classList.toggle("fetched", (bits & 2) === 0 && (bits & 1) !== 0);
        block.classList.toggle("pinned", (bits & 4) !== 0);
        if (bits & 1) fetched += 1;
        if (bits & 2) decoded += 1;
        if (bits & 4) pinned += 1;
    });

    hostScrubReadout.textContent =
        `${blocks.length} segments from segmentindex| | ${fetched} fetched, ${decoded} decoded, ${pinned} pinned ` +
        `| ${hostChannel.messageCount} host messages | states "${hostChannel.states.slice(0, 40)}${hostChannel.states.length > 40 ? "..." : ""}"`;
}

/** Moves the playhead marker using the duration and time the host was told. */
function drawHostHandle() {
    if (!Number.isFinite(hostChannel.duration) || hostChannel.duration <= 0) {
        return;
    }
    const fraction = Math.min(1, Math.max(0, hostChannel.currentTime / hostChannel.duration));
    hostScrubHandle.style.left = `${fraction * 100}%`;
}

/** Converts a pointer position on the mock track to a media time. */
function hostScrubEventToTime(event) {
    const rect = hostScrubTrack.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
    return fraction * hostChannel.duration;
}

let hostScrubbing = false;

hostScrubTrack.addEventListener("pointerdown", (event) => {
    if (!Number.isFinite(hostChannel.duration)) {
        return;
    }
    hostScrubbing = true;
    hostScrubTrack.setPointerCapture(event.pointerId);
    hostChannel.currentTime = hostScrubEventToTime(event);
    drawHostHandle();
});

hostScrubTrack.addEventListener("pointermove", (event) => {
    if (!hostScrubbing) {
        return;
    }
    hostChannel.currentTime = hostScrubEventToTime(event);
    drawHostHandle();
});

hostScrubTrack.addEventListener("pointerup", (event) => {
    if (!hostScrubbing) {
        return;
    }
    hostScrubbing = false;
    hostScrubTrack.releasePointerCapture(event.pointerId);
    // Commit on release, like the built-in bar: one seek, not one per move.
    // This is the ExecuteScriptAsync call a host makes.
    window.marpVideo.currentTime = hostScrubEventToTime(event);
});


// --- Harness keyboard shortcuts ---------------------------------------
//
// The host owns the keyboard here, not the library (see `input: false`
// above). Every binding drives the player through its public API, so this
// table is a working model of what MareMediaElement's own key handling can
// do -- if a shortcut works here, the same call works from C#.
//
// The speed row is the established scheme: q..y run -8x to -0.08x, u..\ run
// 0.08x to 16x. It comes straight from the library's own SPEED_KEYMAP
// rather than being retyped here, so the two can never drift apart.

/** Seeks by a delta in seconds, clamped to the stream. */
function nudge(seconds) {
    player.currentTime = Math.min(player.duration, Math.max(0, player.currentTime + seconds));
}

/** Steps exactly one frame. */
function stepFrame(direction) {
    nudge(direction / player.fps);
}

/**
 * key -> { label, run }. `key` is matched against KeyboardEvent.key, with
 * "Shift+" prefixed where the shifted form matters.
 */
const HARNESS_KEYMAP = {
    " ": { label: "space  play/pause", run: () => (player.paused ? player.play() : player.pause()) },
    ArrowLeft: { label: "left/right  step 1 frame", run: () => stepFrame(-1) },
    ArrowRight: { label: "", run: () => stepFrame(1) },
    "Shift+ArrowLeft": { label: "shift+left/right  -/+1s", run: () => nudge(-1) },
    "Shift+ArrowRight": { label: "", run: () => nudge(1) },
    Home: { label: "home/end  start/end", run: () => { player.currentTime = 0; } },
    End: { label: "", run: () => { player.currentTime = Math.max(0, player.duration - 1); } },
    f: { label: "f  fullscreen", run: () => player.toggleFullscreen() },
    m: { label: "m  mute", run: () => { player.muted = !player.muted; } },
    c: { label: "c  toggle player controls", run: () => toggleControlsButton.click() },
};

// The speed keys, from the library's own table. Each sets a rate AND starts
// playback: these keys are for actively scrubbing through the video at that
// rate, not for arming a rate to use later -- same behaviour the built-in
// player has always had.
for (const [key, rate] of Object.entries(MarpVideoEngine.SPEED_KEYMAP)) {
    HARNESS_KEYMAP[key] = {
        label: key === "q" ? "q w e r t y  -8x..-0.08x" : key === "u" ? "u i o p [ ] \\  0.08x..16x" : "",
        run: () => {
            setRate(rate);
            player.play();
        },
    };
}

/**
 * True when the event came from a form field, where keys must be left
 * alone -- the panel is full of text inputs, and space belongs to them.
 */
function typingInField(target) {
    const tag = target && target.tagName;
    return tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA" || (target && target.isContentEditable);
}

document.addEventListener("keydown", (event) => {
    if (typingInField(event.target)) {
        return;
    }

    const name = `${event.shiftKey && event.key.startsWith("Arrow") ? "Shift+" : ""}${event.key}`;
    const binding = HARNESS_KEYMAP[name];
    if (!binding) {
        return;
    }

    if (!player.engine) {
        report("shortcut ignored", `${name} -- no engine loaded`);
        return;
    }

    // Space scrolls, arrows scroll, / opens quick-find: all unwanted here.
    event.preventDefault();
    binding.run();
    report("shortcut", `${name} -> rate ${player.playbackRate}x`);
});

// Lists the bindings in the panel, built from the table so the two cannot
// drift apart.
h("hostKeys").textContent = Object.values(HARNESS_KEYMAP)
    .map((binding) => binding.label)
    .filter(Boolean)
    .join("   |   ");
