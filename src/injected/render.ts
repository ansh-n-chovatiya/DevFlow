/**
 * Seeing which components re-rendered, without taking part in the render.
 *
 * ## Two readings, not a commit hook
 *
 * The reverted v3.2.0 attempt answered "why did this render?" the way React
 * DevTools does: it patched `__REACT_DEVTOOLS_GLOBAL_HOOK__`, took the commit
 * callback, and walked the whole fiber tree on every commit on every page the
 * extension was loaded into — gated on nothing, against a <2% CPU budget it
 * could not keep. A page that renders on every mousemove paid for a recording
 * nobody had started.
 *
 * Nothing here installs anything. This module **reads** the same two moments
 * `injected/state.ts` reads — one sample in the capture phase of the
 * interaction, before React's own listener runs, and one once the app has
 * settled — and infers a re-render from the evidence React already leaves: a
 * component's `memoizedProps` is a *new object* on every render, so a props
 * reference that differs between the two readings is a component that rendered
 * in between. It defines no global, patches no method, subscribes to nothing
 * and holds no module-level state at all, so "inert when not recording" is not
 * a property this file maintains — there is nothing here to be running.
 *
 * The honest cost is the one `state.ts` states: this is sampled, not counted. A
 * component that rendered forty times and one that rendered once are the same
 * evidence, a value that changed and changed back is no change, and a props
 * object the app mutates in place rather than replacing is invisible.
 * `StepRender` in `shared/types.ts` says all three to the reader.
 *
 * ## The double buffer is the trap
 *
 * React keeps **two** fiber objects per component and swaps which one is
 * `current` on every commit of that subtree. So the tree walked at the settled
 * sample is, for everything that re-rendered, a *different set of objects* from
 * the tree walked during the gesture — and a tracking map keyed on the fiber
 * object fails silently in whichever direction the alternation went: every
 * component looks new (so everything reports as re-rendered) or nothing matches
 * (so nothing ever does). Both read as a working feature.
 *
 * The pair is what is stable: `fiber` and `fiber.alternate` are the same two
 * objects for the life of that component instance. Every tracked component is
 * therefore registered under **both halves**, and looked up by both — which is
 * also why the identity is per *instance* rather than per component id: twenty
 * rows of one `<Row>` mint one id and are twenty things that re-render
 * independently. `state.ts` solves the same problem from the other end, in
 * `currentOf`, by climbing to the host root; here there is no need to decide
 * which half is live, because either half answers to the same entry.
 *
 * ## What the gesture pays
 *
 * The before-sample runs inside the user's click, so it is a bounded
 * breadth-first walk plus *shallow reads*: the props object reference, one
 * reference per prop, one per state hook, one per context dependency. No
 * snapshot is taken and nothing is copied. Only at the settled sample — off the
 * gesture — is a value that actually differs handed to `snapshot()`, so the
 * deep work is proportional to what changed rather than to the size of the
 * tree.
 *
 * Breadth-first rather than `state.ts`'s depth-first stack, because the cap is
 * what decides what is lost: cut at `renderNodeCap` in breadth order, what
 * survives is the top of the tree — the layout, the providers, the route — and
 * not one arbitrary deep branch of a list.
 */

import type { ComponentFn, Fiber } from '../core/react/fiber.js';
import { getDisplayName } from '../core/react/fiber.js';
import { isSecretStateKey } from '../core/redact/index.js';
import { snapshot, type SnapshotBudget } from '../core/state/snapshot.js';
import type { AgentRenderObservation } from '../shared/messages.js';
import type { RenderChange } from '../shared/types.js';
/**
 * The id function, imported as a type so nothing of `state.ts` is pulled in at
 * runtime. Both modules mint component ids through the recorder's own function
 * for the same reason: an id minted twice is an id that joins to nothing.
 */
import { reactRoots } from './roots.js';
import type { Identify } from './state.js';

/**
 * The fields of a fiber this module reads and `core/react/fiber.ts` does not.
 *
 * Declared here rather than widened onto the shared `Fiber`, for the reason
 * `state.ts` gives over its own copy: these are the internals React reserves
 * the right to move — the hook list, the context dependency list, the alternate
 * pointer — and everything that reads them is in this file.
 */
