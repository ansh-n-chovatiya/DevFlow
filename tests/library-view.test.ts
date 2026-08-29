import { describe, expect, it } from 'vitest';
import type { FlowMeta, Step } from '../src/shared/types.js';
import {
  deriveLibraryView,
  THUMBNAIL_LIMIT,
  type LibraryInput,
} from '../src/ui/viewer/library-view.js';

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;

const flow = (over: Partial<FlowMeta> = {}): FlowMeta => ({
  id: 'flow_1',
  name: 'Checkout',
  createdAt: NOW - 5 * MINUTE,
  stepCount: 8,
  host: 'shop.example.com',
  bytes: 400_000,
  thumbnail: 'data:image/jpeg;base64,AAA',
  counts: { click: 5, input: 3 },
  errorCount: 0,
  ...over,
});

const step = (over: Partial<Step> = {}): Step =>
  ({
    type: 'click',
    url: 'https://shop.example.com/cart',
    timestamp: NOW - MINUTE,
    action: 'Clicked "Buy"',
    element: { tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null },
    ...over,
  }) as Step;

function input(over: Partial<LibraryInput> = {}): LibraryInput {
  return {
    flows: [flow()],
    current: { steps: [], recording: 'idle' },
    usedBytes: 1_000_000,
    query: '',
    sort: 'recent',
    now: NOW,
    ...over,
  };
}

describe('loading', () => {
  it('waits for both the index and the recording before showing anything', () => {
    // Painting the list first and dropping the current-flow card in a moment
    // later moves everything below it down the page.
    expect(deriveLibraryView(input({ flows: null })).body).toBe('loading');
    expect(deriveLibraryView(input({ current: null })).body).toBe('loading');
  });

  it('offers no search box while there is nothing to search', () => {
    expect(deriveLibraryView(input({ flows: null })).searchable).toBe(false);
    expect(deriveLibraryView(input({ flows: [] })).searchable).toBe(false);
    expect(deriveLibraryView(input()).searchable).toBe(true);
  });
});

describe('empty', () => {
  it('is empty only when there is neither a library nor a recording', () => {
    expect(deriveLibraryView(input({ flows: [] })).body).toBe('empty');

    // An unsaved recording is something to show, so the page is not empty.
    const withRecording = deriveLibraryView(
      input({ flows: [], current: { steps: [step()], recording: 'idle' } }),
    );
    expect(withRecording.body).toBe('list');
    expect(withRecording.current?.status).toBe('unsaved');
  });
});

describe('the current-flow card', () => {
  it('separates a running recording from one that has stopped', () => {
    const steps = [step()];

    expect(
      deriveLibraryView(input({ current: { steps, recording: 'recording' } })).current?.status,
    ).toBe('recording');
    expect(
      deriveLibraryView(input({ current: { steps, recording: 'paused' } })).current?.status,
    ).toBe('paused');
    expect(deriveLibraryView(input({ current: { steps, recording: 'idle' } })).current?.status).toBe(
      'unsaved',
    );
  });

  it('caps the thumbnails and counts the rest', () => {
    const steps = Array.from({ length: 7 }, () => step({ screenshot: 'data:image/jpeg;base64,A' }));
    const { current } = deriveLibraryView(input({ current: { steps, recording: 'idle' } }));

    expect(current?.thumbnails).toHaveLength(THUMBNAIL_LIMIT);
    expect(current?.extra).toBe(7 - THUMBNAIL_LIMIT);
  });

  it('counts only the steps that actually have an image', () => {
    const steps = [step({ screenshot: 'data:image/jpeg;base64,A' }), step()];
    const { current } = deriveLibraryView(input({ current: { steps, recording: 'idle' } }));

    expect(current?.thumbnails).toHaveLength(1);
    expect(current?.extra).toBe(0);
    expect(current?.stepCount).toBe(2);
  });

  it('reports its own failures, so a broken recording is visible before opening it', () => {
    const steps = [step({ consoleLogs: [{ level: 'error', args: ['x'], timestamp: NOW }] })];
    expect(deriveLibraryView(input({ current: { steps, recording: 'idle' } })).current?.failures).toBe(
      1,
    );
  });
});

