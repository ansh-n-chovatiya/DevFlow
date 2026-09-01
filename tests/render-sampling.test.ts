// @vitest-environment jsdom
/**
 * The page-side render sampler, and the two ways it can lie.
 *
 * The first is the one `injected/state.ts`'s tests are about and this module
 * inherits: whatever DevFlow reads, the page it reads it from has to boot. The
 * reverted attempt at this very feature patched the React DevTools hook to take
 * the commit callback, so the first tests here are about *globals* rather than
 * about renders.
 *
 * The second is specific to this module and is invisible against any fixture
 * that does not alternate. React keeps two fiber objects per component and
 * swaps which is current on every commit, so a tracking map keyed on the fiber
 * object reports either everything or nothing as re-rendered — and both look
 * like a working feature until someone reads a recording. Every comparison test
 * below therefore commits the way React commits: it swaps the halves.
 *
 * There is no React here to produce the fibers, deliberately — the extension
 * has no dependencies — so the fixtures are the internals this module claims to
 * understand, written out by hand. A fixture that stops matching React is
 * exactly the failure the module survives by skipping.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { exportToJSON } from '../src/core/export/json.js';
import { renumber } from '../src/core/flow/index.js';
import { buildPayload, pruneSteps } from '../src/features/mcp/send.js';
import { isSecretStateKey } from '../src/core/redact/index.js';
import type { Step } from '../src/shared/types.js';
import type { SnapshotBudget } from '../src/core/state/snapshot.js';
import {
  compareRenders,
  renderNote,
  sampleRenders,
  type RenderSample,
} from '../src/injected/render.js';
import { blame } from '../src/core/render/index.js';

const BUDGET: SnapshotBudget = {
  maxDepth: 6,
  maxKeys: 40,
  maxEntries: 20,
  stringCap: 200,
  secretKey: isSecretStateKey,
};

const NODE_CAP = 500;
const NOW = 1_700_000_000_000;

/** Component ids, as the recorder would mint them — one per component fn. */
const identify = (_fn: unknown, name: string): string => name;

// ── Fibers, by hand ──────────────────────────────────────────────────────────

interface HookNode {
  memoizedState?: unknown;
  queue?: { dispatch?: unknown } | null;
  next?: HookNode | null;
}

interface Dep {
  context?: { displayName?: string } | null;
  memoizedValue?: unknown;
  next?: Dep | null;
}

interface FakeFiber {
  type?: unknown;
  stateNode?: unknown;
  memoizedProps?: Record<string, unknown> | null;
  memoizedState?: unknown;
  dependencies?: { firstContext?: Dep | null } | null;
  child?: FakeFiber | null;
  sibling?: FakeFiber | null;
  return?: FakeFiber | null;
  alternate?: FakeFiber | null;
}

/** A distinct function per name, so ids and identity do not collide. */
function componentFn(name: string): () => string {
  return Object.defineProperty(() => name, 'name', { value: name });
}

interface ComponentOptions {
  props: Record<string, unknown>;
  hooks?: HookNode | null;
  contexts?: Dep | null;
  child?: FakeFiber | null;
}

/** One half of a component's fiber pair. */
function componentFiber(type: unknown, options: ComponentOptions): FakeFiber {
  return {
    type,
    memoizedProps: options.props,
    memoizedState: options.hooks ?? null,
    dependencies: options.contexts ? { firstContext: options.contexts } : null,
    child: options.child ?? null,
  };
}

/**
 * A component as React actually keeps one: two fibers that are each other's
 * alternate, of which exactly one is in the current tree at a time.
 *
 * `current` is what the tree points at now; `commit` is what it points at after
 * a render of this component. Nothing else in these fixtures may create a
 * second fiber for one component, because doing so is the bug under test.
 */
function pairOf(
  name: string,
  before: ComponentOptions,
  after: ComponentOptions,
): { current: FakeFiber; next: FakeFiber } {
  const type = componentFn(name);
  const current = componentFiber(type, before);
  const next = componentFiber(type, after);
  current.alternate = next;
  next.alternate = current;
  return { current, next };
}

/** A host `<div>` fiber — visited, counted against the cap, never tracked. */
function host(child?: FakeFiber | null, sibling?: FakeFiber | null): FakeFiber {
  return { type: 'div', memoizedProps: {}, child: child ?? null, sibling: sibling ?? null };
}