interface RenderFiber extends Fiber {
  memoizedProps?: Record<string, unknown> | null;
  /** A hook list on a function component; the state object on a class. */
  memoizedState?: unknown;
  dependencies?: { firstContext?: ContextDependency | null } | null;
  /** The other half of React's double buffer — see the header. */
  alternate?: RenderFiber | null;
  child: RenderFiber | null;
  sibling: RenderFiber | null;
  return: RenderFiber | null;
}

/** One node of a function component's hook list. */
interface HookNode {
  memoizedState?: unknown;
  /** Present with a `dispatch` on `useState`/`useReducer`, and on nothing else. */
  queue?: { dispatch?: unknown } | null;
  next?: HookNode | null;
}

/** One entry of a fiber's context dependency list — a context it actually read. */
interface ContextDependency {
  context?: { displayName?: string } | null;
  /** The value this component read on its last render. */
  memoizedValue?: unknown;
  next?: ContextDependency | null;
}

/**
 * Hooks walked on one component, contexts walked on one component, and props
 * read from one component.
 *
 * Guards against a torn-down tree with a cyclic list rather than real limits: a
 * component with more than sixty-four hooks or thirty-two context dependencies
 * is not a component anyone is debugging with this.
 */
const HOOK_WALK_CAP = 64;
const CONTEXT_WALK_CAP = 32;
const PROP_KEY_CAP = 64;

/**
 * Changes recorded for one component before the walk stops looking.
 *
 * The real budget is `recording.renderMaxChanges`, spent by `core/render` on
 * the isolated side where it can be tested. This is only the ceiling on the
 * *work* — a component handed two hundred changed props should not cost two
 * hundred snapshots to report the eight the reader will see.
 */
const OBSERVED_CHANGE_CAP = 64;

/**
 * The same mask `core/redact/index.ts` and `core/state/snapshot.ts` write, so
 * one string means one thing wherever a value was withheld.
 */
const MASK = '[redacted]';

/** A key and the reference its value had at one sample. Never a copy. */
type Reading = [key: string, value: unknown];

/** One component instance, as one sample saw it. */
interface Tracked {
  /** The fiber this reading came from, and its other half. Identity, not data. */
  fiber: RenderFiber;
  alternate: RenderFiber | null;
  /** The props *object*. A new one per render, which is the whole mechanism. */
  props: unknown;
  propValues: Reading[];
  hooks: Reading[];
  contexts: Reading[];
}

/** One reading of the page's component tree. */
export interface RenderSample {
  /** Every tracked component, once each. */
  entries: Tracked[];
  /** The same entries, under both halves of each fiber pair — see the header. */
  byFiber: Map<object, Tracked>;
  /** The walk stopped at `nodeCap`, so what is missing was never compared. */
  capped: boolean;
  /** React roots found. Zero is a page with no React, which is not a failure. */
  roots: number;
}

// ── Finding the roots ────────────────────────────────────────────────────────

/*
 * The root finder used to be copied here, with a comment saying it would become
 * a module on the day a third caller wanted it. `architecture.ts` is that
 * caller, so it did — `roots.ts`, generic over the fiber type so this file keeps
 * its own `RenderFiber` view rather than widening to one no caller wanted.
 */

// ── Reading one component ────────────────────────────────────────────────────

/**
 * The function a fiber renders, or null when it is not a component.
 *
 * The same three shapes `state.ts` accepts — a plain function, `forwardRef`'s
 * `render`, `memo`'s `type` — and nothing else: a host `<div>` has no id worth
 * minting and no props worth reporting, and the walk still counts it against
 * the cap because visiting it is what the cap is measuring.
 */
function componentFn(fiber: RenderFiber): ComponentFn | null {
  const type = fiber.type;
  if (typeof type === 'function') return type as ComponentFn;
  if (!type || typeof type !== 'object') return null;
  const wrapper = type as { render?: unknown; type?: unknown };
  if (typeof wrapper.render === 'function') return wrapper.render as ComponentFn;
  if (typeof wrapper.type === 'function') return wrapper.type as ComponentFn;
  return null;
}

