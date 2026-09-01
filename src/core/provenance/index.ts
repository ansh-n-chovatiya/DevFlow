/**
 * Where one value in a recording came from — and what that claim is worth.
 *
 * ## This finds; it does not trace
 *
 * The name of the feature is "provenance", and the honest description of the
 * mechanism is narrower than the name: **DevFlow did not watch the value move.**
 * It has four independent observations of one recording — the bodies the server
 * sent, the operations the stores took, the values components were handed, and
 * the text the page showed — and this looks for the same value in all four and
 * reports where it turned up, in the order data flows through an application.
 *
 * That is worth a great deal and it is not a data-flow trace, and the difference
 * has to survive contact with a reader. `£42.00` appearing in a response body,
 * in a store write and in a cell is overwhelmingly one value moving through an
 * app. `2` appearing in all four is a coincidence four times over. So every hit
 * says what was actually seen, a value short enough to collide says so, and a
 * layer the recording never captured is named as *unsearched* rather than
 * quietly contributing an absence — the same rule `FlowState` and `FlowRenders`
 * follow, because a missing layer and an empty layer read identically and a
 * reader who cannot tell them apart takes the wrong one.
 *
 * The v3.2.0 attempt at this item was unreachable dead code: a module nothing
 * called, behind a tool that was never wired. What is here is reached by
 * `get_value_provenance` and returns what it found, including nothing.
 *
 * ## Why the layers are ordered the way they are
 *
 * Response, then store, then render, then DOM — the direction a value travels
 * in a React application, so reading the answer top to bottom reads as the
 * journey. It is a presentation order and nothing more: nothing here concludes
 * that the response *caused* the render, and two hits in adjacent layers are two
 * sightings rather than a link. `get_causal_chain` is the tool that makes causal
 * claims, and it makes them out of evidence about events rather than about the
 * equality of two strings.
 *
 * Pure — no DOM, no Chrome, no clock, no randomness.
 */

import type { FlowPayload, Step } from '../../shared/types.js';

/** The four independent observations a recording carries about one value. */
export type ProvenanceLayer = 'response' | 'store' | 'render' | 'dom';

/** How much of what was found the value accounted for. */
export type ProvenanceMatch = 'exact' | 'within';

/** One place in one recording where the value was found. */
export interface ProvenanceHit {
  layer: ProvenanceLayer;
  /** The step this sighting belongs to, as the recording numbers steps. */
  step: number;
  /** Where in that layer: an endpoint and a pointer, a store, a component, a selector. */
  where: string;
  /** What was seen, in the words a reader can disagree with. */
  detail: string;
  match: ProvenanceMatch;
}

/** A layer the recording does not carry, and why it does not. */
export interface UnsearchedLayer {
  layer: ProvenanceLayer;
  reason: string;
}

export interface ProvenanceResult {
  /** The needle, exactly as it was searched for. */
  value: string;
  /** Hits, in layer order — see the header for why that order is not a claim. */
  hits: ProvenanceHit[];
  /** Hits found beyond the per-layer cap, by layer. */
  more: Partial<Record<ProvenanceLayer, number>>;
  unsearched: UnsearchedLayer[];
  /**
   * The value is short enough that an equal string is as likely to be a
   * coincidence as a sighting.
   */
  collides: boolean;
}

/**
 * Hits listed for one layer.
 *
 * Tier 3. A value that turns up in nine places in one layer has told the reader
 * what it is going to tell them by the third; the rest is the count.
 */
const HITS_PER_LAYER = 8;

/** Nodes walked in one parsed body, and how deep. A response is not a database. */
const WALK_NODES = 20_000;
const WALK_DEPTH = 12;

/**
 * Below this, an equal string is not evidence.
 *
 * `"1"`, `"ok"` and `"12"` occur in an ordinary recording by the dozen, in
 * every layer, with no relationship between the sightings at all. The search
 * still runs — refusing it outright would be deciding for the reader — and the
 * result says the value collides, so the listing is read as what it is.
 */
