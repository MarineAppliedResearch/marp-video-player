/**
 * Presents externally decoded frames with live inference annotations.
 *
 * This is deliberately separate from the media engine. The inference worker
 * already decoded the frame it is inspecting, so handing that image to the
 * player avoids a second download, decoder and playback clock.
 *
 * @fileoverview Ordered live-frame presentation for inference hosts.
 * @author Isaac Travers
 * @module video-engine/live-frame-presenter
 */

/** FNV-1a gives every species one stable, inexpensive colour choice. */
function speciesHue(species) {
    let hash = 2166136261;
    for (const character of String(species).toLowerCase()) {
        hash ^= character.charCodeAt(0);
        hash = Math.imul(hash, 16777619);
    }
    return Math.abs(hash) % 360;
}

/** Convert a normalized centre-form box to canvas edge coordinates. */
function boxEdges(box, width, height) {
    if (Array.isArray(box)) {
        const [centerX, centerY, boxWidth, boxHeight] = box.map(Number);
        return {
            x1: (centerX - boxWidth / 2) * width,
            y1: (centerY - boxHeight / 2) * height,
            x2: (centerX + boxWidth / 2) * width,
            y2: (centerY + boxHeight / 2) * height,
        };
    }

    return {
        x1: Number(box.x1) * width,
        y1: Number(box.y1) * height,
        x2: Number(box.x2) * width,
        y2: Number(box.y2) * height,
    };
}

/**
 * Draws frames supplied by a host, in exactly the order calls are awaited.
 *
 * A caller should await present() before sending the next frame. That promise
 * is the acknowledgement/backpressure boundary used by the worker's loopback
 * channel.
 */
export class LiveFramePresenter {
    /**
     * @param {HTMLCanvasElement} canvas - MARP player's visual frame surface.
     * @param {Object} [options]
     * @param {HTMLElement|null} [options.statusElement] - Optional quiet status line.
     * @param {HTMLProgressElement|null} [options.progressElement] - Optional range timeline.
     * @param {HTMLElement|null} [options.contextElement] - Optional model and job context.
     */
    constructor(canvas, options = {}) {
        if (!canvas || typeof canvas.getContext !== 'function') {
            throw new TypeError('LiveFramePresenter requires a canvas');
        }

        this.canvas = canvas;
        this.context = canvas.getContext('2d');
        this.statusElement = options.statusElement || null;
        this.progressElement = options.progressElement || null;
        this.contextElement = options.contextElement || null;
        this.contextSignature = null;
        this.presentedFrames = 0;
        this.startedAt = null;
        this.trackFirstFrame = new Map();
    }

    /**
     * Present one decoded frame and its current tracks.
     *
     * @param {Object} packet
     * @param {CanvasImageSource} packet.frame - ImageBitmap, VideoFrame, image, or canvas.
     * @param {number} packet.frameNumber - Source frame number.
     * @param {Array<Object>} [packet.tracks] - Current tracks with id, species and box.
     * @returns {Promise<Object>} Presentation acknowledgement and current measured rate.
     */
    async present({
        frame,
        frameNumber,
        tracks = [],
        rangeStart = null,
        rangeEnd = null,
        jobId = null,
        modelName = null,
        speciesNames = [],
    }) {
        if (!frame) throw new TypeError('A live frame packet requires frame');

        const width = Number(frame.displayWidth || frame.videoWidth || frame.naturalWidth || frame.width);
        const height = Number(frame.displayHeight || frame.videoHeight || frame.naturalHeight || frame.height);
        if (!(width > 0 && height > 0)) throw new TypeError('Live frame has no usable dimensions');

        if (this.canvas.width !== width || this.canvas.height !== height) {
            this.canvas.width = width;
            this.canvas.height = height;
        }

        this.context.drawImage(frame, 0, 0, width, height);
        this._drawTracks(tracks, Number(frameNumber), width, height);

        if (this.startedAt === null) this.startedAt = performance.now();
        this.presentedFrames += 1;
        const elapsedSeconds = Math.max((performance.now() - this.startedAt) / 1000, 0.001);
        const rate = this.presentedFrames / elapsedSeconds;
        this._showStatus(frameNumber, rate, tracks.length, rangeStart, rangeEnd);
        this._showContext(jobId, modelName, speciesNames);

        // Canvas drawing updates its backing store synchronously. Acknowledging
        // here keeps an occluded fullscreen window alive: browsers may suspend
        // requestAnimationFrame entirely while another window covers it.
        return { frameNumber: Number(frameNumber), rate, liveTracks: tracks.length };
    }

