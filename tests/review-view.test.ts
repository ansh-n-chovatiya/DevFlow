import { describe, expect, it } from 'vitest';
import type {
  ComponentSource,
  ConsoleEntry,
  FlowReact,
  NetworkCall,
  Step,
} from '../src/shared/types.js';
import {
  deriveReviewView,
  firstVisibleIndex,
  STEP_ICON,
  type ReviewInput,
} from '../src/ui/viewer/review-view.js';

const NOW = 1_700_000_000_000;

const call = (over: Partial<NetworkCall> = {}): NetworkCall => ({
  method: 'GET',
  url: 'https://example.com/api',
  requestHeaders: {},
  requestBody: null,
  status: 200,
  responseHeaders: {},
  responseBody: null,
  durationMs: 12,
  timestamp: NOW,
  ...over,
});

const log = (level: ConsoleEntry['level']): ConsoleEntry => ({
  level,
  args: ['boom'],
  timestamp: NOW,
});

const step = (over: Partial<Step> = {}): Step =>
  ({
    type: 'click',
    url: 'https://example.com/',
    timestamp: NOW,
    action: 'Clicked "Save"',
    element: { tag: 'button', cssSelector: '#save', xpath: '/html/body/button', boundingBox: null },
    ...over,
  }) as Step;

function input(over: Partial<ReviewInput> = {}): ReviewInput {
  return {
    flow: { id: 'flow_1', name: 'Checkout', steps: [step()], createdAt: NOW - 60_000, react: null, settings: null },
    missing: false,
    filter: 'all',
    activeIndex: null,
    recording: 'idle',
    now: NOW,
    editor: null,
    ...over,
  };
}

describe('the states before there are steps', () => {
  it('shows a skeleton while the flow is being read', () => {
    const view = deriveReviewView(input({ flow: null }));

    expect(view.body).toBe('loading');
    expect(view.header).toBeNull();
    expect(view.canExport).toBe(false);
  });

  it('says a deleted flow is gone rather than spinning forever', () => {
    // A flow deleted in another tab never finishes arriving, so `missing` has to
    // outrank `loading` — otherwise the skeleton is permanent.
    const view = deriveReviewView(input({ flow: null, missing: true }));
    expect(view.body).toBe('missing');
  });

  it('keeps the header and the filters on an empty flow', () => {
    const view = deriveReviewView(
      input({ flow: { id: 'flow_1', name: 'Checkout', steps: [], createdAt: NOW, react: null, settings: null } }),
    );

    expect(view.body).toBe('empty');
    expect(view.header?.name).toBe('Checkout');
    expect(view.canExport).toBe(false);
    expect(view.filters).toHaveLength(5);
  });
});

describe('the header', () => {
  it('reports the count, the host and when it was recorded', () => {
    const view = deriveReviewView(input());

    expect(view.header).toEqual({
      name: 'Checkout',
      renameable: true,
      stepCount: 1,
      host: 'example.com',
      when: '1 minute ago',
      // A flow recorded on a page that is not React says nothing about it.
      components: '',
    });
  });

  it('will not offer to rename the live recording, which has no stored name', () => {
    const view = deriveReviewView(
      input({
        flow: { id: null, name: 'Current recording', steps: [step()], createdAt: NOW, react: null, settings: null },
      }),
    );

    expect(view.header?.renameable).toBe(false);
    expect(view.canSave).toBe(true);
    expect(view.canDelete).toBe(false);
  });

  it('marks the flow live only while the recorder is actually running', () => {
    const live = { id: null, name: 'Current recording', steps: [step()], createdAt: NOW, react: null, settings: null };

    expect(deriveReviewView(input({ flow: live, recording: 'recording' })).live).toBe(true);
    expect(deriveReviewView(input({ flow: live, recording: 'paused' })).live).toBe(true);
    expect(deriveReviewView(input({ flow: live, recording: 'idle' })).live).toBe(false);
    // A saved flow is never live, whatever the recorder is doing elsewhere.
    expect(deriveReviewView(input({ recording: 'recording' })).live).toBe(false);
  });
});

describe('the step card', () => {
  it('leads with the action and carries the type icon the rail uses', () => {
    const [card] = deriveReviewView(input()).steps;

    expect(card.action).toBe('Clicked "Save"');
    expect(card.icon).toBe(STEP_ICON.click);
    expect(card.number).toBe(1);
  });

  it('shows the URL on the first step, then only when it changes', () => {
    const steps = [
      step({ url: 'https://example.com/a' }),
      step({ url: 'https://example.com/a' }),
      step({ url: 'https://example.com/b' }),
    ];
    const view = deriveReviewView(
      input({ flow: { id: 'f', name: 'n', steps, createdAt: NOW, react: null, settings: null } }),
    );

    // A URL repeated on thirty cards is noise; a URL that changed is the story.
    expect(view.steps.map((card) => card.urlReason)).toEqual(['started', null, 'changed']);
  });

  it('summarises network and console without expanding them', () => {
    const steps = [
      step({
        networkCalls: [call({ status: 200 }), call({ status: 500 })],
        consoleLogs: [log('log'), log('warn')],
      }),
    ];
    const [card] = deriveReviewView(
      input({ flow: { id: 'f', name: 'n', steps, createdAt: NOW, react: null, settings: null } }),
    ).steps;

    expect(card.network).toEqual({ count: 2, worst: '5xx' });
    expect(card.console).toEqual({ count: 2, worst: 'warn' });
  });

  it('has no selectors row for a step with no element', () => {
    const steps = [step({ type: 'navigate', title: 'Home', element: undefined })];
    const [card] = deriveReviewView(
      input({ flow: { id: 'f', name: 'n', steps, createdAt: NOW, react: null, settings: null } }),
    ).steps;

    expect(card.selectors).toBeNull();
    expect(card.network).toBeNull();
    expect(card.console).toBeNull();
  });
});

