import { describe, expect, it } from 'vitest';
import {
  buildFlowReact,
  countComponents,
  formatSource,
  pruneComponents,
  referencedComponentIds,
  stepOwner,
  stripReactRef,
  summarizeComponents,
} from '../src/core/react/attribution.js';
import { CAPPED_ID } from '../src/core/react/table.js';
import type { ComponentSource, Step } from '../src/shared/types.js';

const step = (chain: string[] | null, over: Partial<Step> = {}): Step =>
  ({
    type: 'click',
    url: 'https://app.example.com/cart',
    timestamp: 1_000,
    action: 'Clicked "Add to cart"',
    element: {
      tag: 'button',
      cssSelector: '#add',
      xpath: '/html[1]/body[1]/button[1]',
      boundingBox: null,
      ...(chain ? { react: { chain } } : {}),
    },
    ...over,
  }) as Step;

const resolved = (name: string, source: string, line = 34): ComponentSource => ({
  name,
  status: 'resolved',
  via: 'bundle-search',
  source,
  line,
});

describe('referencedComponentIds', () => {
  it('lists ids in reading order, outermost first, without repeats', () => {
    const steps = [step(['app', 'page', 'cart']), step(['app', 'page', 'button'])];
    expect(referencedComponentIds(steps)).toEqual(['app', 'page', 'cart', 'button']);
  });

  it('ignores steps with no element and steps with no chain', () => {
    expect(referencedComponentIds([step(null), { type: 'navigate' } as Step])).toEqual([]);
  });
});

describe('pruneComponents', () => {
  it('drops components whose only steps were deleted', () => {
    const table = {
      cart: resolved('Cart', 'src/Cart.tsx'),
      gone: resolved('Modal', 'src/Modal.tsx'),
    };

    expect(Object.keys(pruneComponents([step(['cart'])], table))).toEqual(['cart']);
  });

  it('keeps the cap marker, which is a fact about the flow rather than a step', () => {
    const table = {
      cart: resolved('Cart', 'src/Cart.tsx'),
      [CAPPED_ID]: { name: 'FlowSnap', status: 'skipped', detail: 'too many' } as ComponentSource,
    };

    expect(pruneComponents([step(['cart'])], table)[CAPPED_ID]).toBeDefined();
  });

  it('never invents an entry for an id the table does not have', () => {
    expect(pruneComponents([step(['unknown'])], {})).toEqual({});
  });
});

describe('buildFlowReact', () => {
  const meta = { detected: true, version: '18.3.1', build: 'production' } as const;

  it('carries the meta and the pruned table', () => {
    const table = { cart: resolved('Cart', 'src/Cart.tsx'), gone: resolved('X', 'src/X.tsx') };
    const react = buildFlowReact([step(['cart'])], meta, table);

    expect(react).toEqual({ ...meta, components: { cart: table.cart } });
  });

  it('is absent when the page was not React', () => {
    expect(buildFlowReact([step(['cart'])], null, {})).toBeUndefined();
    expect(buildFlowReact([step(['cart'])], { detected: false }, {})).toBeUndefined();
  });

  it('is absent rather than empty when nothing survived pruning', () => {
    expect(buildFlowReact([step(null)], meta, { cart: resolved('Cart', 'src/Cart.tsx') })).toBeUndefined();
  });
});

describe('stepOwner', () => {
  it('picks the innermost component the user owns', () => {
    const table = {
      app: resolved('App', 'src/App.tsx'),
      cart: resolved('Cart', 'src/Cart.tsx'),
      base: { ...resolved('ButtonBase', 'node_modules/@mui/Button.js'), dependency: true },
    };

    expect(stepOwner(step(['app', 'cart', 'base']), table)?.component.name).toBe('Cart');
  });

  it('is null for a step with no chain, and for a chain nothing in the table names', () => {
    expect(stepOwner(step(null), {})).toBeNull();
    expect(stepOwner(step(['missing']), {})).toBeNull();
  });
});

describe('formatSource', () => {
  it('renders a resolved component as file:line', () => {
    expect(formatSource(resolved('Cart', 'src/Cart.tsx'))).toBe('src/Cart.tsx:34');
  });

  it('omits the line when there is none', () => {
    expect(formatSource({ name: 'Cart', status: 'resolved', source: 'src/Cart.tsx' })).toBe(
      'src/Cart.tsx',
    );
  });

  it('falls back to the compiled position, shortened to a path', () => {
    const component: ComponentSource = {
      name: 'PriceTag',
      status: 'compiled-only',
      compiled: { url: 'https://cdn.example.com/assets/index-8f2a.js', line: 1, column: 88_214 },
    };

    expect(formatSource(component)).toBe('/assets/index-8f2a.js:1:88214');
  });

  it('has nothing to say about a component that was never found', () => {
    expect(formatSource({ name: 'LazyModal', status: 'not-found' })).toBeNull();
  });
});

describe('countComponents', () => {
  const table: Record<string, ComponentSource> = {
    a: resolved('A', 'src/A.tsx'),
    b: resolved('B', 'src/B.tsx'),
    c: { name: 'C', status: 'ambiguous', source: 'src/C.tsx', line: 3, matchCount: 2 },
    d: { name: 'D', status: 'not-found' },
    [CAPPED_ID]: { name: 'FlowSnap', status: 'skipped' },
  };

  it('counts by outcome and never counts the cap marker as a component', () => {
    expect(countComponents(table)).toEqual({
      total: 4,
      resolved: 2,
      ambiguous: 1,
      unresolved: 1,
    });
  });

  it('summarises only the parts that are non-zero', () => {
    expect(summarizeComponents(table)).toBe('4 components · 2 resolved · 1 ambiguous');
    expect(summarizeComponents({ d: table.d })).toBe('1 component');
    expect(summarizeComponents({})).toBe('');
  });
});

/**
 * Taking the attribution back off.
 *
 * Three callers need exactly this — the send prune, the JSON export and the
 * purge the worker runs when capture is switched off — and each of them is
 * removing data a user asked not to be kept, which is a promise worth one
 * implementation rather than three.
 */
describe('stripReactRef', () => {
  const attributed = (): Step => ({
    type: 'click',
    url: 'https://shop.example.com/cart',
    timestamp: 1,
    action: 'Clicked "Buy"',
    element: {
      tag: 'button',
      cssSelector: '#buy',
      xpath: '/button',
      boundingBox: null,
      react: { chain: ['cart'], owner: 'cart' },
    },
  });

  it('removes the reference and leaves the rest of the element alone', () => {
    const stripped = stripReactRef(attributed());

    expect(stripped.element?.react).toBeUndefined();
    expect(stripped.element?.cssSelector).toBe('#buy');
    expect(stripped.action).toBe('Clicked "Buy"');
  });

  it('copies rather than mutates, because the step is shared with the recording', () => {
    const original = attributed();
    stripReactRef(original);
    expect(original.element?.react?.chain).toEqual(['cart']);
  });

  it('hands back the very same step when there was nothing to strip', () => {
    const plain = { type: 'navigate', url: 'https://x.test', timestamp: 1, action: 'Went', title: 'x' } as Step;
    expect(stripReactRef(plain)).toBe(plain);
  });
});
