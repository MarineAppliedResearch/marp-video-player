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

/** FNV-1a gives a stable, inexpensive colour choice for a track identifier. */
function trackHue(trackId) {
    let hash = 2166136261;
    for (const character of String(trackId)) {
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
     */
    constructor(canvas, options = {}) {
        if (!canvas || typeof canvas.getContext !== 'function') {
            throw new TypeError('LiveFramePresenter requires a canvas');
        }

        this.canvas = canvas;
        this.context = canvas.getContext('2d');
        this.statusElement = options.statusElement || null;
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
    async present({ frame, frameNumber, tracks = [] }) {
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
        this._showStatus(frameNumber, rate, tracks.length);

        // Resolve after the browser has accepted the complete draw. The worker
        // waits for this acknowledgement before it sends another frame.
        await new Promise((resolve) => requestAnimationFrame(() => resolve()));
        return { frameNumber: Number(frameNumber), rate, liveTracks: tracks.length };
    }

    _drawTracks(tracks, frameNumber, width, height) {
        const lineWidth = Math.max(2, height * 0.004);
        const fontSize = Math.max(12, Math.round(height * 0.027));
        this.context.lineWidth = lineWidth;
        this.context.font = `700 ${fontSize}px system-ui, sans-serif`;
        this.context.textBaseline = 'bottom';
        this.context.lineJoin = 'round';

        for (const track of tracks) {
            const trackId = track.trackId ?? track.track_id ?? track.id;
            const species = track.species ?? track.className ?? track.class_name ?? 'Unknown';
            const edges = boxEdges(track.box ?? track.bboxNormalized ?? track.bbox_normalized, width, height);
            const firstFrame = this.trackFirstFrame.get(trackId) ?? frameNumber;
            this.trackFirstFrame.set(trackId, firstFrame);
            const age = Math.max(1, frameNumber - firstFrame + 1);
            const colour = `hsl(${trackHue(trackId)} 88% 56%)`;
            const label = `${species}  #${trackId}  ${age}f`;

            this.context.strokeStyle = colour;
            this.context.strokeRect(edges.x1, edges.y1, edges.x2 - edges.x1, edges.y2 - edges.y1);

            // A dark halo keeps labels readable over both sand and dark water.
            const labelX = Math.max(0, edges.x1);
            const labelY = Math.max(fontSize + lineWidth, edges.y1 - lineWidth);
            this.context.lineWidth = Math.max(3, fontSize * 0.24);
            this.context.strokeStyle = 'rgba(0, 0, 0, 0.88)';
            this.context.strokeText(label, labelX, labelY);
            this.context.fillStyle = colour;
            this.context.fillText(label, labelX, labelY);
            this.context.lineWidth = lineWidth;
        }
    }

    _showStatus(frameNumber, rate, liveTracks) {
        if (!this.statusElement) return;
        this.statusElement.textContent = `Frame ${frameNumber}  ·  ${rate.toFixed(1)} fps  ·  ${liveTracks} live`;
    }

    /** Forget rate and persistence state before a different job starts. */
    reset() {
        this.presentedFrames = 0;
        this.startedAt = null;
        this.trackFirstFrame.clear();
    }
}

/** Build an external live-frame presenter on an existing player canvas. */
export function createMarpLiveFramePresenter(canvas, options) {
    return new LiveFramePresenter(canvas, options);
}
