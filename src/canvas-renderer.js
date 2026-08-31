/**
 * Draws decoded VideoFrames to a <canvas>.
 *
 * @fileoverview Draws decoded frames to a canvas and tracks the presented-frame count.
 * @author Isaac Travers
 * @module video-engine/canvas-renderer
 */

/**
 * Renders VideoFrames to a canvas element.
 *
 * Deliberately never calls frame.close() -- FrameStore owns each
 * VideoFrame's lifetime (it's the one that evicts and closes them);
 * closing here too would double-close.
 *
 * @class CanvasRenderer
 */
export class CanvasRenderer {
    /** @param {HTMLCanvasElement} canvas - Render target. */
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.presentedFrameCount = 0;
        this.currentFrame = null;
        this._onFramePresented = null;
    }

    /**
     * Registers a callback invoked every time {@link CanvasRenderer#render}
     * actually presents a new frame.
     *
     * @param {function(VideoFrame, number): void} callback - Invoked with the presented frame and the new presented-frame count.
     * @returns {void}
     */
    onFramePresented(callback) {
        this._onFramePresented = callback;
    }

    /**
     * Draws `frame` if it differs from what's currently displayed.
     *
     * @param {VideoFrame} frame - Frame to draw.
     * @returns {boolean} True if a new frame was actually presented -- callers use this to decide whether a requestVideoFrameCallback dispatch (and any "current frame" bookkeeping) should happen.
     */
    render(frame) {
        if (this.currentFrame === frame) {
            return false;
        }

        if (this.canvas.width !== frame.displayWidth || this.canvas.height !== frame.displayHeight) {
            this.canvas.width = frame.displayWidth;
            this.canvas.height = frame.displayHeight;
        }

        this.ctx.drawImage(frame, 0, 0, this.canvas.width, this.canvas.height);

        this.currentFrame = frame;
        this.presentedFrameCount += 1;

        if (this._onFramePresented) {
            this._onFramePresented(frame, this.presentedFrameCount);
        }

        return true;
    }
}