const COLLIDING_LENGTH = 4;

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** RFC 6901: `~` and `/` are the two characters a pointer segment must escape. */
function pointerSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * The first path inside a parsed value whose leaf is the needle, and how many
 * paths there were.
 *
 * The first rather than all of them, with the count beside it: a response that
 * carries one price in forty rows is one fact about the response, and forty
 * pointers is the same fact spelled at forty times the price. Bounded in nodes
 * and depth because a body is whatever the server sent.
 */
function findInValue(
  value: unknown,
  needle: string,
): { pointer: string; count: number } | null {
  let first: string | null = null;
  let count = 0;
  let nodes = 0;

  const walk = (node: unknown, pointer: string, depth: number): void => {
    if (nodes++ > WALK_NODES || depth > WALK_DEPTH) return;

    if (node !== null && typeof node === 'object') {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i], `${pointer}/${i}`, depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, `${pointer}/${pointerSegment(key)}`, depth + 1);
      }
      return;
    }

    // Primitives compared as text, so a needle typed by a person finds a number
    // the server sent. `null` is compared too — it is a value an app can show.
    if (String(node) !== needle) return;
    count++;
    if (first === null) first = pointer === '' ? '/' : pointer;
  };

  walk(value, '', 0);
  return first === null ? null : { pointer: first, count };
}

/** Parsed, or null — a body may be a schema summary, HTML, or cut at the cap. */
function parsed(body: string | null | undefined): unknown {
  if (typeof body !== 'string' || !body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function stepNumber(step: Step, index: number): number {
  return typeof step.stepNumber === 'number' ? step.stepNumber : index + 1;
}

/**
 * A run of the page's own text, cut to length and quoted.
 *
 * Its own function rather than `shown()` with the quotes sliced off, which is
 * what it was and what was wrong with it: `shown` puts its ellipsis *after* the
 * closing quote, so stripping the first and last characters of a truncated
 * string removes the ellipsis and leaves the cut text reading as the whole of
 * what the element said — a claim about the page made out of a formatting
 * mistake. Here the cut is inside the quotes, where a reader sees it.
 */
function quoted(text: string, cap: number): string {
  return text.length > cap ? `"${text.slice(0, cap)}…"` : `"${text}"`;
}

/** A short, quoted form of a found value, for a `detail` sentence. */
function shown(value: unknown, cap = 60): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? String(value);
  } catch {
    return '(unprintable)';
  }
  return encoded.length > cap ? `${encoded.slice(0, cap)}…` : encoded;
}

// ── The four searches ────────────────────────────────────────────────────────

function inResponses(steps: readonly Step[], needle: string, hits: ProvenanceHit[]): void {
  steps.forEach((step, index) => {
    for (const call of step.networkCalls ?? []) {
      const body = parsed(call.responseBody);
      const found = body === null ? null : findInValue(body, needle);
      if (found) {
        hits.push({
          layer: 'response',
          step: stepNumber(step, index),
          where: `${call.method} ${call.url}  ${found.pointer}`,
          detail:
            `The response carried it at ${found.pointer}` +
            `${found.count > 1 ? `, and at ${found.count - 1} other path${found.count === 2 ? '' : 's'}` : ''}` +
            `${call.status === null ? ' (the request failed before a response)' : ` (${call.status})`}.`,
          match: 'exact',
        });
        continue;
      }

      /*
       * A body that is not JSON, or one cut at the capture cap, still has text
       * in it — and a value found in a truncated body is a weaker sighting
       * rather than no sighting, so it is reported as `within` and the cut is
       * named. Skipped entirely when the body parsed: a JSON body that did not
       * hold the value at any path does not hold it in its punctuation either.
       */
      if (body !== null) continue;
      const raw = call.responseBody;
      if (typeof raw !== 'string' || !raw.includes(needle)) continue;
      hits.push({
        layer: 'response',
        step: stepNumber(step, index),
        where: `${call.method} ${call.url}`,
        detail:
          'The response body contains it as text — the body is not JSON' +
          `${call.responseBodyTruncated ? ', and was cut at the capture cap' : ''}, so there is no path to name.`,
        match: 'within',
      });
    }
  });
}

