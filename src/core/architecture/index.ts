/**
 * The Living Architecture Map: what is mounted on a page, as one reading found
 * it.
 *
 * ## What this is, and the word it does not get to use
 *
 * `ROADMAP_AND_PHASES.md` §3.3 asks for a *real-time* component graph that
 * "updates in real-time as the developer navigates the app". That wording does
 * not survive contact, in the way `get_full_lineage(domNodeId)` and
 * `compare_flows_across_deploys(flowId, sha1, sha2)` did not, and the correction
 * is the finding rather than a detail.
 *
 * A model calling a tool asks **once**, at a moment, and gets **one** answer.
 * There is no frame in which a stream would be rendered and no reader watching
 * it arrive. So "real-time" for an MCP tool can only ever mean *fresh at the
 * moment it was read*, and the honest unit of that is a **reading with an age on
 * it** — never a feed. Everything here is therefore built around making the age
 * impossible to lose: `takenAt` is a required field of the reading rather than
 * an optional annotation, `describeAge` exists so that no caller has to invent
 * the phrasing, and `renderArchitecture` prints the age and the URL in its first
 * line, before anything a reader might otherwise act on.
 *
 * The alternative — a persistent channel from the server back to an open tab —
 * was costed and is not what this delivers. It needs a socket the MV3 service
 * worker must be kept awake to hold, for a feature that may never be called, and
 * it buys nothing a model can use: the answer would still be a single snapshot
 * taken at the moment of the call. Paying a permanent cost on every page for a
 * word in a roadmap is the trade this project keeps refusing.
 *
 * ## Structure, never values
 *
 * A reading carries **which components are mounted** and **which contexts they
 * depend on**. It carries no prop, no hook state and no store value, and that is
 * a design decision rather than a budget that happened to run out.
 *
 * A recording is values: somebody pressed Start, knew a capture was running, and
 * chose what left the browser in the send dialog. A map is structure, and it is
 * taken while somebody is reading code with nothing recording. Putting store
 * values into it would make an ambient background write carry the most sensitive
 * thing DevFlow can see, through a path that has no send dialog in front of it.
 * So there is nowhere in this module for a value to sit — not capped, not
 * redacted, absent — which is the only version of that rule that cannot be
 * loosened by a later caller passing a bigger budget.
 *
 * It is also why this is cheap. No value read means no snapshot walk, no
 * circular-reference handling and no secret-key masking on a page nobody asked
 * to record.
 *
 * ## Pure
 *
 * No DOM, no `chrome.*`, no `fetch`, no clock, no randomness. The reading is
 * taken by `src/injected/architecture.ts`, which has the fibers; the judgement —
 * what to keep, in what order, and what to say when the walk was cut — is here,
 * and is bundled into `mcp-server/core.js` so the tool and the extension render
 * one map rather than two that disagree.
 */

import type { Pos1 } from '../locate/positions.js';

/**
 * One mounted instance of a component, exactly as the page walk saw it.
 *
 * This is the wire shape between `injected/architecture.ts` and this module, and
 * it is per **instance** rather than per component on purpose: twenty rows of
 * one `<Row>` are one component and twenty mounted things, and only the walk can
 * still tell them apart. Collapsing them is this module's job, below.
 */
export interface ComponentInstanceReading {
  /** The component id `agent.ts` mints — a hash of its compiled source. */
  readonly id: string;
  readonly name: string;
  /** How deep in the tree this instance sat. Root is 0. */
  readonly depth: number;
  /** Where it was written, when the fiber carried a build stamp or `_debugSource`. */
  readonly sourceFile?: string;
  readonly sourceLine?: Pos1;
  /** Ids of the contexts this instance's fiber declared a dependency on. */
  readonly contextIds: readonly string[];
}