/**
 * Every prop, by reference.
 *
 * `children` is skipped, and it is the one exclusion worth explaining: it is a
 * freshly built element tree on every render of the *parent*, so it is never
 * `Object.is`-equal and would mark a changed prop on every component that takes
 * children, on every step. It is not dropped silently — `compareRenders`
 * records it as a change with no value attached, because the honest answer is
 * "the children changed and they are an element tree, not a value". A component
 * whose only change was hidden here would otherwise be reported `wasted`, which
 * is the one claim in this feature that must never be made falsely.
 */
function readProps(props: Record<string, unknown>): Reading[] {
  const out: Reading[] = [];
  let keys: string[];
  try {
    keys = Object.keys(props);
  } catch {
    // An exotic proxy. Nothing readable is not the same as nothing changed, and
    // the props *reference* still says whether it rendered.
    return out;
  }
  for (let i = 0; i < keys.length && out.length < PROP_KEY_CAP; i++) {
    const key = keys[i];
    if (key === 'children') continue;
    try {
      out.push([key, props[key]]);
    } catch {
      // A getter that threw. Skipped rather than recorded as undefined, which
      // would read as a prop that changed to nothing on the next sample.
    }
  }
  return out;
}

/**
 * The component's own state, by reference, numbered from one.
 *
 * `useState` and `useReducer` are the hooks whose node carries a `queue` with a
 * `dispatch`; `useEffect`, `useMemo` and `useRef` carry no dispatch, and
 * `useSyncExternalStore`'s queue carries a snapshot getter rather than one — so
 * this is the app's own state and not every intermediate the component
 * computed. Non-state hooks still take their slot in the numbering, because the
 * number a reader counts to in the source counts every hook.
 *
 * A class component's `memoizedState` is its state object, has no `queue` and
 * no `next`, and falls out of this loop having reported nothing. That is the
 * intended answer until there is a contract that says what a class's state is
 * keyed by.
 */
function readHooks(fiber: RenderFiber): Reading[] {
  const out: Reading[] = [];
  const first = fiber.memoizedState;
  if (!first || typeof first !== 'object') return out;

  let node: HookNode | null | undefined = first;
  for (let i = 0; node && i < HOOK_WALK_CAP; i++, node = node.next) {
    if (typeof node !== 'object') break;
    const queue = node.queue;
    if (!queue || typeof queue !== 'object' || typeof queue.dispatch !== 'function') continue;
    out.push([`hook ${i + 1}`, node.memoizedState]);
  }
  return out;
}

/**
 * The contexts this fiber actually read, by reference.
 *
 * `dependencies.firstContext` is React's own record of what the component
 * consumed on its last render, exactly as `state.ts` reads it for the
 * subscriber list: being rendered *underneath* a provider is not reading it.
 * The key is the context's `displayName` when it has one and its position when
 * it does not — the list's order is the order the component's `useContext`
 * calls run in, which the rules of hooks make stable across renders.
 *
 * ## A `displayName` is not an identity
 *
 * React neither guarantees one is unique nor requires one to be set, and two
 * contexts sharing a name is ordinary — a library's and an app's both called
 * `Theme`, or two of the same library's. `changesBetween` resolves a key by the
 * *first* match in the other reading, so under one name the second context was
 * compared against the first's value: the one that changed and the one that did
 * not were both reported as changed, and the unchanged one carried the other's
 * before and after. Wrong data with a plausible label on it, which is the shape
 * of defect this whole feature is least able to afford.
 *
 * So a name that repeats within one component's dependency list is qualified by
 * its position, on the same stable order that already backs the unnamed
 * fallback. A name that does not repeat is left exactly as it was, because the
 * key is what the reader sees and the common case should not pay for the rare
 * one.
 *
 * The identity that would settle it outright is the context object itself, and
 * it is deliberately not used: matching on it across the two samples needs a map
 * that outlives them both, and this file holds no module-level state — see the
 * header.
 */
