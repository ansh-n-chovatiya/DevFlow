/**
 * What one interaction set off — the cascade, laid out for drawing.
 *
 * ## The question, and why it needed a module rather than a view
 *
 * `ROADMAP_AND_PHASES.md` §3.3 asks for *"show me everything that renders when I
 * click checkout"* as a graph. Two thirds of the answer already exist and are
 * kept apart: `core/causal` derives what a step caused — the requests it fired,
 * the stores it moved, the lines it logged — and `core/render/blame` says which
 * components re-rendered across it. Neither knows about the other, because a
 * re-render is **not a causal event**: `CausalGraph` has four kinds and `render`
 * is not one of them, deliberately, since a component has no identity the
 * accumulating graph could key stably across recordings.
 *
 * So the new work is a **join**, and a join is where a tool of this kind lies
 * most easily. Putting a component in the same picture as a state change is one
 * pixel away from claiming that state change re-rendered it. That claim is
 * sometimes true, sometimes a coincidence, and always plausible-looking.
 *
 * ## The join is gated on evidence, and says which it had
 *
 * Three rules, strongest first, and every render edge carries the one it was
 * drawn on:
 *
 *   1. **`subscribed`** — the component is on that store's `subscribers` list
 *      *and* the store moved on this step. `StateStoreRef.subscribers` is an
 *      observation off the component's own fiber, not an inference: being
 *      rendered underneath a provider is not reading it and was never counted
 *      there. This is the strong edge.
 *   2. **`named`** — the render's own `contexts` list carries a key equal to a
 *      moved store's label. That is React telling us the component's fiber
 *      depended on a context whose value differed, matched to the store by the
 *      app's own name for it. Two contexts sharing a `displayName` collide, so
 *      this is medium and not high.
 *   3. **`sampled`** — neither of the above. The component is attached to the
 *      **step**, not to a state change, with the honest detail: it re-rendered
 *      across this interaction, and what handed it new values was not observed.
 *
 * There is no fourth rule that guesses. A component and a store that moved in
 * the same step with no subscription and no name in common are two things that
 * happened, and this module draws them as two things that happened.
 *
 * ## Everything else is `core/causal`, unchanged
 *
 * The step → network → console structure is not re-derived here. It is
 * `buildCausalGraph` and `effectsOf`, read once, with the layers taken from
 * causal distance. Building a second derivation beside a working one is the
 * mistake `src/core/mcp-bundle.ts` exists because of, and ADR 0007 already
 * settled that causality is derived at read time rather than stamped — which is
 * what lets this run over every recording already on somebody's disk rather than
 * only over ones made after today.
 *
 * ## Sampled, not counted, and it keeps saying so
 *
 * A re-render here is evidence from two samples per interaction. A component
 * that rendered forty times and one that rendered once are the same entry; a
 * value that changed and changed back is no change. `core/render/blame.ts` says
 * this at length and `notes` carries it into the drawing, because a graph is
 * exactly the presentation that invites a reader to believe it is complete.
 *
 * Pure — no DOM, no Chrome, no clock, no randomness. The drawing is
 * `ui/viewer/cascade.ts`; what is here is what to draw and what may be claimed.
 */

import {
  buildCausalGraph,
  effectsOf,
  eventRef,
  type CausalBasis,
  type CausalConfidence,
  type CausalConsoleEntry,
  type CausalNetworkCall,
  type CausalStateDelta,
  type EventRef,
} from '../causal/index.js';

/**
 * What one component did across the step, as much of it as this module reads.
 *
 * Structural and narrower than `StepRender`, for `CausalFlow`'s stated reason: a
 * step held in the extension, a `flow.json` parsed off disk and a `FlowPayload`
 * should all be the same argument. `props` and `hooks` are counted and never
 * read — their *values* are the recording's, and a cascade shows shape.
 */
export interface CascadeRender {
  readonly component: string;
  readonly props?: readonly { key: string }[];
  readonly hooks?: readonly { key: string }[];
  readonly contexts?: readonly { key: string }[];
  readonly wasted?: boolean;
  readonly bounded?: boolean;
  readonly moreChanges?: number;
}

/** One store the recording knows about, for the subscription join. */
export interface CascadeStore {
  readonly id: string;
  readonly label?: string;
  readonly kind?: string;
  readonly subscribers?: readonly string[];
}