/**
 * Mount a tree under a container the sampler will find.
 *
 * The container key holds the host root fiber, which is what React writes there
 * and what `state.ts` reads. Committing is modelled by moving the host root's
 * `child` pointer to the other half of the pair below it, which is what a
 * commit does to the tree the walk can see.
 */
function mount(child: FakeFiber): FakeFiber {
  const el = document.createElement('div');
  el.id = 'root';
  document.body.append(el);

  const fiberRoot = { current: null as unknown as FakeFiber };
  const hostRoot: FakeFiber = { type: null, child, stateNode: fiberRoot };
  fiberRoot.current = hostRoot;
  link(hostRoot);

  (el as unknown as Record<string, unknown>)['__reactContainer$abc'] = hostRoot;
  return hostRoot;
}

function link(fiber: FakeFiber): void {
  for (let node = fiber.child; node; node = node.sibling ?? null) {
    node.return = fiber;
    link(node);
  }
}

function sample(): RenderSample {
  return sampleRenders(NODE_CAP);
}

function observe(before: RenderSample, after: RenderSample) {
  return compareRenders(before, after, BUDGET, identify);
}

beforeEach(() => {
  document.body.innerHTML = '';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__;
});

// ── The promise ──────────────────────────────────────────────────────────────

describe('sampling renders does not become part of the app', () => {
  it('reads the React devtools hook and leaves it exactly as it found it', () => {
    const renderers = new Map<number, unknown>([[1, {}]]);
    const roots = new Set([{ current: mount(host()) }]);
    const hook = {
      renderers,
      getFiberRoots: () => roots,
      onCommitFiberRoot: undefined,
      inject: () => 1,
    };
    (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook;
    const keys = Object.keys(hook).sort();
    const inject = hook.inject;

    sample();

    // Nothing installed, nothing replaced. Taking `onCommitFiberRoot` is what
    // the reverted attempt did, and it is the field this asserts stays unset.
    expect((window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__).toBe(hook);
    expect(Object.keys(hook).sort()).toEqual(keys);
    expect(hook.onCommitFiberRoot).toBeUndefined();
    expect(hook.inject).toBe(inject);
    expect(renderers.size).toBe(1);
  });

  it('defines nothing on the page at all, whatever it read', () => {
    const before = new Set(Object.getOwnPropertyNames(window));

    const { current, next } = pairOf('Card', { props: { a: 1 } }, { props: { a: 2 } });
    const root = mount(current);
    const first = sample();
    root.child = next;
    observe(first, sample());

    const added = Object.getOwnPropertyNames(window).filter((key) => !before.has(key));
    expect(added).toEqual([]);
  });

  it('subscribes to nothing and never calls the components it reads', () => {
    const type = vi.fn(() => 'Card');
    const fiber: FakeFiber = {
      type,
      memoizedProps: { a: 1 },
      memoizedState: { memoizedState: 1, queue: { dispatch: () => undefined }, next: null },
      dependencies: { firstContext: { context: { displayName: 'Theme' }, memoizedValue: 1 } },
    };
    mount(fiber);

    const addWindow = vi.spyOn(window, 'addEventListener');
    const addDocument = vi.spyOn(document, 'addEventListener');

    observe(sample(), sample());

    // The whole difference between sampling and intercepting: no listener, no
    // commit hook, and the app's own render function never invoked.
    expect(addWindow).not.toHaveBeenCalled();
    expect(addDocument).not.toHaveBeenCalled();
    expect(type).not.toHaveBeenCalled();
  });
});

// ── The double buffer ────────────────────────────────────────────────────────

describe('React swapping which half of a fiber pair is current', () => {
  it('does not report a component whose props object survived the commit', () => {
    // One props object, shared by both halves: React reuses the props of a
    // component it bailed out of, and that is exactly "did not re-render".
    const props = { label: 'Save' };
    const { current, next } = pairOf('Button', { props }, { props });
    const root = mount(current);

    const before = sample();
    // The commit: the tree now points at the other half of the pair.
    root.child = next;
    const { observed } = observe(before, sample());

    expect(observed).toEqual([]);
  });

  it('reports the component whose props object the commit replaced', () => {
    const { current, next } = pairOf('Button', { props: { count: 1 } }, { props: { count: 2 } });
    const root = mount(current);

    const before = sample();
    root.child = next;
    const { observed } = observe(before, sample());

    expect(observed).toHaveLength(1);
    expect(observed[0]?.component).toBe('Button');
    expect(observed[0]?.props).toEqual([{ key: 'count', before: 1, after: 2 }]);
  });

  it('matches the pair in either direction, so a second commit is not a new component', () => {
    const props = { label: 'Save' };
    const { current, next } = pairOf('Button', { props }, { props });
    const root = mount(current);

    // Start the recording on the *second* half, as any interaction after the
    // first commit does, and swap back. Registering only the fiber the walk saw
    // would make this an unmatched component and report nothing at all.
    root.child = next;
    const before = sample();
    root.child = current;
    const { observed } = observe(before, sample());

    expect(observed).toEqual([]);
  });

  it('matches a component that had no second half until the step created one', () => {
    // The first render of a component makes one fiber; React builds its
    // alternate when it next renders. So at the gesture there is nothing to
    // register the pair under, and the only thing that can join the two
    // readings is the `alternate` pointer the *settled* fiber carries back.
    const type = componentFn('Fresh');
    const first = componentFiber(type, { props: { n: 1 } });
    const root = mount(first);

    const before = sample();
    const second = componentFiber(type, { props: { n: 2 } });
    second.alternate = first;
    first.alternate = second;
    root.child = second;
    const { observed } = observe(before, sample());

    expect(observed).toHaveLength(1);
    expect(observed[0]?.props).toEqual([{ key: 'n', before: 1, after: 2 }]);
  });

  it('matches a settled fiber whose own alternate pointer has been dropped', () => {
    // React detaches an alternate on some teardown paths, and a fiber that
    // cannot point back at the half the gesture saw would look like a component
    // that mounted mid-step. Registering both halves at the first reading is
    // what answers it, and it is the reason both directions exist.
    const props = { label: 'Save' };
    const { current, next } = pairOf('Button', { props }, { props: { ...props } });
    const root = mount(current);

    const before = sample();
    next.alternate = null;
    root.child = next;
    const { observed } = observe(before, sample());

    expect(observed.map((entry) => entry.component)).toEqual(['Button']);
  });

  it('tells two instances of one component apart when only one re-rendered', () => {
    const shared = { row: 'a' };
    const still = pairOf('Row', { props: shared }, { props: shared });
    const moved = pairOf('Row', { props: { row: 'b' } }, { props: { row: 'c' } });
    still.current.sibling = moved.current;
    still.next.sibling = moved.next;
    const root = mount(host(still.current));

    const before = sample();
    root.child = host(still.next);
    link(root);
    const { observed } = observe(before, sample());

    // Both mint the id `Row`; they are two things on screen and one of them
    // rendered. An identity keyed on the component id would report both.
    expect(observed).toHaveLength(1);
    expect(observed[0]?.props).toEqual([{ key: 'row', before: 'b', after: 'c' }]);
  });

  it('says nothing about a component that mounted during the step', () => {
    const props = { a: 1 };
    const { current, next } = pairOf('Panel', { props }, { props });
    const root = mount(current);

    const before = sample();
    const arrived = componentFiber(componentFn('Modal'), { props: { open: true } });
    next.child = arrived;
    root.child = next;
    link(root);
    const { observed } = observe(before, sample());

    // It rendered once, for the first time. That is a mount, the step is what
    // caused it, and calling it a re-render would put it in the list every time
    // a route changed.
    expect(observed.map((entry) => entry.component)).toEqual([]);
  });
});

// ── What changed ─────────────────────────────────────────────────────────────

describe('what it says changed', () => {
  it('names only the props whose value stopped being the same reference', () => {
    const same = { deep: true };
    const { current, next } = pairOf(
      'Card',
      { props: { onClick: 'a', config: same, title: 'One' } },
      { props: { onClick: 'a', config: same, title: 'Two' } },
    );
    const root = mount(current);

    const before = sample();
    root.child = next;
    const { observed } = observe(before, sample());

    expect(observed[0]?.props).toEqual([{ key: 'title', before: 'One', after: 'Two' }]);
  });

  it('counts hooks from one, and only the ones that hold state', () => {
    const hooks = (value: unknown): HookNode => ({
      // An effect, which holds no state and still takes hook slot one.
      memoizedState: { tag: 1, create: () => undefined },
      queue: null,
      next: {
        memoizedState: value,
        queue: { dispatch: () => undefined },
        next: { memoizedState: { current: null }, queue: null, next: null },
      },
    });
    const { current, next } = pairOf(
      'Counter',
      { props: { a: 1 }, hooks: hooks(1) },
      { props: { a: 1 }, hooks: hooks(2) },
    );
    const root = mount(current);

    const before = sample();
    root.child = next;
    const { observed } = observe(before, sample());

    // `hook 2`, because the `useEffect` above it is the component's first hook
    // and a person reading the source counts it.
    expect(observed[0]?.hooks).toEqual([{ key: 'hook 2', before: 1, after: 2 }]);
    expect(observed[0]?.props).toEqual([]);
  });

  it('names the contexts the fiber depended on, by the name the context declares', () => {
    const theme = { displayName: 'Theme' };
    const locale = { displayName: 'Locale' };
    const deps = (mode: string): Dep => ({
      context: theme,
      memoizedValue: { mode },
      next: { context: locale, memoizedValue: 'en' },
    });
    const { current, next } = pairOf(
      'Header',
      { props: { a: 1 }, contexts: deps('light') },
      { props: { a: 1 }, contexts: deps('light') },
    );
    // Both halves read a *different* object with the same shape, which is what
    // a provider re-rendering with a fresh object does — and the finding.
    const root = mount(current);

    const before = sample();
    root.child = next;
    const { observed } = observe(before, sample());

    expect(observed[0]?.contexts).toEqual([
      { key: 'Theme', before: { mode: 'light' }, after: { mode: 'light' } },
    ]);
  });

  it('records that a secret prop changed and never what it changed to', () => {
    const { current, next } = pairOf(
      'Session',
      { props: { accessToken: 'old-value', page: 1 } },
      { props: { accessToken: 'new-value', page: 1 } },
    );
    const root = mount(current);

    const before = sample();
    root.child = next;
    const { observed } = observe(before, sample());

    expect(observed[0]?.props).toEqual([
      { key: 'accessToken', before: '[redacted]', after: '[redacted]' },
    ]);
  });

  it('reports changed children without printing the element tree, and refuses wasted', () => {
    // A React element is a graph with `_owner` pointing back into the fiber
    // tree; snapshotting one costs the whole page and answers nothing. The
    // change is still recorded, because a component whose children changed is
    // not a component where nothing changed.
    const element = (id: number): Record<string, unknown> => ({ type: 'div', key: null, id });
    const { current, next } = pairOf(
      'Layout',
      { props: { children: element(1), pad: 4 } },
      { props: { children: element(2), pad: 4 } },
    );
    const root = mount(current);

    const before = sample();
    root.child = next;
    const { observed } = observe(before, sample());

    expect(observed[0]?.props).toEqual([{ key: 'children' }]);
    expect(observed[0]?.bounded).toBe(true);
    // The claim this feature must never make falsely.
    expect(blame(observed, { maxComponents: 10, maxChanges: 8 }).renders[0]?.wasted).toBeUndefined();
  });

  it('calls a re-render with no observable change exactly that', () => {
    const identical = { label: 'Save', onClick: () => undefined };
    const { current, next } = pairOf(
      'Button',
      { props: { ...identical } },
      { props: { ...identical } },
    );
    const root = mount(current);

    const before = sample();
    root.child = next;
    const { observed } = observe(before, sample());

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ props: [], hooks: [], contexts: [], bounded: false });
    expect(blame(observed, { maxComponents: 10, maxChanges: 8 }).renders[0]?.wasted).toBe(true);
  });
});

