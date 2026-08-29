import { describe, expect, it } from 'vitest';
import type { Preflight, RecordingTarget } from '../src/features/recording/preflight.js';
import { flowError } from '../src/shared/errors.js';
import { ERROR_TTL_MS, MAX_STEPS, WARN_STEPS } from '../src/shared/constants.js';
import type { LocateResult, Step } from '../src/shared/types.js';
import { pos1 } from '../src/core/react/positions.js';
import {
  derivePopupView,
  parseLocateHash,
  parseLocated,
  toLocated,
  THUMBNAIL_LIMIT,
  type Located,
  type LocateState,
  type PopupInput,
} from '../src/ui/popup/view.js';

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

/** Nothing has been located and nothing is being located: the ordinary popup. */
const NO_LOCATE: LocateState = {
  phase: 'starting',
  component: null,
  answer: null,
  stopped: null,
};

function located(overrides: Partial<Located> = {}): Located {
  return {
    component: 'CheckoutButton',
    source: {
      name: 'CheckoutButton',
      status: 'resolved',
      via: 'bundle-search',
      source: 'src/checkout/CheckoutButton.tsx',
      line: pos1(42),
      column: pos1(3),
    },
    resourcesSearched: 4,
    host: 'shop.test',
    at: NOW - 60_000,
    ...overrides,
  };
}