/** One step, widened exactly as `CausalStep` is. */
export interface CascadeStep {
  readonly timestamp: number;
  readonly stepNumber?: number;
  readonly type: string;
  readonly action: string;
  readonly url?: string;
  readonly consoleLogs?: readonly CausalConsoleEntry[];
  readonly networkCalls?: readonly CausalNetworkCall[];
  readonly state?: readonly CascadeStateDelta[];
  readonly renders?: readonly CascadeRender[];
}

/** `CausalStateDelta` plus the store id, which the causal graph does not need. */
export interface CascadeStateDelta extends CausalStateDelta {
  readonly bounded?: boolean;
  readonly collapsed?: number;
}

export interface CascadeInput {
  readonly steps: readonly CascadeStep[];
  /** The flow's stores, for `subscribers`. Absent on a recording with no state. */
  readonly stores?: readonly CascadeStore[];
  /** Component id → the name a person reads. Absent ids fall back to the id. */
  readonly componentNames?: Readonly<Record<string, string>>;
}

/** Why one render was attached where it was attached. */
export type RenderBasis = 'subscribed' | 'named' | 'sampled';

export type CascadeBasis = CausalBasis | RenderBasis;

export type CascadeKind = 'step' | 'state' | 'render' | 'network' | 'console';

export interface CascadeNode {
  readonly ref: EventRef;
  readonly kind: CascadeKind;
  /** One line a reader identifies it by. */
  readonly label: string;
  /** A second line, when there is one worth the room. */
  readonly detail?: string;
  /** Causal distance from the interaction. The step itself is 0. */
  readonly layer: number;
  /** Set on a render that re-rendered with nothing observed changing. */
  readonly wasted?: boolean;
  /** An observation that was cut, so "nothing changed" is about the cap. */
  readonly bounded?: boolean;
}

export interface CascadeEdge {
  readonly from: EventRef;
  readonly to: EventRef;
  readonly basis: CascadeBasis;
  readonly confidence: CausalConfidence;
  /** What was actually seen, never what it implies. */
  readonly detail: string;
}

export interface Cascade {
  readonly step: number;
  /** The interaction, as the recording wrote it. */
  readonly action: string;
  /** Nodes by causal distance. `layers[0]` is always the one step node. */
  readonly layers: readonly (readonly CascadeNode[])[];
  readonly edges: readonly CascadeEdge[];
  /** What this picture cannot claim, in the reader's words. Never empty. */
  readonly notes: readonly string[];
  /** Nodes a layer could not hold, so a reader knows the picture was cut. */
  readonly dropped: number;
}

export interface CascadeLimits {
  /** Nodes one layer may draw. Beyond it the count is reported instead. */
  readonly maxPerLayer: number;
  /** How far from the interaction to follow the causal graph. */
  readonly maxDepth: number;
}

export const DEFAULT_CASCADE_LIMITS: CascadeLimits = { maxPerLayer: 24, maxDepth: 6 };

const CONFIDENCE_RANK: Record<CausalConfidence, number> = { high: 3, medium: 2, low: 1 };

/**
 * The layer a node belongs in, given the edges arriving at it.
 *
 * Strongest evidence first, then nearest, then the ref so two runs over one
 * recording agree. `null` when no parent has been placed yet — the caller is
 * iterating to a fixpoint and will come back.
 */
function bestParent(arriving: readonly CascadeEdge[], layerOf: Map<EventRef, number>): number | null {
  let winner: { rank: number; layer: number; ref: EventRef } | null = null;
  for (const edge of arriving) {
    const layer = layerOf.get(edge.from);
    if (layer === undefined) continue;
    const rank = CONFIDENCE_RANK[edge.confidence] ?? 0;
    if (
      !winner ||
      rank > winner.rank ||
      (rank === winner.rank && layer < winner.layer) ||
      (rank === winner.rank && layer === winner.layer && edge.from < winner.ref)
    ) {
      winner = { rank, layer, ref: edge.from };
    }
  }
  return winner ? winner.layer + 1 : null;
}

/** A render's ref. Not a `CausalEvent` kind, so it gets its own namespace. */
function renderRef(step: number, component: string): EventRef {
  return `render:${step}/${component}`;
}

/**
 * Read a render ref back. The counterpart of `renderRef`, and the reason both
 * are here rather than inline: a syntax parsed in a second place has forked.
 */
export function parseRenderRef(ref: EventRef): { step: number; component: string } | null {
  const match = /^render:(0|[1-9][0-9]*)\/(.+)$/.exec(ref);
  return match ? { step: Number(match[1]), component: match[2] } : null;
}

