/** Unit coverage for the inference worker's externally-fed player surface. */

const { LiveFramePresenter } = require('../../src/live-frame-presenter.js');

function surface() {
    const calls = [];
    const context = {
        drawImage: (...args) => calls.push(['image', ...args]),
        strokeRect: (...args) => calls.push(['box', ...args]),
        fillRect: (...args) => calls.push(['labelBackground', ...args]),
        strokeText: (...args) => calls.push(['strokeText', ...args]),
        fillText: (...args) => calls.push(['fillText', ...args]),
    };
    return {
        canvas: { width: 0, height: 0, getContext: () => context },
        context,
        calls,
        status: { textContent: '' },
        progress: { max: 0, value: 0 },
        jobContext: { textContent: '' },
    };
}

describe('LiveFramePresenter', () => {
    beforeEach(() => {
        jest.spyOn(performance, 'now').mockReturnValueOnce(1000).mockReturnValue(1100);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    test('draws the supplied frame, readable track identity, persistence, and status before acknowledging', async () => {
        const {
            canvas, calls, status, progress, jobContext,
        } = surface();
        const presenter = new LiveFramePresenter(canvas, {
            statusElement: status,
            progressElement: progress,
            contextElement: jobContext,
        });
        const frame = { width: 1000, height: 500 };

        let acknowledged = false;
        const first = presenter.present({
            frame,
            frameNumber: 40,
            rangeStart: 20,
            rangeEnd: 120,
            jobId: 98,
            modelName: 'rockfish5',
            speciesNames: ['Blue/Deacon Rockfish', 'Lingcod'],
            tracks: [{ trackId: 7, species: 'California sea cucumber', confidence: 0.87, box: [0.5, 0.5, 0.2, 0.4] }],
        }).then((result) => {
            acknowledged = true;
            return result;
        });

        expect(canvas).toMatchObject({ width: 1000, height: 500 });
        expect(calls[0]).toEqual(['image', frame, 0, 0, 1000, 500]);
        expect(calls).toContainEqual(['box', 400, 150, 200, 200]);
        expect(calls.some((call) => call[0] === 'fillText'
            && call[1] === 'California sea cucumber' && call[2] === 500)).toBe(true);
        expect(calls.some((call) => call[0] === 'fillText'
            && call[1] === '87%  #7  1f' && call[2] === 500)).toBe(true);
        expect(calls.some((call) => call[0] === 'strokeText')).toBe(false);
        expect(status.textContent).toMatch(/^Frame 40\s+·\s+21 \/ 100\s+·\s+[\d.]+ fps\s+·\s+1 live$/);
        expect(progress).toMatchObject({ max: 100, value: 21 });
        expect(jobContext.textContent).toBe(
            'Job 98  |  Model rockfish5  |  Blue/Deacon Rockfish  ·  Lingcod',
        );
        expect(acknowledged).toBe(false);

        expect(await first).toMatchObject({ frameNumber: 40, liveTracks: 1 });

        const second = presenter.present({
            frame,
            frameNumber: 43,
            tracks: [{ trackId: 7, species: 'California sea cucumber', confidence: 0.87, box: [0.5, 0.5, 0.2, 0.4] }],
        });
        expect(calls.some((call) => call[0] === 'fillText'
            && call[1] === '87%  #7  4f')).toBe(true);
        await second;
    });

    test('keeps one stable colour per species and resets persistence for another job', async () => {
        const { canvas, context } = surface();
        const presenter = new LiveFramePresenter(canvas);
        const colours = [];
        Object.defineProperty(context, 'strokeStyle', {
            set(value) {
                if (String(value).startsWith('hsl(')) colours.push(value);
            },
        });
        const frame = { width: 640, height: 360 };
        const firstTrack = { id: 'animal-a', className: 'Fish', bboxNormalized: { x1: 0.1, y1: 0.2, x2: 0.4, y2: 0.5 } };
        const secondTrack = { ...firstTrack, id: 'animal-b' };
        const otherSpecies = { ...firstTrack, id: 'animal-c', className: 'Crab' };

        const first = presenter.present({ frame, frameNumber: 10, tracks: [firstTrack] });
        await first;
        const second = presenter.present({ frame, frameNumber: 11, tracks: [secondTrack] });
        await second;

        const third = presenter.present({ frame, frameNumber: 12, tracks: [otherSpecies] });
        await third;

        expect(colours[0]).toBe(colours[1]);
        expect(colours[2]).not.toBe(colours[0]);
        presenter.reset();
        expect(presenter.trackFirstFrame.size).toBe(0);
        expect(presenter.presentedFrames).toBe(0);
    });
});