function input(overrides: Partial<PopupInput> = {}): PopupInput {
  return {
    surface: 'toolbar',
    locate: NO_LOCATE,
    recent: null,
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

describe('a tab DevFlow has not attached to', () => {
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
    expect(view.notice?.title).toBe("DevFlow can't record this tab");
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

  it('names the disk, not the product, when there is no room to write', () => {
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

describe('the locate action', () => {
  it('sits beside Start, on any tab a component could be picked on', () => {
    for (const preflight of [READY, NEEDS_ATTACH]) {
      const view = derivePopupView(input({ preflight }));
      expect(view.locateAction).toEqual({ label: 'Locate component', disabled: false });
    }
  });

  it('is offered during a recording, because picking and recording are independent', () => {
    // One agent, two switches. The picker swallows its own click before the
    // recorder sees it, so locating mid-recording costs the flow nothing.
    const view = derivePopupView(input({ recording: 'recording', steps: [step()] }));

    expect(view.body).toBe('live');
    expect(view.locateAction?.disabled).toBe(false);
  });

  it('is disabled on a tab that will never hold a content script', () => {
    expect(derivePopupView(input({ preflight: BLOCKED })).locateAction).toEqual({
      label: 'Locate component',
      disabled: true,
    });
  });

  it('is disabled while a recording runs on a tab that has not been probed', () => {
    // Enabled by evidence, not by default: arming a picker on a tab nothing is
    // known about is how the window ends up waiting on a page that cannot answer.
    const view = derivePopupView(input({ recording: 'recording', preflight: null }));
    expect(view.locateAction?.disabled).toBe(true);
  });

  it('offers nothing at all until the tab has been looked at', () => {
    expect(derivePopupView(input({ preflight: null })).locateAction).toBeNull();
  });
});

describe('the last locate', () => {
  it('is still there the next time the popup opens', () => {
    // The whole point of writing it down: the window that asked for this answer
    // was dismissed by the click that produced it.
    const view = derivePopupView(input({ recent: located() }));

    expect(view.recent?.component).toBe('CheckoutButton');
    expect(view.recent?.source.source).toBe('src/checkout/CheckoutButton.tsx');
  });

  it('survives a tab that cannot be picked on', () => {
    // It is a component from another page. This tab being unpickable says
    // nothing about whether that answer is still wanted.
    expect(derivePopupView(input({ preflight: BLOCKED, recent: located() })).recent).not.toBeNull();
  });

  it('gets out of the way of a live recording', () => {
    const view = derivePopupView(input({ recording: 'recording', recent: located() }));
    expect(view.recent).toBeNull();
  });
});

describe('the locate window', () => {
  function locateInput(locate: Partial<LocateState>, overrides: Partial<PopupInput> = {}) {
    return derivePopupView(
      input({ surface: 'locate', locate: { ...NO_LOCATE, ...locate }, ...overrides }),
    );
  }

  it('shows the locate body and nothing else, even mid-recording', () => {
    // A Stop button beside a live picker is one mis-click from ending a
    // recording the user was only trying to locate inside of.
    const view = locateInput({ phase: 'picking' }, { recording: 'recording', steps: [step()] });

    expect(view.body).toBe('locate');
    expect(view.live).toBeNull();
    expect(view.primary).toBeNull();
    expect(view.storage).toBeNull();
    // The dot still says a recording is running, as it does on every surface.
    expect(view.recording).toBe('recording');
  });

  it('names the tab it is picking on rather than one it would record', () => {
    expect(locateInput({ phase: 'picking' }).targetLabel).toBe('This tab');
    expect(derivePopupView(input()).targetLabel).toBe('Recording target');
  });

  it('says the window stays open, which is the one thing the user has to know', () => {
    const view = locateInput({ phase: 'picking' });

    expect(view.locate?.status).toContain('Click a component on the page');
    expect(view.locate?.status).toContain('stays open');
    // Cancel is offered exactly while there is a pick to cancel.
    expect(view.locate?.cancel).toBe(true);
    expect(view.locate?.busy).toBe(false);
    expect(view.locate?.pick).toBeNull();
  });

  it('spins only while the extension is the one working', () => {
    // Waiting for a click is the user's half of the gesture. A spinner over it
    // would claim the extension was busy when it was the user who had not moved.
    expect(locateInput({ phase: 'picking' }).locate?.busy).toBe(false);
    expect(locateInput({ phase: 'starting' }).locate?.busy).toBe(true);
    expect(locateInput({ phase: 'locating', component: 'Cart' }).locate?.busy).toBe(true);
  });

  it('names the component it is looking for while it looks', () => {
    expect(locateInput({ phase: 'locating', component: 'Cart' }).locate?.status).toBe(
      'Finding where Cart was written.',
    );
  });

  it('shows the card and offers another pick once there is an answer', () => {
    const answer = located();
    const view = locateInput({ phase: 'answered', component: answer.component, answer });

    expect(view.locate?.answer).toBe(answer);
    expect(view.locate?.pick).toEqual({ label: 'Pick another' });
    expect(view.locate?.status).toBe('Picked on shop.test.');
    expect(view.locate?.cancel).toBe(false);
    expect(view.locate?.notice).toBeNull();
  });

  it('says nothing at all about a pick the user cancelled', () => {
    // Escape is a decision, not a failure. A banner explaining it would be the
    // window arguing with something the user just did on purpose.
    const view = locateInput({ phase: 'stopped', stopped: null });

    expect(view.locate?.notice).toBeNull();
    expect(view.locate?.status).toBe('Nothing picked.');
    expect(view.locate?.pick).toEqual({ label: 'Pick component' });
  });

  it('carries the picker’s own sentence when the pick found nothing', () => {
    const view = locateInput({
      phase: 'stopped',
      stopped: 'No React component found here. Is this page built with React?',
    });

    expect(view.locate?.notice?.tone).toBe('warn');
    expect(view.locate?.notice?.body).toContain('No React component found here');
    expect(view.locate?.pick?.label).toBe('Pick component');
  });
});

describe('the hand-off between the two windows', () => {
  it('reads the tab id a locate window was opened for', () => {
    expect(parseLocateHash('#locate=7')).toBe(7);
  });

  it('treats anything else as the ordinary popup', () => {
    // A window whose hash did not survive is the toolbar popup, which shows the
    // recording controls — not a locate window pointed at NaN.
    for (const hash of ['', '#', '#locate=', '#locate=abc', '#locate=7x', '#/current', '#locate']) {
      expect(parseLocateHash(hash)).toBeNull();
    }
  });

  it('keeps the card’s inputs and the page it was picked on', () => {
    const result: LocateResult = {
      component: 'Cart',
      source: { name: 'Cart', status: 'not-found', detail: 'Nowhere to be found.' },
      ancestry: [{ name: 'Cart' }],
      siblings: [],
      resourcesSearched: 9,
    };

    expect(toLocated(result, 'shop.test', NOW)).toEqual({
      component: 'Cart',
      source: result.source,
      resourcesSearched: 9,
      host: 'shop.test',
      at: NOW,
    });
  });

  it('reads back what it wrote', () => {
    const answer = located();
    expect(parseLocated(JSON.parse(JSON.stringify(answer)))).toEqual(answer);
  });

  it('refuses a record it would have to render undefined from', () => {
    // Written by a build that may be two versions old. A name and a status are
    // the two fields every renderer here dereferences.
    const answer = located();

    expect(parseLocated(null)).toBeNull();
    expect(parseLocated('lastLocate')).toBeNull();
    expect(parseLocated({ ...answer, component: '' })).toBeNull();
    expect(parseLocated({ ...answer, source: undefined })).toBeNull();
    expect(parseLocated({ ...answer, source: { status: 'resolved' } })).toBeNull();
    expect(parseLocated({ ...answer, at: undefined })).toBeNull();
  });

  it('fills in what an older record can do without', () => {
    const older = located();
    delete (older as Partial<Located>).resourcesSearched;
    delete (older as Partial<Located>).host;

    expect(parseLocated(older)).toMatchObject({ resourcesSearched: 0, host: '' });
  });
});