/** One context whose value mounted components depend on. */
export interface ContextReading {
  readonly id: string;
  /** How the context names itself — its `displayName`, or its provider's name. */
  readonly label: string;
  /**
   * What the value behind it looked like, when it was recognisable.
   *
   * `state.ts` classifies a context value as Redux, TanStack Query or Zustand by
   * shape. This carries the same answer when the shape was recognised and
   * `'context'` when it was not, because most contexts in most apps are just
   * contexts and calling one a "store" it is not would put a word in the map
   * that the app's authors would not recognise.
   */
  readonly kind: string;
}

/** One bounded reading of one page. Structure only — see the header. */
export interface PageReading {
  readonly url: string;
  readonly title: string;
  /** React's own version string, when the page reported one. */
  readonly reactVersion?: string;
  /** React roots found. Zero is a page with no React, which is not a failure. */
  readonly roots: number;
  /** The walk stopped at its cap, so what is missing was never seen. */
  readonly capped: boolean;
  readonly instances: readonly ComponentInstanceReading[];
  readonly contexts: readonly ContextReading[];
}

/** One component, with its instances collapsed. */
export interface MountedComponent {
  readonly id: string;
  readonly name: string;
  /** How many of it were mounted at the reading. Never zero. */
  readonly instances: number;
  /** The shallowest depth any instance sat at — what orders the map. */
  readonly depth: number;
  readonly sourceFile?: string;
  readonly sourceLine?: Pos1;
  /** Ids of contexts instances of it depend on, in first-seen order. */
  readonly reads: readonly string[];
}

/** One context, with the components observed depending on it. */
export interface MountedContext {
  readonly id: string;
  readonly label: string;
  readonly kind: string;
  /** Component ids, in first-seen order. Never empty — see `buildArchitecture`. */
  readonly subscribers: readonly string[];
}

/** What one reading of a page amounts to, ready to render. */
export interface ArchitectureSnapshot {
  readonly url: string;
  readonly title: string;
  readonly reactVersion?: string;
  /** Epoch milliseconds, supplied by the impure caller. This module has no clock. */
  readonly takenAt: number;
  readonly roots: number;
  readonly capped: boolean;
  readonly components: readonly MountedComponent[];
  readonly contexts: readonly MountedContext[];
  /** Instances seen, before collapsing. `components.length` is not this number. */
  readonly totalInstances: number;
}

/** How much of a reading survives into the answer. */
export interface ArchitectureLimits {
  readonly maxComponents: number;
  readonly maxContexts: number;
}

export const DEFAULT_ARCHITECTURE_LIMITS: ArchitectureLimits = {
  maxComponents: 120,
  maxContexts: 24,
};

/**
 * Collapse one page reading into a map.
 *
 * The ordering is **shallowest first**, and that is the decision in this
 * function. The obvious alternative is most-instances-first, which puts the
 * `<Row>` rendered two hundred times at the top and `<App>` near the bottom —
 * true, and useless as a map, because the question this answers is *how is this
 * page put together* and the answer to that reads root-downwards. Ties break on
 * instance count and then on the id, so two readings of one unchanged page
 * render identically; nothing here reads a clock or a random.
 *
 * A component with no name is dropped rather than keyed on the empty string,
 * which is the same rule `features/arkg/ingest.ts` applies for the same reason:
 * one node accumulating every anonymous observation is worse than a gap.
 *
 * A context nothing depends on is dropped too, and that one is worth stating.
 * The walk can see a provider whose consumers were all beyond the node cap, and
 * a "store with no subscribers" is a claim about the app that would be false —
 * it is a fact about where the walk stopped. `capped` already carries that, once
 * and honestly, so it is not restated as a row that reads like a finding.
 */