describe('rows', () => {
  it('carries what the index knows', () => {
    const [row] = deriveLibraryView(input()).flows;

    expect(row.name).toBe('Checkout');
    expect(row.host).toBe('shop.example.com');
    expect(row.size).toBe(400_000);
    expect(row.when).toBe('5 minutes ago');
    // Largest first, so the row's chips read as a shape rather than an order.
    expect(row.counts).toEqual([
      { type: 'click', count: 5 },
      { type: 'input', count: 3 },
    ]);
  });

  it('degrades for a flow saved before the index carried any of that', () => {
    // Optional fields exist because existing recordings must keep loading; a
    // list that refuses to render an old flow is worse than a plain row.
    const old: FlowMeta = { id: 'flow_0', name: 'Old', createdAt: NOW - MINUTE, stepCount: 3 };
    const [row] = deriveLibraryView(input({ flows: [old] })).flows;

    expect(row.host).toBeNull();
    expect(row.size).toBeNull();
    expect(row.thumbnail).toBeNull();
    expect(row.counts).toEqual([]);
    expect(row.failures).toBe(0);
  });

  it('falls back to a date once "ago" stops being useful', () => {
    const old = flow({ createdAt: new Date(2026, 7, 14, 9, 32).getTime() });
    const [row] = deriveLibraryView(input({ flows: [old], now: new Date(2026, 8, 1).getTime() }))
      .flows;

    expect(row.when).toBe('14 Aug, 09:32');
  });
});

describe('search', () => {
  const flows = [
    flow({ id: 'a', name: 'Checkout', host: 'shop.example.com' }),
    flow({ id: 'b', name: 'Login', host: 'auth.example.org' }),
  ];

  it('matches a name or a host, case-insensitively', () => {
    expect(deriveLibraryView(input({ flows, query: 'check' })).flows.map((r) => r.id)).toEqual(['a']);
    expect(deriveLibraryView(input({ flows, query: 'AUTH' })).flows.map((r) => r.id)).toEqual(['b']);
  });

  it('has its own state when nothing matches, distinct from an empty library', () => {
    const view = deriveLibraryView(input({ flows, query: 'zzz' }));

    expect(view.body).toBe('no-matches');
    expect(view.flows).toHaveLength(0);
  });
});

describe('sorting', () => {
  const flows = [
    flow({ id: 'a', name: 'Beta', createdAt: NOW - MINUTE, bytes: 100 }),
    flow({ id: 'b', name: 'Alpha', createdAt: NOW - 10 * MINUTE, bytes: 900 }),
    flow({ id: 'c', name: 'Gamma', createdAt: NOW - 5 * MINUTE, bytes: undefined }),
  ];

  it('orders by recency, size or name', () => {
    expect(deriveLibraryView(input({ flows, sort: 'recent' })).flows.map((r) => r.id)).toEqual([
      'a',
      'c',
      'b',
    ]);
    expect(deriveLibraryView(input({ flows, sort: 'name' })).flows.map((r) => r.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });

  it('sorts a flow of unknown size last, not first', () => {
    // Someone opening a size ordering is looking for something to delete.
    // Treating "unknown" as zero would put the old flows at the top.
    expect(deriveLibraryView(input({ flows, sort: 'largest' })).flows.map((r) => r.id)).toEqual([
      'b',
      'a',
      'c',
    ]);
  });
});

describe('storage', () => {
  it('reports usage as a figure, with no ceiling to compare it against', () => {
    expect(deriveLibraryView(input({ usedBytes: 2_621_440 })).storage).toEqual({
      usedBytes: 2_621_440,
    });
  });

  it('reports nothing at all until usage has been measured', () => {
    expect(deriveLibraryView(input({ usedBytes: null })).storage).toBeNull();
  });

  it('never implies a limit, however large the library gets', () => {
    // The old copy read "9.8 MB of 10.0 MB used".
    const summary = deriveLibraryView(input({ usedBytes: 524_288_000 })).summary;
    expect(summary).not.toMatch(/of|used|limit|MB/);
  });
});

describe('the summary line', () => {
  it('counts saved flows and their steps', () => {
    const summary = deriveLibraryView(
      input({ flows: [flow({ stepCount: 4 }), flow({ id: 'x', stepCount: 9 })] }),
    ).summary;
    expect(summary).toBe('2 flows · 13 steps');
  });

  it('says nothing is saved rather than "0 flows" above a visible recording', () => {
    const summary = deriveLibraryView(input({ flows: [], usedBytes: 3_100_000 })).summary;
    expect(summary).toBe('Nothing saved yet');
    // The bytes belong to the unsaved recording below it, so pairing them with a
    // count of zero read as a contradiction.
    expect(summary).not.toMatch(/0|MB/);
  });

  it('is singular for one of each', () => {
    expect(deriveLibraryView(input({ flows: [flow({ stepCount: 1 })] })).summary).toBe(
      '1 flow · 1 step',
    );
  });
});
