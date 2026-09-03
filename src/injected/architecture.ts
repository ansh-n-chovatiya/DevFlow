/**
 * One reading of what is mounted on the page, taken without becoming part of it.
 *
 * ## One walk, no hook, nothing installed
 *
 * This is the third reader of React's tree in the page agent, and it is built to
 * the same rule as the other two: it **reads**, once, when asked. It defines no
 * global, patches no method, subscribes to nothing, installs no commit callback
 * and keeps no module-level state — so "inert when not asked" is not a property
 * this file maintains, it is a property it cannot violate, because between calls
 * there is nothing here to be running.
 *
 * That rule is not a style preference. The reverted `v3.2.0` answered the
 * neighbouring question — "why did this render?" — by taking React DevTools'
 * commit callback and walking the whole tree on every commit on every page the
 * extension was loaded into, gated on nothing. A page that renders on every
 * mousemove paid for a feature nobody had switched on. `injected/render.ts` says
 * so at length, and a *continuously updating* architecture map is the single
 * most natural place to make that mistake a second time, because "living" sounds
 * like it requires a subscription.
 *
 * It does not. A model calling a tool asks once and reads one answer, so what a
 * live map actually needs is a cheap reading available **on demand** and an age
 * printed beside it. `core/architecture` carries that argument in full; this
 * file is the half that touches fibers.
 *
 * ## Structure, never values
 *
 * Nothing here copies a prop, a hook or a store value out of the page. Contexts
 * are recognised by shape — `classifyKind` is `typeof` checks on methods, and
 * the value it is handed is not retained past the call — so a map can say
 * "redux" without carrying anything that was in the store.
 *
 * This is what makes the reading safe to take with nothing recording. A
 * recording is values, and a user pressed Start and chose in the send dialog
 * what left the browser. A map is taken while somebody reads code, through a
 * path with no dialog in front of it, so there is nowhere in the wire shape for
 * a value to sit — not capped, not redacted, absent.
 *
 * ## The double buffer is not a trap here, and that is worth stating
 *
 * `render.ts` has to register every component under both halves of its fiber
 * pair, because it compares two readings taken at two moments and React swaps
 * which half is `current` in between. This file takes **one** reading, so the
 * tree it walks is internally consistent by construction and no pairing is
 * needed. A future change that made this file compare two readings would need
 * `render.ts`'s machinery and would be a different feature.
 */

import type { ComponentFn, Fiber } from '../core/react/fiber.js';
import { getDisplayName } from '../core/react/fiber.js';
import { readStamp } from '../core/react/stamp.js';
import { pos1 } from '../core/react/positions.js';
import { redactUrl } from '../core/redact/index.js';
import type { ComponentInstanceReading, ContextReading, PageReading } from '../core/architecture/index.js';
import { reactRoots } from './roots.js';
import { classifyKind, type Identify } from './state.js';

/**
 * The fiber fields this file reads.
 *
 * Declared locally rather than widened onto `Fiber`, for the reason `render.ts`
 * and `state.ts` each declare their own: everything else in the tree keeps the
 * narrow `Fiber` it can rely on, and a field one reader needs does not become a
 * field every reader is offered.
 */
interface TreeFiber extends Fiber {
  tag?: number;
  memoizedProps?: Record<string, unknown> | null;
  dependencies?: { firstContext?: ContextDependency | null } | null;
  child: TreeFiber | null;
  sibling: TreeFiber | null;
  return: TreeFiber | null;
}

/** One entry of a fiber's context dependency list — a context it actually read. */
interface ContextDependency {
  context?: ReactContext | null;
  next?: ContextDependency | null;
}

/** React's context object, in the two shapes the supported versions give it. */
interface ReactContext {
  displayName?: string;
  _currentValue?: unknown;
  /** React ≤18: the provider element type carries the context under this. */
  _context?: ReactContext;
}

/**
 * `ContextProvider` — the one tag number this file depends on, 10 since fiber
 * tags were introduced. Read defensively all the same: a fiber failing the shape
 * checks below is skipped whatever its tag says, so a renumbering in some future
 * React costs coverage rather than correctness.
 */
const TAG_CONTEXT_PROVIDER = 10;

/** How many contexts one reading will name. Beyond this the map stops reading. */
const CONTEXT_CAP = 64;

/** How far down one fiber's dependency list to walk. `state.ts` uses the same. */
const DEPENDENCY_WALK_CAP = 32;

/**
 * The function a fiber renders, or null when it is not a component.
 *
 * The same three shapes `state.ts` and `render.ts` accept — a plain function,
 * `forwardRef`'s `render`, `memo`'s `type` — and nothing else. A host `<div>`
 * has no id worth minting and is not a component in the map; the walk still
 * counts it against the cap, because visiting it is what the cap measures.
 */
