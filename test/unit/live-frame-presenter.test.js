/** Unit coverage for the inference worker's externally-fed player surface. */

const { LiveFramePresenter } = require('../../src/live-frame-presenter.js');

function surface() {
    const calls = [];
    const context = {
        drawImage: (...args) => calls.push(['image', ...args]),
        strokeRect: (...args) => calls.push(['box', ...args]),
        strokeText: (...args) => calls.push(['strokeText', ...args]),
        fillText: (...args) => calls.push(['fillText', ...args]),
    };
    return {
        canvas: { width: 0, height: 0, getContext: () => context },
        context,
        calls,
        status: { textContent: '' },
    };
}

describe('LiveFramePresenter', () => {
    let animationCallbacks;

    beforeEach(() => {
        animationCallbacks = [];
        global.requestAnimationFrame = (callback) => {
            animationCallbacks.push(callback);
            return animationCallbacks.length;
        };
        jest.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValue(1100);
    });

    afterEach(() => {
        delete global.requestAnimationFrame;
        jest.restoreAllMocks();
    });

    test('draws the supplied frame, readable track identity, persistence, and status before acknowledging', async () => {
        const { canvas, calls, status } = surface();
        const presenter = new LiveFramePresenter(canvas, { statusElement: status });
        const frame = { width: 1000, height: 500 };

        let acknowledged = false;
        const first = presenter.present({
            frame,
            frameNumber: 40,
            tracks: [{ trackId: 7, species: 'California sea cucumber', box: [0.5, 0.5, 0.2, 0.4] }],
        }).then((result) => {
            acknowledged = true;
            return result;
        });

        expect(canvas).toMatchObject({ width: 1000, height: 500 });
        expect(calls[0]).toEqual(['image', frame, 0, 0, 1000, 500]);
        expect(calls).toContainEqual(['box', 400, 150, 200, 200]);
        expect(calls.some((call) => call[0] === 'strokeText'
            && call[1] === 'California sea cucumber  #7  1f')).toBe(true);
        expect(status.textContent).toMatch(/^Frame 40\s+·\s+[\d.]+ fps\s+·\s+1 live$/);
        expect(acknowledged).toBe(false);

        animationCallbacks.shift()();
        expect(await first).toMatchObject({ frameNumber: 40, liveTracks: 1 });

        const second = presenter.present({
            frame,
            frameNumber: 43,
            tracks: [{ trackId: 7, species: 'California sea cucumber', box: [0.5, 0.5, 0.2, 0.4] }],
        });
        expect(calls.some((call) => call[0] === 'fillText'
            && call[1] === 'California sea cucumber  #7  4f')).toBe(true);
        animationCallbacks.shift()();
        await second;
    });

    test('keeps one stable colour per track and resets its persistence state for another job', async () => {
        const { canvas, context } = surface();
        const presenter = new LiveFramePresenter(canvas);
        const colours = [];
        Object.defineProperty(context, 'strokeStyle', {
            set(value) {
                if (String(value).startsWith('hsl(')) colours.push(value);
            },
        });
        const frame = { width: 640, height: 360 };
        const track = { id: 'animal-a', className: 'Fish', bboxNormalized: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5 } };

        const first = presenter.present({ frame, frameNumber: 10, tracks: [track] });
        animationCallbacks.shift()();
        await first;
        const second = presenter.present({ frame, frameNumber: 11, tracks: [track] });
        animationCallbacks.shift()();
        await second;

        expect(colours[0]).toBe(colours[1]);
        presenter.reset();
        expect(presenter.trackFirstFrame.size).toBe(0);
        expect(presenter.presentedFrames).toBe(0);
    });
});