function inStores(steps: readonly Step[], needle: string, hits: ProvenanceHit[]): void {
  steps.forEach((step, index) => {
    for (const delta of step.state ?? []) {
      for (const op of delta.patch ?? []) {
        if (op.op === 'remove') continue;
        const found = findInValue(op.value, needle);
        if (!found) continue;
        // The operation's own path, then the path inside its value: together
        // they are the pointer into the store the reader would use.
        const pointer = found.pointer === '/' ? op.path : `${op.path}${found.pointer}`;
        hits.push({
          layer: 'store',
          step: stepNumber(step, index),
          where: `${delta.store}  ${pointer}`,
          detail:
            `The store was written with it: ${op.op} ${op.path} = ${shown(op.value)}` +
            `${delta.bounded ? '. The snapshot was cut at its caps, so this is a bounded view of the store' : ''}.`,
          match: 'exact',
        });
      }
    }
  });
}

function inRenders(steps: readonly Step[], needle: string, hits: ProvenanceHit[]): void {
  steps.forEach((step, index) => {
    for (const render of step.renders ?? []) {
      const kinds: [string, { key: string; before?: unknown; after?: unknown }[]][] = [
        ['prop', render.props ?? []],
        ['hook', render.hooks ?? []],
        ['context', render.contexts ?? []],
      ];

      for (const [kind, changes] of kinds) {
        for (const change of changes) {
          const after = findInValue(change.after, needle);
          const before = after ? null : findInValue(change.before, needle);
          if (!after && !before) continue;
          hits.push({
            layer: 'render',
            step: stepNumber(step, index),
            where: `${render.component}  ${kind} ${change.key}`,
            detail: after
              ? `The component was handed it: ${kind} "${change.key}" became ${shown(change.after)}.`
              : `The component held it before this step: ${kind} "${change.key}" was ${shown(change.before)} and changed.`,
            match: 'exact',
          });
        }
      }
    }
  });
}

function inDom(steps: readonly Step[], needle: string, hits: ProvenanceHit[]): void {
  const flat = collapse(needle);

  steps.forEach((step, index) => {
    const number = stepNumber(step, index);
    const where = step.element?.cssSelector ?? `step ${number}`;

    const text = collapse(step.element?.text ?? '');
    if (text && text.includes(flat)) {
      hits.push({
        layer: 'dom',
        step: number,
        where,
        detail:
          text === flat
            ? 'The element interacted with said exactly this.'
            : `The element interacted with said ${quoted(text, 80)}.`,
        match: text === flat ? 'exact' : 'within',
      });
    }

    if (typeof step.value === 'string' && collapse(step.value).includes(flat)) {
      hits.push({
        layer: 'dom',
        step: number,
        where,
        // Worth its own line: a value the *user typed* is where a value entered
        // the application, which is the end of the trace rather than a step in it.
        detail: 'The user typed it into this element — this is where it entered the app.',
        match: collapse(step.value) === flat ? 'exact' : 'within',
      });
    }

    const after = collapse(step.domDelta?.after ?? '');
    if (after && after.includes(flat)) {
      hits.push({
        layer: 'dom',
        step: number,
        where,
        detail: 'It was in the text around the element once the interaction had settled.',
        match: 'within',
      });
    }

    for (const change of step.domChanges?.changes ?? []) {
      if (!change.what || !collapse(change.what).includes(flat)) continue;
      hits.push({
        layer: 'dom',
        step: number,
        where: change.where,
        detail: `It appeared in the page: ${change.kind} — ${change.what}.`,
        match: 'within',
      });
    }
  });
}

// ── What the recording could not be asked ────────────────────────────────────

/**
 * Layers this recording carries nothing for.
 *
 * Named rather than left to read as "not found there", because those are
 * different answers and only one of them is about the application. A flow sent
 * without its network calls has no response layer at all, and a reader told
 * only that the value was not in a response concludes the server never sent it.
 */