function componentFn(fiber: TreeFiber): ComponentFn | null {
  const type = fiber.type;
  if (typeof type === 'function') return type as ComponentFn;
  const wrapped =
    (type as { render?: ComponentFn } | null)?.render ?? (type as { type?: ComponentFn } | null)?.type;
  return typeof wrapped === 'function' ? wrapped : null;
}

/** The context a provider fiber provides, across the versions that differ. */
function contextOf(fiber: TreeFiber): ReactContext | null {
  const type = fiber.type as ReactContext | undefined;
  if (!type || typeof type !== 'object') return null;
  // React ≤18 wraps the context in a provider object; React 19 renders the
  // context itself. `_currentValue` is what distinguishes the two.
  const context = type._context ?? type;
  return context && typeof context === 'object' && '_currentValue' in context ? context : null;
}

/**
 * Where a component was written, when the page can say so at all.
 *
 * A build stamp first and `_debugSource` second, which is the order every other
 * attribution in DevFlow uses: the stamp names the component's *own* file, while
 * `_debugSource` on a fiber names the file of the JSX that *rendered* it, which
 * is its parent's. Read as a pair rather than field by field — taking the name
 * from one and the line from the other would file a real line under a file it is
 * not in.
 *
 * Most production pages answer neither, and that is the ordinary case rather
 * than a failure: the source maps that would answer it are resolved a process
 * away, in the panel and the worker, over bundles this MAIN-world script cannot
 * fetch. A map whose components carry names and ids and no files is still a map,
 * and `get_app_architecture` holds the resolved files for the ones a recording
 * or a pick has already been through.
 */
function sourceOf(fiber: TreeFiber, fn: ComponentFn): { file: string; line?: number } | null {
  const stamp = readStamp(fn) ?? readStamp(fiber.type);
  if (stamp?.source) {
    return { file: stamp.source, ...(stamp.line ? { line: stamp.line } : {}) };
  }
  const debug = (fiber as { _debugSource?: { fileName?: string; lineNumber?: number } })._debugSource;
  if (debug?.fileName) {
    return { file: debug.fileName, ...(debug.lineNumber ? { line: debug.lineNumber } : {}) };
  }
  return null;
}

/**
 * Read the mounted tree once.
 *
 * `nodeCap` is the same budget the recorder's render sampling runs under
 * (`recording.renderNodeCap`), deliberately: the two walks visit the same tree
 * and a map allowed to be more expensive than a recording would be the one
 * feature able to drop a frame on a page nobody asked to record.
 *
 * `identify` is the caller's — `agent.ts` owns the component id, a hash over the
 * compiled function source cached per function. A second implementation here
 * would mint ids that look like the recorder's and join to nothing, so the map's
 * `#id`s would not open in `get_component_history`.
 *
 * Breadth-first, so `depth` is the real distance from a root and the cap cuts
 * the *bottom* of the tree rather than an arbitrary branch of it. That is what
 * makes a capped reading still a usable architecture map: what survives is the
 * outer structure, which is the part somebody asking "how is this page put
 * together" wanted.
 */
export function sampleArchitecture(
  nodeCap: number,
  identify: Identify,
  reactVersion?: string,
): PageReading {
  const roots = reactRoots<TreeFiber>();
  const instances: ComponentInstanceReading[] = [];
  const contexts: ContextReading[] = [];
  const contextIds = new Map<ReactContext, string>();
  let capped = false;

  const cap = Math.max(1, nodeCap);
  // Depth travels with the fiber rather than being climbed for, because a
  // `return` chain can loop on a half-torn-down tree and a queue cannot.
  const queue: { fiber: TreeFiber; depth: number }[] = roots.map((fiber) => ({ fiber, depth: 0 }));
  let head = 0;
  let visited = 0;

  while (head < queue.length) {
    const { fiber, depth } = queue[head++];
    if (++visited > cap) {
      capped = true;
      break;
    }

    if (fiber.tag === TAG_CONTEXT_PROVIDER) noteProvider(fiber, contextIds, contexts);
    noteComponent(fiber, depth, identify, contextIds, contexts, instances);

    // The child's whole sibling chain, one level at a time, bounded by the cap
    // as well as by the chain: a virtualised list can have fifty thousand
    // siblings, and a queue built from all of them costs more than the walk that
    // will never reach them.
    let enqueued = 0;
    for (let child = fiber.child; child && enqueued < cap; child = child.sibling) {
      queue.push({ fiber: child, depth: depth + 1 });
      enqueued++;
    }
  }

  return {
    url: redactUrl(location.href),
    title: document.title?.slice(0, 200) ?? '',
    ...(reactVersion ? { reactVersion } : {}),
    roots: roots.length,
    capped,
    instances,
    contexts,
  };
}