/**
 * The number each step is addressed by.
 *
 * Copied from `core/causal`'s rule, which is private to that file, for the same
 * reason `core/diagnose` copies it: every node in this picture except the step
 * itself is looked up in the graph that module mints, so a root ref built off a
 * number it would not have used names no event. `stepNumber` is stamped at
 * capture time and goes stale after a deletion — see `renumber()` — so the
 * stamped numbers are used only while they are all distinct, and position is
 * used for the whole flow when they are not.
 *
 * Derived here rather than left to every caller to `renumber()` first, because
 * the failure mode of trusting them is invisible: on a flow with two steps
 * stamped `3` the root ref matched no event, `effectsOf` came back empty, and
 * the cascade drew the interaction with nothing beneath it — which is exactly
 * what a step that caused nothing looks like. A picture that is silently empty
 * is worse than one that is missing.
 */
function stepNumbers(steps: readonly CascadeStep[]): number[] {
  const stamped = steps.map((step, i) => step.stepNumber ?? i + 1);
  return new Set(stamped).size === stamped.length ? stamped : steps.map((_, i) => i + 1);
}

/**
 * Build the cascade for one step.
 *
 * Returns `null` when the step is not in the flow, rather than an empty cascade:
 * a step nobody recorded and a step that caused nothing are different answers,
 * and the caller is the only place that knows which sentence to show.
 */
export function buildCascade(
  input: CascadeInput,
  stepNumber: number,
  limits: CascadeLimits = DEFAULT_CASCADE_LIMITS,
): Cascade | null {
  const index = stepNumbers(input.steps).indexOf(stepNumber);
  if (index === -1) return null;
  const step = input.steps[index];

  const rootRef = eventRef('step', stepNumber);
  const graph = buildCausalGraph({ steps: input.steps });
  const byRef = new Map(graph.events.map((event) => [event.ref, event]));

  /*
   * Layers come from the causal graph, and a node's column is decided by its
   * **strongest** incoming edge rather than by its shortest path.
   *
   * Two things settled this, and both were measured rather than reasoned about.
   * First, a kind-per-column layout — "state, then renders, then network" —
   * reads tidily and is a claim nobody made: a recording where the request went
   * first and the store moved on its response would be drawn backwards, every
   * time, and would still look exactly right.
   *
   * Second, shortest-path is not the same as best-evidence here, which a probe
   * of the real graph showed and an earlier draft of this file got wrong. A
   * console line logged under a failing request carries **two** parents: the
   * step, `attributed medium`, because it happened during that interaction; and
   * the request itself, `named high`, because the line quotes it. Both are one
   * hop from nothing, so shortest-path drew the error beside the request rather
   * than after it, and the strong edge — the only one that says anything — was
   * invisible in the layout. Ranking by confidence puts the line where the
   * evidence puts it.
   *
   * Resolved to a fixpoint rather than in walk order, because a node's best
   * parent can arrive after a weaker one. Bounded by the depth limit, so a graph
   * that somehow cycled cannot spin here.
   */
  const links = effectsOf(graph, rootRef, limits.maxDepth);
  const edges: CascadeEdge[] = links.map((link) => ({
    from: link.from,
    to: link.to,
    basis: link.basis,
    confidence: link.confidence,
    detail: link.detail,
  }));

  const layerOf = new Map<EventRef, number>([[rootRef, 0]]);
  const incoming = new Map<EventRef, CascadeEdge[]>();
  for (const edge of edges) {
    const list = incoming.get(edge.to);
    if (list) list.push(edge);
    else incoming.set(edge.to, [edge]);
  }

  for (let pass = 0; pass <= limits.maxDepth + 1; pass++) {
    let settled = true;
    for (const [ref, arriving] of incoming) {
      const best = bestParent(arriving, layerOf);
      if (best === null) continue;
      if (layerOf.get(ref) !== best) {
        layerOf.set(ref, best);
        settled = false;
      }
    }
    if (settled) break;
  }

  const nodes = new Map<EventRef, CascadeNode>();
  nodes.set(rootRef, {
    ref: rootRef,
    kind: 'step',
    label: step.action,
    ...(step.url ? { detail: step.url } : {}),
    layer: 0,
  });

  for (const [ref, layer] of layerOf) {
    if (ref === rootRef) continue;
    const event = byRef.get(ref);
    if (!event) continue;
    // `state`, `network` and `console` are the three causal kinds that are not
    // the step. Anything else is a kind added to `core/causal` since this was
    // written, and is drawn rather than dropped — an unknown node with a real
    // label is more use than a hole.
    const kind: CascadeKind =
      event.kind === 'network' || event.kind === 'console' || event.kind === 'state'
        ? event.kind
        : 'state';
    nodes.set(ref, { ref, kind, label: event.label, layer });
  }

  attachRenders(input, step, stepNumber, rootRef, layerOf, nodes, edges);

  return assemble(step, stepNumber, nodes, edges, limits, notesFor(step, input));
}