function readContexts(fiber: RenderFiber): Reading[] {
  const read: { key: string; value: unknown; position: number }[] = [];
  let dep: ContextDependency | null | undefined = fiber.dependencies?.firstContext;
  for (let i = 0; dep && i < CONTEXT_WALK_CAP; i++, dep = dep.next) {
    if (typeof dep !== 'object') break;
    const context = dep.context;
    if (!context) continue;
    const declared = typeof context.displayName === 'string' ? context.displayName.trim() : '';
    read.push({
      key: declared ? declared.slice(0, 60) : `context ${i + 1}`,
      value: dep.memoizedValue,
      position: i + 1,
    });
  }

  const once = new Set<string>();
  const repeated = new Set<string>();
  for (const entry of read) {
    if (once.has(entry.key)) repeated.add(entry.key);
    once.add(entry.key);
  }

  return read.map((entry): Reading => [
    repeated.has(entry.key) ? `${entry.key} (context ${entry.position})` : entry.key,
    entry.value,
  ]);
}

// ── The walk ─────────────────────────────────────────────────────────────────

/**
 * One reading of the tree, bounded to `nodeCap` fibers.
 *
 * Breadth-first, and the queue holds the whole of each sibling chain: see the
 * header for why what survives the cap has to be the top of the tree. Shallow
 * throughout — nothing here copies a value, and the only work per component is
 * a handful of property reads.
 */
export function sampleRenders(nodeCap: number): RenderSample {
  const roots = reactRoots<RenderFiber>();
  const sample: RenderSample = {
    entries: [],
    byFiber: new Map(),
    capped: false,
    roots: roots.length,
  };

  const cap = Math.max(1, nodeCap);
  const queue: RenderFiber[] = [...roots];
  let head = 0;
  let visited = 0;

  while (head < queue.length) {
    const fiber = queue[head++];
    if (++visited > cap) {
      sample.capped = true;
      break;
    }

    track(fiber, sample);

    // The child's whole sibling chain, so one level is enqueued at a time.
    // Bounded by the cap as well as by the chain: a virtualised list can have
    // fifty thousand siblings, and a queue built from all of them costs more
    // than the walk that will never reach them.
    let enqueued = 0;
    for (let child = fiber.child; child && enqueued < cap; child = child.sibling) {
      queue.push(child);
      enqueued++;
    }
  }

  return sample;
}

/** Record one component, under both halves of its fiber pair. */
function track(fiber: RenderFiber, sample: RenderSample): void {
  if (!componentFn(fiber)) return;

  const props = fiber.memoizedProps;
  if (!props || typeof props !== 'object') return;

  const entry: Tracked = {
    fiber,
    alternate: fiber.alternate ?? null,
    props,
    propValues: readProps(props),
    hooks: readHooks(fiber),
    contexts: readContexts(fiber),
  };

  sample.entries.push(entry);
  sample.byFiber.set(fiber, entry);
  // The half React will swap to. Registering it now is what makes the lookup at
  // the settled sample find this entry whichever way the commit went.
  if (entry.alternate) sample.byFiber.set(entry.alternate, entry);
}

// ── The comparison ───────────────────────────────────────────────────────────

/** What one changed value costs, and what it is allowed to hide. */
function take(value: unknown, budget: SnapshotBudget): { value: unknown; bounded: boolean } {
  const taken = snapshot(value, budget);
  return { value: taken.value, bounded: taken.bounded };
}

/**
 * The keys of one kind whose value stopped being the same reference.
 *
 * `Object.is`, not equality: the evidence is references, and two structurally
 * identical objects are a genuine change to what the component was handed —
 * which is very often the bug being looked for.
 */