describe('elapsed time', () => {
  it('has none on the first step, because there is nothing to be elapsed from', () => {
    expect(deriveReviewView(input()).steps[0].delta).toBeNull();
  });

  it('is measured against the previous step in the flow, never the filtered list', () => {
    const steps = [
      step({ timestamp: NOW }),
      step({ type: 'input', value: 'x', timestamp: NOW + 1000 }),
      step({ timestamp: NOW + 90_000, consoleLogs: [log('error')] }),
    ];

    const all = deriveReviewView(
      input({ flow: { id: 'f', name: 'n', steps, createdAt: NOW, react: null, settings: null } }),
    );
    expect(all.steps.map((card) => card.delta)).toEqual([null, '+1.0s', '+1m 29s']);

    // Filtering to errors leaves only the third step. Reading "+1.0s" off it —
    // its delta from the previous *shown* card — would be a lie the user has no
    // way to catch.
    const errors = deriveReviewView(
      input({
        flow: { id: 'f', name: 'n', steps, createdAt: NOW, react: null, settings: null },
        filter: 'errors',
      }),
    );
    expect(errors.steps).toHaveLength(1);
    expect(errors.steps[0].delta).toBe('+1m 29s');
    expect(errors.steps[0].number).toBe(3);
  });
});

describe('filters', () => {
  const steps = [
    step({ type: 'navigate', title: 'Home', element: undefined }),
    step({ type: 'click' }),
    step({ type: 'click', networkCalls: [call({ status: 500 })] }),
    step({ type: 'input', value: 'ada@' }),
  ];
  const flow = { id: 'f', name: 'n', steps, createdAt: NOW, react: null, settings: null };

  it('counts every filter, whichever one is active', () => {
    const view = deriveReviewView(input({ flow }));

    expect(view.filters.map((chip) => [chip.id, chip.count])).toEqual([
      ['all', 4],
      ['click', 2],
      ['input', 1],
      ['navigate', 1],
      ['errors', 1],
    ]);
    expect(view.failures).toBe(1);
  });

  it('offers a filter that would empty the list, but does not let it be pressed', () => {
    const noErrors = { ...flow, steps: [step({ type: 'click' })] };
    const view = deriveReviewView(input({ flow: noErrors }));

    const errors = view.filters.find((chip) => chip.id === 'errors');
    expect(errors?.count).toBe(0);
    expect(errors?.disabled).toBe(true);

    // `all` stays pressable at zero: it is the way back from a filter that
    // emptied the list.
    expect(view.filters.find((chip) => chip.id === 'all')?.disabled).toBe(false);
  });

  it('narrows the rail and the cards together, and keeps the real step numbers', () => {
    const view = deriveReviewView(input({ flow, filter: 'click' }));

    expect(view.body).toBe('steps');
    expect(view.rail.map((row) => row.number)).toEqual([2, 3]);
    expect(view.steps.map((card) => card.number)).toEqual([2, 3]);
    expect(view.rail[1].failed).toBe(true);
  });

  it('has its own empty state when a filter matches nothing', () => {
    // Reachable by deleting the last error while the Errors filter is on, which
    // is exactly when a bare "no steps" would look like data loss.
    const view = deriveReviewView(
      input({ flow: { ...flow, steps: [step()] }, filter: 'navigate' }),
    );

    expect(view.body).toBe('no-matches');
    expect(view.steps).toHaveLength(0);
    expect(view.canExport).toBe(true);
  });
});

describe('the active step', () => {
  it('marks the same step in the rail and in the list', () => {
    const steps = [step(), step({ type: 'input', value: 'x' })];
    const view = deriveReviewView(
      input({
        flow: { id: 'f', name: 'n', steps, createdAt: NOW, react: null, settings: null },
        activeIndex: 1,
      }),
    );

    expect(view.rail.map((row) => row.active)).toEqual([false, true]);
    expect(view.steps.map((card) => card.active)).toEqual([false, true]);
  });
});

