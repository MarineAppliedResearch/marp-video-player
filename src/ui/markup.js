/**
 * Builds the player's DOM as an HTML string: canvas, center-play overlay,
 * buffering spinner, scrub bar, transport row, and the settings accordion
 * (login, load item, quality, playback, advanced).
 *
 * Every element carries a `marp-`-prefixed class, which is what both the
 * stylesheet and player-ui.js's queries use, so two players on one page
 * stay independent. The original harness ids are kept alongside those
 * classes because the Playwright e2e suite and the probes under
 * video-engine/test/probes/ address elements by id (`#playPauseButton`,
 * `#loginStatus`, ...) -- keeping them means the extraction is verified by
 * the existing suites rather than by rewritten ones. Two players on one
 * page therefore duplicate ids; nothing in this library queries by id, so
 * only external id-based tooling would notice.
 *
 * @fileoverview HTML template for the player UI.
 * @author Isaac Travers
 * @module video-engine/ui/markup
 */

import { PLACEHOLDER_LOGO_DATA_URI } from './logo.js';

/**
 * Escapes a string for use inside a double-quoted HTML attribute.
 *
 * @param {string} value - Raw value.
 * @returns {string} Escaped value.
 */
function escapeAttribute(value) {
    return String(value === undefined || value === null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

/**
 * Renders the player markup.
 *
 * @param {Object} [options]
 * @param {string} [options.defaultItemId] - Prefills the Jellyfin item-id field.
 * @param {string} [options.logoDataUri] - Overrides the inlined placeholder mark.
 * @param {boolean} [options.showDiagnostics] - Renders the Advanced section (cache budgets, state dump). Default true.
 * @returns {string} HTML for the player's interior.
 */
export function buildPlayerMarkup(options = {}) {
    const { defaultItemId = '', logoDataUri = PLACEHOLDER_LOGO_DATA_URI, showDiagnostics = true } = options;

    // Speed hotkeys, spelled out for the Playback section -- the same table
    // player-ui.js binds, written here for the user rather than parsed from
    // it, since the display order is a layout choice, not the keymap.
    const advancedSection = !showDiagnostics ? '' : `
                        <div class="marp-section">
                            <button class="marp-section-header" data-section="settingsAdvancedBody" type="button">Advanced</button>
                            <div id="settingsAdvancedBody" class="marp-section-body marp-hidden">
                                <div class="marp-group">
                                    <label>Raw cache (GiB)
                                        <input id="rawCacheGiBInput" class="marp-raw-cache" type="number" min="0.25" step="0.25" value="3" disabled>
                                    </label>
                                    <label>Decoded cache (GiB)
                                        <input id="decodedCacheGiBInput" class="marp-decoded-cache" type="number" min="0.25" step="0.25" value="5" disabled>
                                    </label>
                                </div>
                                <div class="marp-actions">
                                    <button id="applyCacheSettingsButton" class="marp-apply-cache" type="button" disabled>Apply</button>
                                    <button id="readCacheSettingsButton" class="marp-read-cache" type="button" disabled>Refresh</button>
                                    <button id="dumpEngineStateButton" class="marp-dump-state" type="button" disabled>Dump</button>
                                </div>
                            </div>
                        </div>`;

    return `
        <canvas id="canvas" class="marp-canvas" width="960" height="540"></canvas>
        <img id="placeholderLogo" class="marp-logo" src="${escapeAttribute(logoDataUri)}" alt="">

        <div id="centerPlayOverlay" class="marp-center-overlay marp-hidden">
            <button id="centerPlayButton" class="marp-center-play" type="button" disabled>&#9654;</button>
        </div>
        <div id="bufferingSpinner" class="marp-spinner marp-hidden"></div>

        <div id="controlsBar" class="marp-controls-bar">
            <div id="scrubTrack" class="marp-scrub-track">
                <div id="scrubTrackBg" class="marp-scrub-bg"></div>
                <div id="scrubHandle" class="marp-scrub-handle"></div>
                <div id="scrubTooltip" class="marp-scrub-tooltip"></div>
            </div>

            <div class="marp-controls-row">
                <button id="playPauseButton" class="marp-play-pause" type="button" disabled>&#9654;</button>
                <button id="stepBackButton" class="marp-step marp-step-back" type="button" disabled>&laquo; Step</button>
                <button id="stepForwardButton" class="marp-step marp-step-forward" type="button" disabled>Step &raquo;</button>
                <span id="timeDisplay" class="marp-time">--:-- / --:--</span>
                <span id="speedDisplay" class="marp-speed">1x</span>
                <div class="marp-spacer"></div>
                <div id="playerSettingsAnchor" class="marp-settings-anchor">
                    <button id="playerSettingsButton" class="marp-settings-button" type="button">&#9881;</button>
                    <div id="playerSettingsMenu" class="marp-settings-menu">
                        <!-- Compact accordion: each header toggles its own body in
                             place, at most one open at a time. Everything the player
                             needs (login, loading, quality, diagnostics) lives in
                             here, so the player is complete on its own. -->
                        <div class="marp-section">
                            <button class="marp-section-header" data-section="settingsLoginBody" type="button">Server / Login</button>
                            <div id="settingsLoginBody" class="marp-section-body marp-hidden">
                                <div id="loginStatus" class="marp-status marp-login-status">Not signed in.</div>
                                <div class="marp-group">
                                    <label>Server URL
                                        <input id="jellyfinServerUrlInput" class="marp-server-url" type="text" placeholder="http://host:port">
                                    </label>
                                    <label>Username
                                        <input id="jellyfinUsernameInput" class="marp-username" type="text">
                                    </label>
                                    <label>Password
                                        <input id="jellyfinPasswordInput" class="marp-password" type="password">
                                    </label>
                                </div>
                                <div class="marp-actions">
                                    <button id="jellyfinLoginButton" class="marp-login" type="button">Sign in</button>
                                    <button id="jellyfinLogoutButton" class="marp-logout" type="button">Sign out</button>
                                </div>
                            </div>
                        </div>

                        <div class="marp-section">
                            <button class="marp-section-header" data-section="settingsLoadItemBody" type="button">Load Item</button>
                            <div id="settingsLoadItemBody" class="marp-section-body marp-hidden">
                                <div class="marp-group">
                                    <label>Jellyfin item id
                                        <input id="itemIdInput" class="marp-item-id" type="text" value="${escapeAttribute(defaultItemId)}">
                                    </label>
                                </div>
                                <div class="marp-actions">
                                    <button id="loadButton" class="marp-load" type="button">Load</button>
                                </div>
                                <div class="marp-group">
                                    <label>Or play a local file
                                        <input id="localFileInput" class="marp-local-file" type="file" accept="video/mp4,video/*">
                                    </label>
                                    <span class="marp-status">You can also drag a file onto the player.</span>
                                </div>
                            </div>
                        </div>

                        <div class="marp-section">
                            <button class="marp-section-header" data-section="settingsQualityBody" type="button">Quality</button>
                            <div id="settingsQualityBody" class="marp-section-body marp-hidden">
                                <div id="qualityOptionsList" class="marp-group marp-quality-list">
                                    <span class="marp-status">Load an item first.</span>
                                </div>
                            </div>
                        </div>

                        <div class="marp-section">
                            <button class="marp-section-header" data-section="settingsPlaybackBody" type="button">Playback</button>
                            <div id="settingsPlaybackBody" class="marp-section-body marp-hidden">
                                <div class="marp-group">
                                    <label>Speed override
                                        <input id="speedOverrideInput" class="marp-speed-input" type="number" value="1" step="0.1" disabled>
                                    </label>
                                </div>
                                <span class="marp-hotkey-hint">Speed hotkeys (player must be focused):<br>q w e r t y = -8x..-0.08x<br>u i o p [ ] \\ = 0.08x..16x<br>space toggles play</span>
                            </div>
                        </div>
${advancedSection}
                    </div>
                </div>
                <div id="volumeGroup" class="marp-volume">
                    <button id="muteButton" class="marp-mute" type="button" disabled>&#128266;</button>
                    <input id="volumeSlider" class="marp-volume-slider" type="range" min="0" max="1" step="0.01" value="1" aria-label="Volume" disabled>
                </div>
                <button id="fullscreenButton" class="marp-fullscreen" type="button" disabled>&#9974;</button>
            </div>
        </div>`;
}
