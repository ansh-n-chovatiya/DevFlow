/**
 * Turning what the adapters recorded into the flow's `vue` / `svelte` / `rsc`.
 *
 * `buildFlowReact` in `core/react/attribution.ts` is the same function for
 * React, and this is deliberately not a generalisation of it. Its pruning walks
 * `ElementReactRef` — `chain`, plus the `owner` and `within` that React's four
 * preference tiers decide — and none of those three exist here. Widening it to
 * take a chain-extractor would make one function serve two shapes by taking a
 * parameter that says which, which is the pattern `positions.ts` refuses for
 * the line base and for the same reason: the call site that passes the wrong one
 * is silently, permanently wrong.
 *
 * What *is* shared is the rule, not the code: a component is kept only if a step
 * still references it. A flow that dropped steps must not ship a table
 * describing components no remaining step mentions — that is a token cost with
 * no reader, and it is how a "pruned" export ends up larger than the thing it
 * pruned.
 */

import type { ComponentSource, ElementFrameworkRef, FlowComponents, Step } from '../../shared/types.js';
import type { Framework, FrameworkPresence } from './adapter.js';

/** Every framework chain the given steps reference, flattened. */
function chainsOf(steps: Step[]): ElementFrameworkRef[] {
  const out: ElementFrameworkRef[] = [];
  for (const step of steps) {
    for (const ref of step.element?.frameworks ?? []) out.push(ref);
  }
  return out;
}

/**
 * The tables a flow should carry, keyed by framework.
 *
 * A framework appears only when it was detected *and* at least one surviving
 * step names one of its components. Detected-but-unreferenced is the case a
 * page that mounted Vue somewhere the user never clicked produces, and an empty
 * `components: {}` under a `detected: true` reads as "Vue was here and we found
 * nothing", which is a stronger claim than the recording can make.
 */
export function buildFlowFrameworks(
  steps: Step[],
  meta: FrameworkPresence[] | null,
  tables: Partial<Record<Framework, Record<string, ComponentSource>>>,
): Partial<Record<Framework, FlowComponents>> {
  const out: Partial<Record<Framework, FlowComponents>> = {};
  if (!meta) return out;

  const referenced = new Map<Framework, Set<string>>();
  for (const ref of chainsOf(steps)) {
    const held = referenced.get(ref.framework) ?? new Set<string>();
    for (const id of ref.chain) held.add(id);
    referenced.set(ref.framework, held);
  }

  for (const presence of meta) {
    if (!presence.detected) continue;

    const ids = referenced.get(presence.framework);
    if (!ids || ids.size === 0) continue;

    const table = tables[presence.framework] ?? {};
    const components: Record<string, ComponentSource> = {};
    for (const id of ids) {
      const source = table[id];
      if (source) components[id] = source;
    }
    if (Object.keys(components).length === 0) continue;

    out[presence.framework] = {
      detected: true,
      ...(presence.version === undefined ? {} : { version: presence.version }),
      ...(presence.build === undefined ? {} : { build: presence.build }),
      components,
    };
  }
  return out;
}