export function buildArchitecture(
  page: PageReading,
  takenAt: number,
  limits: ArchitectureLimits = DEFAULT_ARCHITECTURE_LIMITS,
): ArchitectureSnapshot {
  const byId = new Map<
    string,
    { id: string; name: string; instances: number; depth: number; sourceFile?: string; sourceLine?: Pos1; reads: string[] }
  >();
  const subscribers = new Map<string, string[]>();

  for (const instance of page.instances) {
    const name = instance.name?.trim();
    if (!instance.id || !name) continue;

    let entry = byId.get(instance.id);
    if (!entry) {
      entry = { id: instance.id, name, instances: 0, depth: instance.depth, reads: [] };
      byId.set(instance.id, entry);
    }
    entry.instances += 1;
    if (instance.depth < entry.depth) entry.depth = instance.depth;

    // First source wins, rather than last. Two instances of one component are
    // written in one place, so a second answer is not new evidence — and if the
    // two ever disagree, the shallower instance was read first and is the one
    // the walk is more confident about.
    if (!entry.sourceFile && instance.sourceFile) {
      entry.sourceFile = instance.sourceFile;
      if (instance.sourceLine !== undefined) entry.sourceLine = instance.sourceLine;
    }

    for (const contextId of instance.contextIds) {
      if (!entry.reads.includes(contextId)) entry.reads.push(contextId);
      const list = subscribers.get(contextId);
      if (list) {
        if (!list.includes(instance.id)) list.push(instance.id);
      } else {
        subscribers.set(contextId, [instance.id]);
      }
    }
  }

  const components = [...byId.values()]
    .sort((a, b) => a.depth - b.depth || b.instances - a.instances || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, limits.maxComponents))
    .map(
      (entry): MountedComponent => ({
        id: entry.id,
        name: entry.name,
        instances: entry.instances,
        depth: entry.depth,
        ...(entry.sourceFile ? { sourceFile: entry.sourceFile } : {}),
        ...(entry.sourceLine !== undefined ? { sourceLine: entry.sourceLine } : {}),
        reads: entry.reads,
      }),
    );

  const contexts = page.contexts
    .filter((context) => (subscribers.get(context.id)?.length ?? 0) > 0)
    .sort((a, b) => (subscribers.get(b.id)?.length ?? 0) - (subscribers.get(a.id)?.length ?? 0)
      || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, Math.max(0, limits.maxContexts))
    .map(
      (context): MountedContext => ({
        id: context.id,
        label: context.label,
        kind: context.kind,
        subscribers: subscribers.get(context.id) ?? [],
      }),
    );

  return {
    url: page.url,
    title: page.title,
    ...(page.reactVersion ? { reactVersion: page.reactVersion } : {}),
    takenAt,
    roots: page.roots,
    capped: page.capped,
    components,
    contexts,
    totalInstances: page.instances.length,
  };
}

/**
 * How long ago a reading was taken, in words.
 *
 * Deliberately coarse. A map presented as "4.812 seconds old" invites a reader
 * to believe the page has not changed in those 4.812 seconds, which nothing
 * here knows: a single click between the reading and the answer can unmount half
 * of it. Rounded units say what is actually being claimed — that this is roughly
 * how recently somebody looked.
 */
export function describeAge(ageMs: number): string {
  if (!Number.isFinite(ageMs) || ageMs < 0) return 'at an unknown time';
  const seconds = Math.round(ageMs / 1000);
  if (seconds < 5) return 'just now';
  if (seconds < 90) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 36) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

/**
 * Past this, a reading is history rather than a map of what is on screen.
 *
 * Ten minutes is a judgement and is stated as one wherever it is used. It is not
 * a correctness boundary — nothing becomes wrong at 601 seconds — it is the
 * point past which offering a reading under the word "mounted" would mislead
 * more often than it helps, because a developer navigates several times in ten
 * minutes. The reading is still printed; what changes is the sentence above it.
 */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/** Whether a reading is old enough that it should be offered as history. */
export function isStale(snapshot: ArchitectureSnapshot, now: number): boolean {
  return now - snapshot.takenAt >= STALE_AFTER_MS;
}