function unsearchedLayers(flow: FlowPayload): UnsearchedLayer[] {
  const steps = flow.steps ?? [];
  const out: UnsearchedLayer[] = [];

  const omitted = new Set(flow.omitted ?? []);
  if (omitted.has('network') || !steps.some((step) => (step.networkCalls ?? []).length)) {
    out.push({
      layer: 'response',
      reason: omitted.has('network')
        ? 'This flow was sent without its network calls, so there are no response bodies to search.'
        : 'No step in this recording captured a network call.',
    });
  }

  if (!steps.some((step) => (step.state ?? []).length)) {
    out.push({
      layer: 'store',
      reason:
        flow.state?.read === false || !flow.state
          ? 'This recording did not read the app’s state — get_state_patch says whether capture was off or no store was recognised.'
          : 'No store moved during this recording, so there are no writes to search.',
    });
  }

  if (!steps.some((step) => (step.renders ?? []).length)) {
    out.push({
      layer: 'render',
      reason:
        flow.renders?.read === false || !flow.renders
          ? 'This recording did not sample renders, so no component’s props, state or contexts were read.'
          : 'No component re-rendered during this recording, so no changed value was captured.',
    });
  }

  /*
   * The DOM layer's own nothing, which was missing.
   *
   * The other three are named when the recording carries nothing for them, and
   * this one was left to read as "looked, found nothing" — which is the exact
   * failure the rest of this function exists to prevent, on the one layer a
   * reader is most likely to trust. It only bites on a recording with no steps
   * or with nothing but navigations, and those are recordings somebody is
   * asking about precisely because they are odd.
   */
  const sawDom = steps.some(
    (step) =>
      step.element ||
      step.domDelta ||
      (step.domChanges?.changes ?? []).length ||
      typeof step.value === 'string',
  );
  if (!sawDom) {
    out.push({
      layer: 'dom',
      reason:
        steps.length === 0
          ? 'This recording has no steps, so there is no page text to search.'
          : 'No step in this recording touched an element or recorded a change on the page.',
    });
  }

  return out;
}

// ── The search ───────────────────────────────────────────────────────────────

/** Layer order is presentation, not causation — see the header. */
const LAYER_ORDER: readonly ProvenanceLayer[] = ['response', 'store', 'render', 'dom'];

/**
 * Every place in one recording that carried this value.
 *
 * `value` is compared as text throughout, so a number a server sent and a
 * number a person typed into this tool find each other. Nothing is normalised
 * beyond collapsing runs of whitespace on the DOM side, where the page's own
 * indentation is not part of what it said.
 */
export function traceValue(flow: FlowPayload, value: string): ProvenanceResult {
  const needle = value.trim();
  const steps = flow.steps ?? [];

  const found: ProvenanceHit[] = [];
  if (needle) {
    inResponses(steps, needle, found);
    inStores(steps, needle, found);
    inRenders(steps, needle, found);
    inDom(steps, needle, found);
  }

  const hits: ProvenanceHit[] = [];
  const more: Partial<Record<ProvenanceLayer, number>> = {};

  for (const layer of LAYER_ORDER) {
    const inLayer = found.filter((hit) => hit.layer === layer);
    hits.push(...inLayer.slice(0, HITS_PER_LAYER));
    if (inLayer.length > HITS_PER_LAYER) more[layer] = inLayer.length - HITS_PER_LAYER;
  }

  return {
    value: needle,
    hits,
    more,
    unsearched: unsearchedLayers(flow),
    collides: needle.length > 0 && needle.length < COLLIDING_LENGTH,
  };
}

/**
 * What a step would trace, when the caller names a step rather than a value.
 *
 * The text of the element the step touched, or what the user typed into it —
 * which is the closest a recording comes to the "DOM node" this feature was
 * planned around. A recording has no node ids: an element is described, not
 * addressed, so the value it showed is the handle that exists.
 */
export function valueOfStep(step: Step): string {
  const text = collapse(step.element?.text ?? '');
  if (text) return text;
  const typed = typeof step.value === 'string' ? collapse(step.value) : '';
  if (typed) return typed;
  return collapse(step.element?.label ?? '');
}