function changesBetween(
  before: Reading[],
  after: Reading[],
  budget: SnapshotBudget,
  changes: RenderChange[],
): boolean {
  let bounded = false;

  const seen = new Set<string>();
  for (const [key, next] of after) {
    seen.add(key);
    const prior = before.find((entry) => entry[0] === key);
    if (prior && Object.is(prior[1], next)) continue;
    if (changes.length >= OBSERVED_CHANGE_CAP) {
      // Out of room to describe them, which is itself a cut value.
      bounded = true;
      break;
    }
    if (isSecretStateKey(key)) {
      // The key is the finding — that this changed — and the value is a
      // credential. Recorded as changed, never as what it changed to.
      changes.push({ key, before: MASK, after: MASK });
      continue;
    }
    const from = prior ? take(prior[1], budget) : { value: undefined, bounded: false };
    const to = take(next, budget);
    bounded = bounded || from.bounded || to.bounded;
    changes.push({ key, before: from.value, after: to.value });
  }

  // A key that was there and is gone: a prop removed, a context the component
  // stopped reading. It moved, so it is a change.
  for (const [key, prior] of before) {
    if (seen.has(key)) continue;
    if (changes.length >= OBSERVED_CHANGE_CAP) {
      bounded = true;
      break;
    }
    if (isSecretStateKey(key)) {
      changes.push({ key, before: MASK, after: undefined });
      continue;
    }
    const from = take(prior, budget);
    bounded = bounded || from.bounded;
    changes.push({ key, before: from.value, after: undefined });
  }

  return bounded;
}

/**
 * What re-rendered between two readings, as observations for `core/render`.
 *
 * A component present in both readings whose props object is the same object
 * did not render, and carries no entry at all: on a page where four components
 * moved and nine hundred did not, the nine hundred are what the budget would be
 * spent on.
 *
 * A component present only in the settled reading **mounted** during the step
 * and is also absent. It did not re-render — it rendered once, for the first
 * time — and the thing that put it on screen is the step itself, which the DOM
 * delta already describes.
 */
export function compareRenders(
  before: RenderSample,
  after: RenderSample,
  budget: SnapshotBudget,
  identify: Identify,
): { observed: AgentRenderObservation[]; capped: boolean } {
  const observed: AgentRenderObservation[] = [];

  for (const entry of after.entries) {
    const prior =
      before.byFiber.get(entry.fiber) ??
      (entry.alternate ? before.byFiber.get(entry.alternate) : undefined);
    if (!prior) continue;
    if (Object.is(prior.props, entry.props)) continue;

    const component = identifyFiber(entry.fiber, identify);
    // A component with no readable function has no id that joins to
    // `FlowReact.components`, and a row keyed on a name several components
    // share is worse than no row.
    if (!component) continue;

    const props: RenderChange[] = [];
    const hooks: RenderChange[] = [];
    const contexts: RenderChange[] = [];

    let bounded = changesBetween(prior.propValues, entry.propValues, budget, props);
    bounded = changesBetween(prior.hooks, entry.hooks, budget, hooks) || bounded;
    bounded = changesBetween(prior.contexts, entry.contexts, budget, contexts) || bounded;

    // The children the reader was not shown — see `readProps`. Reported with no
    // value and `bounded` set, which is the contract's way of saying a value
    // could not be snapshotted, and which is what stops `wasted` being claimed
    // over a change that was real and simply not printable.
    const priorChildren = childrenOf(prior.props);
    const nextChildren = childrenOf(entry.props);
    if (!Object.is(priorChildren, nextChildren)) {
      props.push({ key: 'children' });
      bounded = true;
    }

    observed.push({ component, props, hooks, contexts, bounded });
  }

  return { observed, capped: before.capped || after.capped };
}

function childrenOf(props: unknown): unknown {
  if (!props || typeof props !== 'object') return undefined;
  try {
    return (props as Record<string, unknown>).children;
  } catch {
    return undefined;
  }
}

/** A component id minted by the recorder's own function — see `Identify`. */
function identifyFiber(fiber: RenderFiber, identify: Identify): string {
  const fn = componentFn(fiber);
  if (!fn) return '';
  try {
    return identify(fn, getDisplayName(fiber));
  } catch {
    return '';
  }
}

/**
 * Why a recording has less here than the reader expected.
 *
 * The three nothings are different and a reader who cannot tell them apart
 * assumes the worst: render sampling switched off, a page with no React, and a
 * page where genuinely nothing re-rendered. The first is answered from the
 * settings on the isolated side; this is the second.
 */
export function renderNote(sample: RenderSample): string | undefined {
  if (sample.roots) return undefined;
  return 'No React root was found on this page. DevFlow reads renders off the fibers React keeps, so a page that is not React has none to read.';
}
