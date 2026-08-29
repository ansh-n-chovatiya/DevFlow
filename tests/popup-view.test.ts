import { describe, expect, it } from 'vitest';
import type { Preflight, RecordingTarget } from '../src/features/recording/preflight.js';
import { flowError } from '../src/shared/errors.js';
import { ERROR_TTL_MS, MAX_STEPS, WARN_STEPS } from '../src/shared/constants.js';
import type { Step } from '../src/shared/types.js';
import { derivePopupView, THUMBNAIL_LIMIT, type PopupInput } from '../src/ui/popup/view.js';

const NOW = 1_700_000_000_000;

const TARGET: RecordingTarget = {
  tabId: 7,
  windowId: 1,
  url: 'https://github.com/anthropics/claude-code',
  host: 'github.com',
  title: 'claude-code',
};

const READY: Preflight = { status: 'ready', target: TARGET };
const NEEDS_ATTACH: Preflight = { status: 'needs-attach', target: TARGET };
const BLOCKED: Preflight = {
  status: 'blocked',
  error: flowError('TAB_NOT_RECORDABLE'),
  title: 'Extensions',
  url: 'chrome://extensions',
};

function step(overrides: Partial<Step> = {}): Step {
  return {
    type: 'click',
    url: 'https://github.com',
    timestamp: NOW - 5000,
    action: 'Clicked "Save changes"',
    element: { tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null },
    ...overrides,
  } as Step;
}

function input(overrides: Partial<PopupInput> = {}): PopupInput {
  return {
    preflight: READY,
    recording: 'idle',
    steps: [],
    startedAt: null,
    usedBytes: 0,
    lastError: null,
    now: NOW,
    // The recording's frozen `recording.warnSteps`, which the controller reads
    // from the snapshot. The default here so these cases keep describing the
    // shipped behaviour rather than a threshold the test picked.
    warnSteps: WARN_STEPS,
    // `ui.errorTtlMs`, read live by the controller, and here for the same
    // reason: these cases are about the shipped hour, not about a number a test
    // chose.
    errorTtlMs: ERROR_TTL_MS,
    ...overrides,
  };
}

describe('while the tab is still being resolved', () => {
  it('shows the loading skeleton and offers nothing', () => {
    const view = derivePopupView(input({ preflight: null }));

    expect(view.body).toBe('loading');
    expect(view.primary).toBeNull();
    // No storage reading either: a footer that appears a moment later moves
    // everything above it.
    expect(view.storage).toBeNull();
  });
});

describe('idle', () => {
  it('offers to start, and shows the empty state before anything is recorded', () => {
    const view = derivePopupView(input());

    expect(view.body).toBe('empty');
    expect(view.primary).toEqual({ label: 'Start recording', icon: 'circle-dot', disabled: false });
    expect(view.target?.host).toBe('github.com');
    expect(view.flow).toBeNull();
    expect(view.notice).toBeNull();
  });

  it('summarises a captured flow', () => {
    const steps = [
      step({ timestamp: NOW - 60_000, screenshot: 'data:image/jpeg;base64,a' }),
      step({ timestamp: NOW - 30_000, screenshot: 'data:image/jpeg;base64,b' }),
      step({ timestamp: NOW - 10_000 }),
    ];

    const view = derivePopupView(input({ steps }));

    expect(view.body).toBe('flow');
    expect(view.flow).toEqual({
      count: 3,
      lastAt: NOW - 10_000,
      thumbnails: ['data:image/jpeg;base64,a', 'data:image/jpeg;base64,b'],
      extra: 0,
    });
  });

  it('caps thumbnails and counts the rest', () => {
    const steps = Array.from({ length: 6 }, (_, index) =>
      step({ screenshot: `data:image/jpeg;base64,${index}` }),
    );

    const view = derivePopupView(input({ steps }));

    expect(view.flow?.thumbnails).toHaveLength(THUMBNAIL_LIMIT);
    // Newest last, so the strip reads in the order the steps happened.
    expect(view.flow?.thumbnails.at(-1)).toBe('data:image/jpeg;base64,5');
    expect(view.flow?.extra).toBe(3);
  });

  it('does not count steps whose capture failed as thumbnails', () => {
    const steps = [step({ screenshot: null }), step({ screenshot: undefined }), step()];

    const view = derivePopupView(input({ steps }));

    expect(view.flow?.count).toBe(3);
    expect(view.flow?.thumbnails).toEqual([]);
    expect(view.flow?.extra).toBe(0);
  });
});

describe('a tab FlowSnap has not attached to', () => {
  it('still offers to start, and explains what will be missing', () => {
    const view = derivePopupView(input({ preflight: NEEDS_ATTACH }));

    // The distinction that matters: recordable, just not yet listening. The old
    // build treated this as success and captured nothing.
    expect(view.primary?.disabled).toBe(false);
    expect(view.offerReload).toBe(true);
    expect(view.notice?.tone).toBe('info');
  });
});