/**
 * Give one provider's context a name and an id for this reading.
 *
 * The id is positional and therefore reading-scoped, which is all it has to be:
 * it exists to join `instances[].contextIds` to `contexts[]` inside one answer,
 * and nothing stores it. A stable cross-recording name is a different problem
 * with a different answer — `labelFor` in `state.ts`, keyed on the store's shape
 * — and it needs the value, which this file does not read.
 */
function noteProvider(
  fiber: TreeFiber,
  contextIds: Map<ReactContext, string>,
  contexts: ContextReading[],
): void {
  if (contexts.length >= CONTEXT_CAP) return;
  const context = contextOf(fiber);
  if (!context || contextIds.has(context)) return;

  const id = `ctx:${contexts.length}`;
  contextIds.set(context, id);

  const declared = typeof context.displayName === 'string' ? context.displayName.trim() : '';
  let kind = 'context';
  try {
    kind = classifyKind(fiber.memoizedProps?.value);
  } catch {
    // A provider whose props throw on read — a proxy, a torn-down tree. The
    // context is still named; only the kind is unknown, and 'context' is the
    // honest answer to that rather than a guess at a richer one.
  }

  contexts.push({
    id,
    // A declared `displayName` is the app's own name for the thing and always
    // wins. Failing that, the provider fiber's display name — `getDisplayName`
    // renders a context provider as something like `CartContext.Provider`, which
    // is the app's name for it in every case where the app named the context at
    // all, and a bare `Context.Provider` where it did not. That is a weak label
    // and it is not a wrong one, which the shape fallback `state.ts` uses would
    // risk being: two contexts of identical shape share a name there, and here
    // they would be told apart by their ids and merged by their labels.
    label: (declared || getDisplayName(fiber) || 'Context').slice(0, 60),
    kind,
  });
}

/** Record one component instance, if it is one and if it can be named. */
function noteComponent(
  fiber: TreeFiber,
  depth: number,
  identify: Identify,
  contextIds: Map<ReactContext, string>,
  contexts: ContextReading[],
  instances: ComponentInstanceReading[],
): void {
  const fn = componentFn(fiber);
  if (!fn) return;

  const name = getDisplayName(fiber);
  if (!name) return;

  let id: string;
  try {
    id = identify(fn, name);
  } catch {
    // A component whose compiled source cannot be read has no id that joins to
    // anything. Dropped rather than recorded under a name-only id, which several
    // unrelated components would share — the rule `state.ts` applies to a
    // dependency for the same reason.
    return;
  }
  if (!id) return;

  const source = sourceOf(fiber, fn);

  instances.push({
    id,
    name,
    depth,
    ...(source ? { sourceFile: source.file } : {}),
    // `pos1` is an assertion at an edge, not a conversion: React and a build
    // stamp both write the line a person would read, so this states what the
    // number already is. There is no arithmetic here and there must never be.
    ...(source?.line ? { sourceLine: pos1(source.line) } : {}),
    contextIds: readDependencies(fiber, contextIds, contexts),
  });
}

/**
 * The contexts this fiber actually consumed on its last render.
 *
 * `dependencies.firstContext` is React's own list, so this is observation rather
 * than inference. Being rendered *underneath* a provider is not reading it, is
 * true of almost every component in the app, and is never counted — a subscriber
 * list that names everything answers nothing.
 *
 * A context reached this way that no provider fiber was seen for still gets an
 * entry, because the consumer is proof the provider exists: a provider above the
 * walk's starting root, or one whose fiber the cap cut, is a real context this
 * component really reads. Labelled from the context object itself, which is the
 * only evidence available at that point.
 */
function readDependencies(
  fiber: TreeFiber,
  contextIds: Map<ReactContext, string>,
  contexts: ContextReading[],
): string[] {
  const first = fiber.dependencies?.firstContext;
  if (!first) return [];

  const out: string[] = [];
  let dep: ContextDependency | null | undefined = first;
  for (let hops = 0; dep && hops < DEPENDENCY_WALK_CAP; hops++, dep = dep.next) {
    const context = dep.context;
    if (!context) continue;

    let id = contextIds.get(context);
    if (!id) {
      if (contexts.length >= CONTEXT_CAP) continue;
      id = `ctx:${contexts.length}`;
      contextIds.set(context, id);
      const declared = typeof context.displayName === 'string' ? context.displayName.trim() : '';
      contexts.push({ id, label: (declared || 'Context').slice(0, 60), kind: 'context' });
    }
    if (!out.includes(id)) out.push(id);
  }
  return out;
}