    _drawTracks(tracks, frameNumber, width, height) {
        const lineWidth = Math.max(2, height * 0.004);
        this.context.lineWidth = lineWidth;
        this.context.lineJoin = 'round';
        this.context.textAlign = 'center';

        for (const track of tracks) {
            const trackId = track.trackId ?? track.track_id ?? track.id;
            const species = track.species ?? track.className ?? track.class_name ?? 'Unknown';
            const edges = boxEdges(track.box ?? track.bboxNormalized ?? track.bbox_normalized, width, height);
            const firstFrame = this.trackFirstFrame.get(trackId) ?? frameNumber;
            this.trackFirstFrame.set(trackId, firstFrame);
            const age = Math.max(1, frameNumber - firstFrame + 1);
            const confidence = Number(track.confidence);
            const detail = `${Number.isFinite(confidence) ? `${Math.round(confidence * 100)}%` : '--'}  #${trackId}  ${age}f`;
            const colour = `hsl(${speciesHue(species)} 88% 56%)`;
            const boxWidth = Math.max(1, edges.x2 - edges.x1);
            const longestLabel = species.length >= detail.length ? species : detail;
            const fontSize = Math.max(
                10,
                Math.min(height * 0.055, boxWidth / Math.max(longestLabel.length * 0.58, 1)),
            );
            const labelX = Math.max(boxWidth / 2, Math.min(width - boxWidth / 2, (edges.x1 + edges.x2) / 2));

            this.context.strokeStyle = colour;
            this.context.strokeRect(edges.x1, edges.y1, boxWidth, edges.y2 - edges.y1);

            // A small translucent plate keeps plain text readable without an
            // outline around every letter.
            this.context.font = `700 ${fontSize}px system-ui, sans-serif`;
            this.context.textBaseline = 'bottom';
            const speciesY = Math.max(fontSize + lineWidth, edges.y1 - lineWidth);
            this.context.fillStyle = 'rgba(0, 0, 0, 0.42)';
            this.context.fillRect(edges.x1, speciesY - fontSize * 1.12, boxWidth, fontSize * 1.2);
            this.context.fillStyle = colour;
            this.context.fillText(species, labelX, speciesY);

            this.context.textBaseline = 'top';
            const preferredDetailY = edges.y2 + lineWidth;
            const detailY = preferredDetailY + fontSize <= height
                ? preferredDetailY
                : Math.max(0, edges.y2 - fontSize - lineWidth);
            this.context.fillStyle = 'rgba(0, 0, 0, 0.42)';
            this.context.fillRect(edges.x1, detailY, boxWidth, fontSize * 1.2);
            this.context.fillStyle = colour;
            this.context.fillText(detail, labelX, detailY);
            this.context.lineWidth = lineWidth;
        }
    }

    _showStatus(frameNumber, rate, liveTracks, rangeStart, rangeEnd) {
        if (!this.statusElement) return;
        const start = Number(rangeStart);
        const end = Number(rangeEnd);
        const hasRange = Number.isFinite(start) && Number.isFinite(end) && end > start;
        const position = hasRange ? Math.max(0, Math.min(end - start, Number(frameNumber) - start + 1)) : 0;
        const rangeText = hasRange ? `  ·  ${position} / ${end - start}` : '';
        this.statusElement.textContent = `Frame ${frameNumber}${rangeText}  ·  ${rate.toFixed(1)} fps  ·  ${liveTracks} live`;
        if (this.progressElement) {
            this.progressElement.max = hasRange ? end - start : 1;
            this.progressElement.value = position;
        }
    }

    _showContext(jobId, modelName, speciesNames) {
        if (!this.contextElement) return;
        const parts = [];
        if (jobId !== null && jobId !== undefined && String(jobId)) parts.push(`Job ${jobId}`);
        if (modelName) parts.push(`Model ${modelName}`);
        if (Array.isArray(speciesNames) && speciesNames.length) parts.push(speciesNames.join('  ·  '));
        const signature = parts.join('  |  ');
        if (signature !== this.contextSignature) {
            this.contextElement.textContent = signature;
            this.contextSignature = signature;
        }
    }

    /** Forget rate and persistence state before a different job starts. */
    reset() {
        this.presentedFrames = 0;
        this.startedAt = null;
        this.trackFirstFrame.clear();
        this.contextSignature = null;
    }
}

/** Build an external live-frame presenter on an existing player canvas. */
export function createMarpLiveFramePresenter(canvas, options) {
    return new LiveFramePresenter(canvas, options);
}