/**
 * Hang each re-rendered component off the best evidence there is for it.
 *
 * The three rules are in the module header. What is worth repeating here is the
 * one that is easy to lose in a refactor: **rule 3 attaches to the step, not to
 * a nearby state change.** A component that re-rendered in a step where some
 * store also moved is not thereby a component that store re-rendered, and the
 * whole value of this picture is that it does not say so.
 */
function attachRenders(
  input: CascadeInput,
  step: CascadeStep,
  stepNumber: number,
  rootRef: EventRef,
  layerOf: Map<EventRef, number>,
  nodes: Map<EventRef, CascadeNode>,
  edges: CascadeEdge[],
): void {
  const renders = step.renders ?? [];
  if (!renders.length) return;

  /*
   * Only stores that actually moved on this step are candidates: a store the
   * component subscribes to that stayed still explains nothing about a render.
   *
   * The state event's ref is **found**, not rebuilt. `core/causal` writes it as
   * `state:<step>/<store id>/<n>` — one event per key of the store, not one per
   * store — and an earlier draft of this file reconstructed it as `state:N.1`
   * and silently matched nothing, so every render fell through to `sampled` and
   * the picture looked entirely reasonable. A ref is a string with no type to
   * catch that, which is exactly why `eventRef` exists and why nothing else
   * should be building one. Matching on the prefix keeps the syntax in the one
   * module that owns it.
   */
  const moved = new Map<string, { ref: EventRef; store: CascadeStore }>();
  for (const delta of step.state ?? []) {
    const prefix = `${eventRef('state', stepNumber)}/${delta.store}/`;
    const found = [...layerOf.keys()].find((ref) => ref.startsWith(prefix));
    if (!found) continue;
    const store = input.stores?.find((candidate) => candidate.id === delta.store);
    moved.set(delta.store, { ref: found, store: store ?? { id: delta.store } });
  }

  for (const render of renders) {
    const name = input.componentNames?.[render.component] ?? render.component;
    const ref = renderRef(stepNumber, render.component);

    let parent = rootRef;
    let basis: RenderBasis = 'sampled';
    let confidence: CausalConfidence = 'low';
    let detail =
      'It re-rendered across this interaction. What handed it new values was not observed — no store it is known to read moved, and no context it depended on matched one that did.';

    for (const { ref: stateRef, store } of moved.values()) {
      if (store.subscribers?.includes(render.component)) {
        parent = stateRef;
        basis = 'subscribed';
        confidence = 'high';
        detail = `${name} was observed reading this store — the dependency is on its own fiber — and the store moved in this step.`;
        break;
      }
    }

    if (basis === 'sampled') {
      for (const { ref: stateRef, store } of moved.values()) {
        const label = store.label;
        if (label && render.contexts?.some((change) => change.key === label)) {
          parent = stateRef;
          basis = 'named';
          confidence = 'medium';
          detail = `A context ${name} depended on changed value, and its name matches this store’s. Two contexts can share a name, so this is a match rather than a sighting of the store itself.`;
          break;
        }
      }
    }

    const parentLayer = layerOf.get(parent) ?? 0;
    layerOf.set(ref, parentLayer + 1);
    nodes.set(ref, {
      ref,
      kind: 'render',
      label: name,
      detail: describeRender(render),
      layer: parentLayer + 1,
      ...(render.wasted ? { wasted: true } : {}),
      ...(render.bounded ? { bounded: true } : {}),
    });
    edges.push({ from: parent, to: ref, basis, confidence, detail });
  }
}

/** The second line under a render — counts, never values. */
function describeRender(render: CascadeRender): string {
  if (render.wasted) {
    return 'Re-rendered, and nothing DevFlow could see had changed value — the classic wasted render.';
  }
  const parts: string[] = [];
  if (render.props?.length) parts.push(`${render.props.length} prop${render.props.length === 1 ? '' : 's'}`);
  if (render.hooks?.length) parts.push(`${render.hooks.length} hook${render.hooks.length === 1 ? '' : 's'}`);
  if (render.contexts?.length) {
    parts.push(`${render.contexts.length} context${render.contexts.length === 1 ? '' : 's'}`);
  }
  if (render.moreChanges) parts.push(`${render.moreChanges} more`);
  if (!parts.length) return 'Re-rendered.';
  return `${parts.join(', ')} changed.`;
}