// ── The bounds ───────────────────────────────────────────────────────────────

describe('what it costs and what it admits', () => {
  it('stops at the node cap and says the walk was cut', () => {
    // A wide tree: the cap bites on the siblings, not on the depth.
    let child: FakeFiber | null = null;
    for (let i = 0; i < 40; i++) {
      const fiber = componentFiber(componentFn(`Row${i}`), { props: { i } });
      fiber.sibling = child;
      child = fiber;
    }
    mount(host(child));

    const cut = sampleRenders(5);
    expect(cut.capped).toBe(true);
    expect(cut.entries.length).toBeLessThan(40);

    const whole = sampleRenders(NODE_CAP);
    expect(whole.capped).toBe(false);
    expect(whole.entries).toHaveLength(40);
  });

  it('carries the cap through the comparison, so an empty answer is never silent', () => {
    const props = { a: 1 };
    const { current, next } = pairOf('Card', { props }, { props });
    const root = mount(current);

    const before = sampleRenders(1);
    root.child = next;
    const { observed, capped } = compareRenders(before, sampleRenders(1), BUDGET, identify);

    // Nothing re-rendered *that was looked at*. The two are not the same claim
    // and `FlowRenders.capped` is what keeps them apart.
    expect(observed).toEqual([]);
    expect(capped).toBe(true);
  });

  it('walks breadth-first, so a cut keeps the top of the tree', () => {
    const deep = componentFiber(componentFn('Deep'), { props: { d: 1 } });
    const top = componentFiber(componentFn('Top'), { props: { t: 1 }, child: host(deep) });
    const beside = componentFiber(componentFn('Beside'), { props: { b: 1 } });
    top.sibling = beside;
    mount(host(top));

    // Four fibers in: the host, `Top`, `Beside`, then the host below `Top`.
    const cut = sampleRenders(4);
    const names = cut.entries.map((entry) => (entry.fiber.type as { name: string }).name);
    expect(names).toEqual(['Top', 'Beside']);
    expect(cut.capped).toBe(true);
  });

  it('tells a page with no React from a page where nothing re-rendered', () => {
    const empty = sample();
    expect(empty.roots).toBe(0);
    expect(renderNote(empty)).toMatch(/No React root/);

    mount(componentFiber(componentFn('Card'), { props: { a: 1 } }));
    expect(renderNote(sample())).toBeUndefined();
  });

});

