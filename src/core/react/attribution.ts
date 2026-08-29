/**
 * Turning the resolver's component table into the thing a reader sees.
 *
 * Capture writes ids onto steps; the resolver fills a table keyed by those ids.
 * Neither of them knows what a flow *shows*. That is this module: which
 * component a step is attributed to, which entries the flow still needs, and how
 * one entry reads as a single line of text.
 *
 * It is pure and it is shared, because the markdown export, the JSON export, the
 * MCP payload and the viewer must all say the same thing about the same
 * component. A path rendered one way in the export and another in the viewer is
 * the bug this file exists to make impossible.
 */

import { urlPath } from '../flow/index.js';
import { pickEnclosing, pickOwner } from './owner.js';
import { CAPPED_ID } from './table.js';
import type { ComponentSource, FlowReact, Step } from '../../shared/types.js';

/**
 * Every component id the given steps still reference, in the order a reader
 * meets them: step by step, and outermost first within a step.
 *
 * Order matters because it is the order the table is rendered in, and a table
 * that follows the flow is one a reader can walk alongside the steps.
 */
export function referencedComponentIds(steps: Step[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];

  for (const step of steps) {
    for (const id of step.element?.react?.chain ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      order.push(id);
    }
  }

  return order;
}

/**
 * The table, cut down to what the surviving steps actually point at.
 *
 * Deleting steps in the review tab has to drop their components too, or a flow
 * ships the source paths of code the reader can no longer see a step for. The
 * cap marker is kept whatever happens: "some components were not recorded" is a
 * fact about the flow, not about any one step.
 */
export function pruneComponents(
  steps: Step[],
  components: Record<string, ComponentSource>,
): Record<string, ComponentSource> {
  const pruned: Record<string, ComponentSource> = {};

  for (const id of referencedComponentIds(steps)) {
    const component = components[id];
    if (component) pruned[id] = component;
  }

  if (components[CAPPED_ID]) pruned[CAPPED_ID] = components[CAPPED_ID];

  return pruned;
}

/**
 * The step without its React reference, or the step itself when it had none.
 *
 * One function because three places need exactly this — the send prune, the JSON
 * export and the purge in the worker — and each one is stripping data a user
 * asked not to be kept. A copy, never a mutation: the step is shared with the
 * stored recording, and deleting through it would strip the recording too.
 */
export function stripReactRef(step: Step): Step {
  if (!step.element?.react) return step;

  const element = { ...step.element };
  delete element.react;
  return { ...step, element };
}

/**
 * The flow's React block, or `undefined` when there is nothing to say.
 *
 * Absent rather than empty: a flow recorded on a page that is not React must
 * carry no `react` key at all, and one whose every component was deleted along
 * with its steps is indistinguishable from it.
 */
export function buildFlowReact(
  steps: Step[],
  meta: Omit<FlowReact, 'components'> | null,
  components: Record<string, ComponentSource>,
): FlowReact | undefined {
  if (!meta?.detected) return undefined;

  const pruned = pruneComponents(steps, components);
  if (Object.keys(pruned).length === 0) return undefined;

  return { ...meta, components: pruned };
}

/**
 * The feature component the step's owner sits inside, with its id, or null.
 *
 * Reads the stamp when there is one, for the same reason `stepOwner` does: a
 * flow that has already been exported made this decision, and re-deriving it
 * against a table that has since gained a resolved path would let two halves of
 * one document disagree.
 */
export function stepEnclosing(
  step: Step,
  components: Record<string, ComponentSource>,
): { id: string; component: ComponentSource } | null {
  const react = step.element?.react;
  if (!react?.chain.length) return null;

  const owner = stepOwner(step, components);
  if (!owner) return null;

  const id = react.within ?? pickEnclosing(react.chain, components, owner.id);
  const component = id ? components[id] : undefined;

  return id && component ? { id, component } : null;
}

/** The component a step is attributed to, with its id, or null. */
export function stepOwner(
  step: Step,
  components: Record<string, ComponentSource>,
): { id: string; component: ComponentSource } | null {
  const react = step.element?.react;
  if (!react?.chain.length) return null;

  // A stamped owner wins: a flow that has been through an export already made
  // this decision, and making it again risks a different answer.
  const id = react.owner ?? pickOwner(react.chain, components);
  const component = id ? components[id] : undefined;

  return id && component ? { id, component } : null;
}

/**
 * The steps, each carrying the id of the component it is attributed to.
 *
 * Run once at the edge — the wire payload and the JSON export — so that a reader
 * with no copy of the preference rules still knows which component the flow
 * means. Steps with nothing to attribute come back untouched, so a flow from a
 * page that is not React is the same array of objects it went in as.
 */
export function attributeSteps(steps: Step[], components: Record<string, ComponentSource>): Step[] {
  return steps.map((step) => {
    const element = step.element;
    const react = element?.react;
    if (!element || !react) return step;

    const owner = pickOwner(react.chain, components);
    if (!owner) return step;

    const within = pickEnclosing(react.chain, components, owner);

    return {
      ...step,
      element: { ...element, react: { ...react, owner, ...(within ? { within } : {}) } },
    };
  });
}

/**
 * One component's location as a single string, or null when it has none.
 *
 * A resolved entry reads `src/components/Cart.tsx:34`. One found in a bundle
 * that ships no map still has somewhere to point — the compiled position — and
 * saying so beats saying nothing, because a reader can at least search for it.
 */
export function formatSource(component: ComponentSource): string | null {
  if (component.source) {
    return component.line ? `${component.source}:${component.line}` : component.source;
  }

  if (component.compiled) {
    const { url, line, column } = component.compiled;
    return `${urlPath(url) || url}:${line}:${column}`;
  }

  return null;
}

/** How a flow's components came out, for a one-line summary in a header. */
export interface ComponentCounts {
  total: number;
  resolved: number;
  ambiguous: number;
  /** Everything else — searched and not found, no map, still pending. */
  unresolved: number;
}

export function countComponents(components: Record<string, ComponentSource>): ComponentCounts {
  const counts: ComponentCounts = { total: 0, resolved: 0, ambiguous: 0, unresolved: 0 };

  for (const [id, component] of Object.entries(components)) {
    // The cap marker is a note about the table, not a component in it.
    if (id === CAPPED_ID) continue;

    counts.total += 1;
    if (component.status === 'resolved') counts.resolved += 1;
    else if (component.status === 'ambiguous') counts.ambiguous += 1;
    else counts.unresolved += 1;
  }

  return counts;
}

/** `8 components · 6 resolved · 1 ambiguous`, or '' when there are none. */
export function summarizeComponents(components: Record<string, ComponentSource>): string {
  const counts = countComponents(components);
  if (counts.total === 0) return '';

  const parts = [`${counts.total} component${counts.total === 1 ? '' : 's'}`];
  if (counts.resolved) parts.push(`${counts.resolved} resolved`);
  if (counts.ambiguous) parts.push(`${counts.ambiguous} ambiguous`);

  return parts.join(' · ');
}