describe('the React component on a step', () => {
  const chained = (chain: string[]) =>
    step({
      element: {
        tag: 'button',
        cssSelector: '#save',
        xpath: '/html/body/button',
        boundingBox: null,
        react: { chain },
      },
    });

  const react = (components: Record<string, ComponentSource>): FlowReact => ({
    detected: true,
    build: 'production',
    components,
  });

  const view = (steps: Step[], components: Record<string, ComponentSource>) =>
    deriveReviewView(
      input({ flow: { id: 'f', name: 'n', steps, createdAt: NOW, react: react(components), settings: null } }),
    );

  it('names the feature component behind a shared primitive', () => {
    const [card] = view([chained(['checkout', 'button'])], {
      checkout: {
        name: 'CheckoutButton',
        status: 'resolved',
        source: 'src/components/checkout/CheckoutButton.tsx',
        line: 42,
      },
      button: { name: 'Button', status: 'resolved', source: 'src/components/ui/Button.tsx', line: 8 },
    }).steps;

    // The card and the Markdown say the same thing, in the same words.
    expect(card.component?.name).toBe('Button');
    expect(card.component?.within).toBe('CheckoutButton');
  });

  it('is null on every card when the flow carries no components', () => {
    const plain = deriveReviewView(input({ flow: { id: 'f', name: 'n', steps: [chained(['cart'])], createdAt: NOW, react: null, settings: null } }));
    expect(plain.steps[0].component).toBeNull();
  });

  it('names the owning component and where it was written', () => {
    const [card] = view([chained(['app', 'cart'])], {
      app: { name: 'App', status: 'resolved', source: 'src/App.tsx', line: 1 },
      cart: { name: 'AddToCartButton', status: 'resolved', source: 'src/Cart.tsx', line: 34 },
    }).steps;

    expect(card.component).toEqual({
      name: 'AddToCartButton',
      // Nothing to add: the owner already names something specific.
      within: null,
      source: 'src/Cart.tsx:34',
      detail: null,
      dependency: false,
      editorUrl: null,
    });
  });

  it('offers an editor link once there is a project root to resolve against', () => {
    const [card] = deriveReviewView(
      input({
        flow: {
          id: 'f',
          name: 'n',
          steps: [chained(['cart'])],
          createdAt: NOW,
          react: react({
            cart: { name: 'AddToCartButton', status: 'resolved', source: 'src/Cart.tsx', line: 34 },
          }),
          settings: null,
        },
        editor: { projectRoot: '/Users/me/shop', template: 'vscode://file/{path}:{line1}:{col1}' },
      }),
    ).steps;

    // `vscode://file/` + an absolute path, so the doubled slash is correct.
    expect(card.component?.editorUrl).toBe('vscode://file//Users/me/shop/src/Cart.tsx:34:1');
  });

  it('offers no link for a component that never resolved to a file', () => {
    const [card] = deriveReviewView(
      input({
        flow: {
          id: 'f',
          name: 'n',
          steps: [chained(['lazy'])],
          createdAt: NOW,
          react: react({ lazy: { name: 'LazyModal', status: 'not-found' } }),
          settings: null,
        },
        editor: { projectRoot: '/Users/me/shop', template: 'vscode://file/{path}:{line1}:{col1}' },
      }),
    ).steps;

    expect(card.component?.editorUrl).toBeNull();
  });

  it('gives an unresolved component its reason instead of a blank row', () => {
    const [card] = view([chained(['lazy'])], {
      lazy: { name: 'LazyModal', status: 'not-found', detail: 'Its chunk was never loaded.' },
    }).steps;

    expect(card.component?.source).toBeNull();
    expect(card.component?.detail).toBe('Its chunk was never loaded.');
  });

  it('marks a component that turned out to live in node_modules', () => {
    const [card] = view([chained(['base'])], {
      base: {
        name: 'ButtonBase',
        status: 'resolved',
        source: 'node_modules/@mui/material/ButtonBase.js',
        line: 12,
        dependency: true,
      },
    }).steps;

    expect(card.component?.dependency).toBe(true);
  });

  it('summarises the whole table once, in the header', () => {
    const header = view([chained(['a', 'b'])], {
      a: { name: 'App', status: 'resolved', source: 'src/App.tsx', line: 1 },
      b: { name: 'Cart', status: 'pending' },
    }).header;

    expect(header?.components).toBe('2 components · 1 resolved');
  });
});

/**
 * The active step is an index into the whole flow, but the list on screen is
 * filtered — so a selection left on a hidden step pointed Delete at something
 * the user could not see.
 */
describe('firstVisibleIndex', () => {
  const steps = [
    { type: 'click', action: 'a', url: 'u', timestamp: 1, stepNumber: 1, screenshot: null },
    { type: 'navigate', action: 'b', url: 'u', timestamp: 2, stepNumber: 2, screenshot: null },
    { type: 'click', action: 'c', url: 'u', timestamp: 3, stepNumber: 3, screenshot: null },
  ] as unknown as Step[];

  it('finds the first step the filter actually shows', () => {
    expect(firstVisibleIndex(steps, 'navigate')).toBe(1);
    expect(firstVisibleIndex(steps, 'click')).toBe(0);
    expect(firstVisibleIndex(steps, 'all')).toBe(0);
  });

  it('reports nothing to select when the filter hides everything', () => {
    expect(firstVisibleIndex(steps, 'errors')).toBeNull();
    expect(firstVisibleIndex([], 'all')).toBeNull();
  });
});
