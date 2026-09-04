/**
 * Turning a `Resolution` into the two things a recording stores: an id, and a
 * `ComponentSource`.
 *
 * ## Why `ComponentSource` and not a new type
 *
 * A framework adapter answers exactly the question `ComponentSource` was built
 * to answer — *where was this component written, and if we cannot say, why* —
 * and it already carries every field needed: `name`, `status`, `via`, `source`,
 * `line`, `column`, `detail`. Introducing a parallel `FrameworkSource` beside it
 * would put two renderers on one question, which is the failure this repository
 * has already made twice and pays for in `src/core/mcp-bundle.ts`.
 *
 * Reusing it has a second payoff that is not aesthetic: every reader downstream
 * — `formatSource`, the viewer, the MCP server's 27 tools — renders a Vue or
 * Svelte component with no change at all, because it is the shape they already
 * read.
 *
 * ## The status mapping, and the one that is not `resolved`
 *
 * `declared` becomes `resolved` with `via: 'debug-source'`. That value is named
 * for React's `_debugSource`, and what it *means* is "the runtime told us,
 * rather than us searching for it" — which is exactly Svelte's `__svelte_meta`
 * and Vue's `__file`.
 *
 * `searchable` becomes `pending`, not `resolved`, and this is the honest half.
 * At the moment this runs, a searchable resolution is a needle and nothing
 * more: no bundle has been fetched, no map decoded. Calling it `resolved` would
 * put a component in the table with no path and a status claiming there is one.
 * `pending` is exactly what React's own table uses for the same state, and it
 * is the same resolver that clears it — `resolvePending` takes components,
 * needles and a script list and has never known anything about React.
 *
 * `absent` becomes `not-found` carrying the adapter's own sentence.
 */

import { componentId, nameOnlyId } from './id.js';
import type { Resolution } from './adapter.js';
import type { ComponentSource } from '../../shared/types.js';

/** Stands in for a name no runtime gave. Matches `id.ts`'s placeholder rules. */
const ANONYMOUS = 'Anonymous';

/**
 * A stable id for one resolution.
 *
 * `componentId` hashes a name against a second string that distinguishes
 * same-named components. For a `searchable` resolution that string is the
 * compiled source, which is exactly React's meaning. For a `declared` one there
 * is no source text and there is something better: the file and line the
 * runtime named, which is a *stronger* identity than compiled text because it
 * survives a rebuild that renamed everything.
 *
 * Ids from different frameworks never meet: each framework's components live in
 * its own table on the flow, so there is no namespace for them to collide in.
 */
export function resolutionId(resolution: Resolution): string {
  const name = resolution.name ?? ANONYMOUS;

  if (resolution.kind === 'declared') {
    return componentId(name, `${resolution.source}#${resolution.line ?? ''}`);
  }
  if (resolution.kind === 'searchable') {
    return componentId(name, resolution.fnSource);
  }
  return nameOnlyId(name);
}

export function resolutionSource(resolution: Resolution): ComponentSource {
  const name = resolution.name ?? ANONYMOUS;

  if (resolution.kind === 'declared') {
    return {
      name,
      status: 'resolved',
      via: 'debug-source',
      source: resolution.source,
      ...(resolution.line === undefined ? {} : { line: resolution.line }),
      ...(resolution.column === undefined ? {} : { column: resolution.column }),
      ...(resolution.at === 'call-site'
        ? {
            detail:
              'This is where the component was used, not where it was defined — ' +
              'the runtime exposes the call site and not the declaration.',
          }
        : {}),
    };
  }

  if (resolution.kind === 'searchable') {
    return {
      name,
      status: 'pending',
      detail:
        'The runtime exposed this component as a function but did not say where ' +
        'it was written, so its compiled source is being searched for in the ' +
        "page's bundles. This is the status before that search has run.",
    };
  }

  return { name, status: 'not-found', detail: resolution.detail };
}