/**
 * Render one map for a reader.
 *
 * The first line carries the age and the URL, and it carries them *before* the
 * component list, because everything below is only true of one page at one
 * moment and a reader who scrolls past that has been misled by the layout rather
 * than by the text.
 */
export function renderArchitecture(
  snapshot: ArchitectureSnapshot,
  now: number,
  otherPages: readonly string[] = [],
): string {
  const age = describeAge(now - snapshot.takenAt);
  const stale = isStale(snapshot, now);
  const lines: string[] = [];

  lines.push(
    stale
      ? `Living architecture — read ${age}, from ${snapshot.url}. This is the last reading, not the current page: at that age the developer has probably navigated since. Open the DevFlow panel and take another to see what is mounted now.`
      : `Living architecture — read ${age}, from ${snapshot.url}. A reading, not a feed: it describes the page as it was at that moment, and a single click can unmount half of it.`,
  );

  if (snapshot.title) lines.push(`Page title: ${snapshot.title}`);

  if (!snapshot.roots) {
    lines.push(
      '',
      'No React root was found on this page. DevFlow reads a mounted tree through React, so a page built with anything else reads as empty here — which is a fact about the reader, not about the page.',
    );
    return lines.join('\n');
  }

  lines.push(
    '',
    `${snapshot.components.length} component${snapshot.components.length === 1 ? '' : 's'} mounted in ` +
      `${snapshot.totalInstances} instance${snapshot.totalInstances === 1 ? '' : 's'}, across ` +
      `${snapshot.roots} React root${snapshot.roots === 1 ? '' : 's'}` +
      `${snapshot.reactVersion ? ` (React ${snapshot.reactVersion})` : ''}.`,
  );

  if (snapshot.capped) {
    lines.push(
      'The walk stopped at its node cap, so this is the top of the tree and not all of it. What is missing was never looked at — it is not absent from the page.',
    );
  }

  if (snapshot.components.length) {
    lines.push('', 'Components, outermost first — name, instances mounted, source, id:');
    for (const component of snapshot.components) {
      const source = component.sourceFile
        ? `  ${component.sourceFile}${component.sourceLine !== undefined ? `:${component.sourceLine}` : ''}`
        : '';
      lines.push(
        `  ${'  '.repeat(Math.min(component.depth, 6))}${component.name}` +
          `${component.instances > 1 ? `  ×${component.instances}` : ''}${source}  #${component.id}`,
      );
    }
  }

  /*
   * Contexts, and why this section is the answer to "which components subscribe
   * to which store" rather than a rename of it.
   *
   * The graph's own `subscribes_to` edge is component → **store**, never
   * component → key, and ADR 0005 records why: a context dependency is recorded
   * on the consuming fiber, and a closure is not. This is the same edge read
   * live instead of accumulated, so it inherits the same limit — a module-level
   * Zustand store with no provider is invisible here exactly as it is there, and
   * the note below says so rather than leaving the gap to read as "nothing
   * subscribes to anything".
   */
  if (snapshot.contexts.length) {
    lines.push('', 'State the mounted components read, most-subscribed first — context, kind, subscribers:');
    for (const context of snapshot.contexts) {
      lines.push(
        `  ${context.label}  (${context.kind})  ${context.subscribers.length} component` +
          `${context.subscribers.length === 1 ? '' : 's'}`,
      );
    }
  } else {
    lines.push(
      '',
      'No context-provided state was read. DevFlow sees a subscription through a React context, so a store held in a module — a Zustand store created outside a provider — leaves no dependency on a consumer’s fiber and cannot appear here.',
    );
  }

  if (otherPages.length) {
    lines.push(
      '',
      `Readings are also held for: ${otherPages.join(', ')}. This answer is the most recent of them.`,
    );
  }

  lines.push(
    '',
    'This is what is mounted, not what has been observed over time — get_app_architecture is the accumulated graph, with frequencies, failure rates and the endpoints each component calls.',
  );

  return lines.join('\n');
}