describe('a tab that cannot be recorded', () => {
  it('disables the primary action and says why', () => {
    const view = derivePopupView(input({ preflight: BLOCKED }));

    expect(view.body).toBe('blocked');
    expect(view.primary?.disabled).toBe(true);
    expect(view.offerReload).toBe(false);
    expect(view.target).toBeNull();
    expect(view.blocked).toEqual({ title: 'Extensions', url: 'chrome://extensions' });
    expect(view.notice?.title).toBe("FlowSnap can't record this tab");
  });
});

describe('recording', () => {
  it('reports elapsed time, the count and the last thing captured', () => {
    const view = derivePopupView(
      input({
        recording: 'recording',
        startedAt: NOW - 47_000,
        steps: [step({ timestamp: NOW - 2000, action: 'Clicked "Save changes"' })],
      }),
    );

    expect(view.body).toBe('live');
    expect(view.live).toMatchObject({
      paused: false,
      elapsedMs: 47_000,
      count: 1,
      long: false,
      lastAction: 'Clicked "Save changes"',
      lastAgoMs: 2000,
    });
    // Nothing to start while something is already running.
    expect(view.primary).toBeNull();
  });

  it('reports an unknown start time rather than pretending it is zero', () => {
    const view = derivePopupView(input({ recording: 'recording', startedAt: null }));
    expect(view.live?.elapsedMs).toBeNull();
  });

  it('mentions a long flow only once it is one', () => {
    const ordinary = derivePopupView(
      input({ recording: 'recording', steps: Array.from({ length: WARN_STEPS - 1 }, () => step()) }),
    );
    expect(ordinary.live?.long).toBe(false);

    const long = derivePopupView(
      input({ recording: 'recording', steps: Array.from({ length: WARN_STEPS }, () => step()) }),
    );
    expect(long.live?.long).toBe(true);
  });

  it('keeps recording past the point the old build stopped', () => {
    // 30 steps was the cap when storage was capped too. A recorder that stops
    // mid-task makes the user repeat everything they just did.
    const view = derivePopupView(
      input({ recording: 'recording', steps: Array.from({ length: 200 }, () => step()) }),
    );
    expect(view.body).toBe('live');
    expect(view.live?.count).toBe(200);
    expect(MAX_STEPS).toBeGreaterThan(200);
  });

  it('keeps showing the recording even when the user switches to a blocked tab', () => {
    // A recording follows the user across tabs. Showing "can't record this tab"
    // over a live recording would be both wrong and alarming.
    const view = derivePopupView({
      ...input({ recording: 'recording', steps: [step()] }),
      preflight: BLOCKED,
    });

    expect(view.body).toBe('live');
    expect(view.blocked).toBeNull();
    expect(view.target).toBeNull();
  });

  it('is paused when it is paused', () => {
    const view = derivePopupView(input({ recording: 'paused', steps: [step()] }));
    expect(view.live?.paused).toBe(true);
    expect(view.recording).toBe('paused');
  });
});

describe('storage', () => {
  it('reports usage as a figure, with no ceiling to compare it against', () => {
    expect(derivePopupView(input({ usedBytes: 5_242_880 })).storage).toEqual({
      usedBytes: 5_242_880,
    });
  });

  it('reports nothing at all until usage has been measured', () => {
    expect(derivePopupView(input({ usedBytes: null })).storage).toBeNull();
  });

  it('never disables Start over how much is stored', () => {
    // The quota build greyed out Start at 10 MB, which was honest then: the next
    // step genuinely could not be written. There is no such point now, and a
    // dead Record button is the worst thing this popup could show.
    for (const usedBytes of [0, 10_485_760, 5_368_709_120]) {
      expect(derivePopupView(input({ usedBytes })).primary?.disabled).toBe(false);
    }
  });
});

describe('errors', () => {
  it('surfaces a recent failure over anything else it might have said', () => {
    const view = derivePopupView(
      input({
        preflight: NEEDS_ATTACH,
        lastError: { code: 'CAPTURE_FAILED', message: 'No image for that step.', at: NOW - 5000 },
      }),
    );

    expect(view.notice?.tone).toBe('warn');
    expect(view.notice?.body).toBe('No image for that step.');
  });

  it('ignores a failure old enough to be irrelevant', () => {
    const view = derivePopupView(
      input({
        lastError: { code: 'CAPTURE_FAILED', message: 'No image for that step.', at: NOW - 600_000 },
      }),
    );

    expect(view.notice).toBeNull();
  });

  it('names the disk, not FlowSnap, when there is no room to write', () => {
    // With `unlimitedStorage` this can only mean the disk. Saying "storage is
    // full" would send the user hunting for flows to delete, which would free
    // almost nothing and is the wrong place to look.
    const view = derivePopupView(
      input({
        lastError: { code: 'STORAGE_QUOTA', message: 'Out of space.', at: NOW - 1000 },
      }),
    );

    expect(view.notice?.tone).toBe('danger');
    expect(view.notice?.title).toBe('The disk is full');
  });
});