// ── The pipeline ─────────────────────────────────────────────────────────────

/**
 * Every hop between the page and the saved flow, because the last feature lost
 * itself on one of them.
 *
 * `state` was captured correctly, and a named-field copy in the save path did
 * not list it, so every real recording arrived with its stores and had them
 * dropped on the way to disk while every fixture kept them. Three layers of
 * tests were green. What follows walks the field rather than the layer: the two
 * modules that cannot be imported — a content script and a service worker both
 * register listeners at import — are read as source, exactly as
 * `tests/background-toolbar.test.ts` reads them, and the pure ones are called.
 */
describe('the renders field, hop by hop', () => {
  /*
   * From the project root rather than from `import.meta.url`: this file runs
   * under jsdom, where the module URL is not a `file:` one and `readFileSync`
   * refuses it. Vitest's root is the package root.
   */
  const read = (relative: string): string =>
    readFileSync(path.join(process.cwd(), relative), 'utf8');
  const contentSource = read('src/content/index.ts');
  const workerSource = read('src/background/index.ts');

  /** One top-level function, ending at the first closing brace in column one. */
  function body(source: string, signature: string): string {
    const start = source.indexOf(signature);
    expect(start, `${signature} is gone`).toBeGreaterThan(-1);
    const rest = source.slice(start);
    const end = rest.search(/\n\}\)?;?\n/);
    return rest.slice(0, end === -1 ? undefined : end);
  }

  it('leaves the interaction key for the second sample that needs it', () => {
    /*
     * One interaction now produces two settled messages off one pair of
     * samples. `onStateSample` used to consume the key the step was saved
     * under, so whichever message arrived second found nothing to attach to and
     * was dropped — silently, on every step, and only for the feature that lost
     * the race.
     */
    expect(body(contentSource, 'function onStateSample(')).not.toContain(
      'stepByEventTime.delete',
    );
    expect(body(contentSource, 'function onRenderSample(')).not.toContain(
      'stepByEventTime.delete',
    );
  });

  it('carries the page agent’s observations to the worker under the step’s key', () => {
    const handler = body(contentSource, 'function onRenderSample(');
    expect(handler).toContain('stepByEventTime.get(data.eventTime)');
    expect(handler).toContain('blame(data.observed');
    expect(handler).toContain("type: 'STEP_RENDERS'");
    // The cap is news even when nothing else is: a recording that reports no
    // re-renders while its walk was cut is reporting on the cut.
    expect(handler).toContain('data.capped');
  });

  it('merges the list onto the step and the cap onto the recording', () => {
    const attach = body(workerSource, 'async function attachRenders(');
    expect(attach).toMatch(/\.\.\.recordedSteps\[index\], renders/);
    expect(attach).toContain('flowRenders');
    // Sticky, and written whether or not the step survived — the same rule the
    // stores follow, for the same reason.
    expect(attach).toContain("known?.capped ? { capped: true }");
    expect(workerSource).toContain("case 'STEP_RENDERS':");
  });

  /**
   * The list travels with the component table, and is dropped with it.
   *
   * Every entry is keyed by a component id, and with React switched off
   * `buildPayload` prunes the table to the ids the steps still reference —
   * none. A surviving list would name components the payload cannot resolve:
   * not a smaller answer but an unreadable claim that those components
   * re-rendered. The same rule `stripReactRef` follows, one field over.
   */
  it('survives the send path with React on, and goes with the table when it is off', () => {
    const step: Step = {
      type: 'click',
      url: 'https://app.example.com',
      timestamp: NOW,
      action: 'Clicked "Save"',
      stepNumber: 1,
      element: { tag: 'button', cssSelector: 'button.save', xpath: '//button', boundingBox: null },
      consoleLogs: [],
      networkCalls: [],
      renders: [{ component: 'Button', props: [{ key: 'label', before: 'a', after: 'b' }] }],
    };

    // React on: the list is carried through untouched, including when every
    // other switch is off — it is not images, network or logs.
    for (const include of [
      { images: true, network: true, logs: true, react: true },
      { images: false, network: false, logs: false, react: true },
    ]) {
      const sending = pruneSteps(renumber([step]), include);
      expect(sending[0]?.renders, JSON.stringify(include)).toEqual(step.renders);

      const payload = buildPayload('flow-1', 'Flow', sending, NOW, null, include);
      expect(payload.steps[0]?.renders, JSON.stringify(include)).toEqual(step.renders);
    }

    // React off: gone, along with the ref that would have named the same table.
    const stripped = pruneSteps(renumber([step]), {
      images: true,
      network: true,
      logs: true,
      react: false,
    });
    expect(stripped[0]?.renders).toBeUndefined();
    expect(stripped[0]?.element?.react).toBeUndefined();
  });

  /**
   * The download path, which builds its step out of a spread and then deletes
   * by name — the shape of the copy that lost `state` last time.
   */
  it('survives the download path, and is dropped there too when no table ships', () => {
    const step: Step = {
      type: 'click',
      url: 'https://app.example.com',
      timestamp: NOW,
      action: 'Clicked "Save"',
      stepNumber: 1,
      element: {
        tag: 'button',
        cssSelector: 'button.save',
        xpath: '//button',
        boundingBox: null,
        react: { chain: ['btn-1'], owner: 'btn-1' },
      },
      consoleLogs: [],
      networkCalls: [],
      renders: [{ component: 'btn-1', props: [{ key: 'label', before: 'a', after: 'b' }] }],
    };

    const withTable = JSON.parse(
      exportToJSON([step], {
        react: {
          detected: true,
          components: { 'btn-1': { name: 'Button', status: 'resolved' } },
        },
      }),
    ) as { steps: Step[] };
    expect(withTable.steps[0]?.renders).toEqual(step.renders);

    // No table exported, so nothing can name `btn-1`.
    const noTable = JSON.parse(exportToJSON([step])) as { steps: Step[] };
    expect(noTable.steps[0]?.renders).toBeUndefined();
  });
});

describe('finding the roots', () => {
  it('reads a page whose roots only the devtools hook knows about', () => {
    // A root rendered into a detached container, which the container scan
    // cannot reach and React itself will name.
    const { current, next } = pairOf('Portal', { props: { a: 1 } }, { props: { a: 2 } });
    const fiberRoot = { current: { type: null, child: current } as FakeFiber };
    (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map([[1, {}]]),
      getFiberRoots: () => new Set([fiberRoot]),
    };

    const before = sample();
    fiberRoot.current.child = next;
    const { observed } = observe(before, sample());

    expect(observed.map((entry) => entry.component)).toEqual(['Portal']);
  });
});