/**
 * What this picture may not be read as claiming.
 *
 * Never empty, and that is deliberate. A graph is the presentation that most
 * invites a reader to believe it is complete — it has edges, so it looks like it
 * knows what connects to what — and the two things most worth doubting about it
 * are true of every cascade ever drawn: it is sampled, and absence of an arrow
 * is not absence of a cause.
 */
function notesFor(step: CascadeStep, input: CascadeInput): string[] {
  const notes = [
    'Re-renders are sampled twice per interaction, not counted: a component that rendered forty times and one that rendered once look the same here, and a value that changed and changed back looks like no change at all.',
    'An arrow is evidence, not a mechanism. Each one says what was seen — a subscription observed on a fiber, a name that matched, a value echoed. Two things with no arrow between them may still have caused one another without leaving any of that behind.',
  ];

  if (step.renders?.some((render) => render.bounded)) {
    notes.push(
      'A value on at least one component was too large or too circular to snapshot, so "nothing changed" on it is a statement about the cap rather than about the app. Those components are marked, and none of them is called a wasted render.',
    );
  }
  if ((step.state ?? []).some((delta) => delta.bounded)) {
    notes.push(
      'At least one store was snapshotted under a depth or width cap, so a change below the cut reads here as no change.',
    );
  }
  if (step.renders?.length && !input.stores?.length) {
    notes.push(
      'This recording has no state stores, so every re-render below hangs off the interaction itself. That is the absence of an observation, not evidence that the interaction re-rendered them directly.',
    );
  }
  return notes;
}

/** Bucket the nodes into layers, apply the per-layer budget, drop orphan edges. */
function assemble(
  step: CascadeStep,
  stepNumber: number,
  nodes: Map<EventRef, CascadeNode>,
  edges: CascadeEdge[],
  limits: CascadeLimits,
  notes: string[],
): Cascade {
  const depth = Math.max(0, ...[...nodes.values()].map((node) => node.layer));
  const layers: CascadeNode[][] = Array.from({ length: depth + 1 }, () => []);
  for (const node of nodes.values()) layers[node.layer].push(node);

  let dropped = 0;
  const kept = new Set<EventRef>();
  const trimmed = layers.map((layer) => {
    /*
     * A wasted render is the actionable finding and has, by definition, no
     * changes — so any ordering by "how much happened" drops exactly the rows
     * this is for, silently, on the busiest steps. `core/render/blame.ts` makes
     * the same call for the same reason. Ties break on the ref so two runs over
     * one recording draw the same picture; nothing here reads a clock.
     */
    const ordered = [...layer].sort(
      (a, b) =>
        Number(Boolean(b.wasted)) - Number(Boolean(a.wasted)) ||
        (a.ref < b.ref ? -1 : a.ref > b.ref ? 1 : 0),
    );
    const survivors = ordered.slice(0, Math.max(1, limits.maxPerLayer));
    dropped += ordered.length - survivors.length;
    for (const node of survivors) kept.add(node.ref);
    return survivors;
  });

  return {
    step: stepNumber,
    action: step.action,
    layers: trimmed,
    // An edge to a node the budget cut would draw an arrow into empty space.
    edges: edges.filter((edge) => kept.has(edge.from) && kept.has(edge.to)),
    notes: dropped
      ? [
          ...notes,
          `${dropped} node${dropped === 1 ? '' : 's'} did not fit the picture and ${dropped === 1 ? 'is' : 'are'} not drawn. Wasted renders are kept first, so what was cut is the least surprising of what happened.`,
        ]
      : notes,
    dropped,
  };
}

/**
 * Whether a step has anything to draw at all.
 *
 * Separate from `buildCascade` so a surface can decide whether to *offer* the
 * picture without building it for every step it lists. A step that did nothing
 * observable is a real and common answer — a click on a link that navigated,
 * with no store, no request and no re-render seen — and offering a graph of it
 * is worse than not offering one.
 */
export function hasCascade(step: CascadeStep): boolean {
  return Boolean(
    step.renders?.length || step.state?.length || step.networkCalls?.length || step.consoleLogs?.length,
  );
}
