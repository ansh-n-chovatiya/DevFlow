/**
 * Folding newly seen components into a flow's component table.
 *
 * Pure, and separate from the worker that calls it, because the merge rules are
 * where this feature is easiest to get quietly wrong: overwriting an answer with
 * a blank, rewriting an identical table on every step of a long recording, or
 * dropping components past the cap without saying so.
 */

import { MAX_COMPONENTS_PER_FLOW } from '../../shared/constants.js';
import type { CapturedComponent } from '../../shared/messages.js';
import type { ComponentNeedle, ComponentSource } from '../../shared/types.js';
import { isDependencyPath } from './classify.js';
import { UNSETTLED_LAZY_NAME, isPlaceholderId } from './id.js';

/** Id under which the table records that it stopped accepting new components. */
export const CAPPED_ID = '__capped__';

/** Does this look like a path on the machine rather than one inside a repo? */
export function isAbsolutePath(path: string): boolean {
  return path.startsWith('/') || /^[a-z]:[\\/]/i.test(path);
}

export interface MergeResult {
  table: Record<string, ComponentSource>;
  needles: Record<string, ComponentNeedle>;
  /**
   * False when nothing was added. The caller skips the write, so a flow that
   * clicks one button forty times does not rewrite an identical table each time.
   */
  changed: boolean;
}

function describeMissingNeedle(component: CapturedComponent): ComponentSource {
  if (component.needleRejection === 'native') {
    return {
      name: component.name,
      status: 'skipped',
      detail: 'A bound or native function — its source exists in no bundle to search.',
    };
  }
  if (component.needleRejection === 'too-short') {
    return {
      name: component.name,
      status: 'skipped',
      detail: 'The component source is too short to search for without false matches.',
    };
  }
  // Only a lazy component may be *called* a lazy component. Everything else
  // React exposes no function for — a raw context object, a `Suspense`
  // boundary — reached this sentence too and was explained to the reader as a
  // chunk that had not arrived, which is a fabricated cause for a real gap.
  if (component.name === UNSETTLED_LAZY_NAME) {
    return {
      name: component.name,
      status: 'not-found',
      detail: 'A lazy component that had not finished loading when it was interacted with.',
    };
  }

  return {
    name: component.name,
    status: 'skipped',
    detail: 'React exposed no function for this component, so there was nothing to search for.',
  };
}

/**
 * The one case where a second sighting of a component knows more than the first.
 *
 * The rule everywhere else is first-answer-wins, because a later click on the
 * same component learns nothing about where it lives. A build stamp is the
 * exception, and it is a real one rather than a hypothetical: the recorder's
 * `componentCache` is per page agent, so a content script re-injected after a
 * navigation captures a component it has already seen from scratch. If that
 * first capture happened before the stamp could be read — a chunk not yet
 * evaluated, a wrapper whose inner function had not been reached — the entry is
 * frozen at `via: 'debug-source'`, which names the *parent's* file, while the
 * panel picking the same component resolves it through the shared precedence to
 * the component's own. Two surfaces over one recording, disagreeing, which is
 * the exact contradiction that precedence exists to prevent.
 *
 * Exactly one upgrade, and nothing else: `debug-source` → `plugin`. A stamp may
 * not overwrite a `bundle-search` answer — that one was resolved against the
 * page's real map and carries a `column` the stamp does not — and nothing may
 * overwrite a stamp.
 */
function isStampUpgrade(existing: ComponentSource, component: CapturedComponent): boolean {
  return (
    existing.via === 'debug-source' && Boolean(component.stamp) && !isPlaceholderId(component.id)
  );
}

/**
 * Adds anything new, and upgrades a `debug-source` entry to a stamp — see
 * `isStampUpgrade`. Never downgrades an entry that already carries an answer.
 */
export function mergeComponents(
  components: CapturedComponent[],
  pageUrl: string,
  table: Record<string, ComponentSource>,
  needles: Record<string, ComponentNeedle>,
  limit = MAX_COMPONENTS_PER_FLOW,
): MergeResult {
  let changed = false;

  for (const component of components) {
    const existing = table[component.id];
    if (existing && !isStampUpgrade(existing, component)) continue;

    // The cap counts distinct components, and an upgrade adds none. Testing it
    // for a row already in the table would stop a full flow from ever correcting
    // one of its own entries, and — worse — would write the cap marker on the
    // strength of a component that is already counted in the number that tripped
    // it.
    if (!existing && Object.keys(table).length >= limit) {
      if (!table[CAPPED_ID]) {
        // `name` is not a component name here, and it must not read as one.
        //
        // The marker rides in the component table because that is where the
        // fact belongs — `countComponents` and `pruneComponents` both special-
        // case it, and the markdown export prints its `detail` as a note under
        // the table rather than as a row. But nothing stops it reaching a
        // surface that renders `ComponentSource.name` verbatim: the shared
        // result card puts that string in an `<h3>`, and the JSON export ships
        // it to whoever reads the flow. So the name says what the row is.
        table[CAPPED_ID] = {
          name: 'Component cap',
          status: 'skipped',
          detail: `More than ${limit} distinct components were seen in this flow; later ones were not recorded.`,
        };
        changed = true;
      }
      break;
    }

    if (component.stamp && !isPlaceholderId(component.id)) {
      // The build recorded where this component was defined.
      //
      // First, and not because it is the newest path. `_debugSource` is where
      // the JSX element was *written* — a position in the parent's file — and a
      // stamp is where the component was *defined*, which is what
      // `ComponentSource` has always claimed to be. The stamp is the better
      // match for the contract and `debug-source` is the compromise.
      //
      // The `isPlaceholderId` guard is kept for exactly the reason it exists
      // below: the hazard is one row winning under an id every unnamed
      // component in the flow shares, and where the location came from does not
      // change it. A confidently wrong file is worse than no file whether a
      // build stamped it or React did.
      //
      // `dependency` is set here and on the `debug-source` branch below for the
      // same reason `absolutePath` always was: `src/ui/locator/locate.ts` sets
      // both from identical input, and `pickOwner`, the review view's
      // `node_modules` tag and `classifyComponent` all read the flag rather than
      // re-testing the path. Without it a recording could name a `node_modules`
      // component as a step's owner while the panel, over the same component,
      // tags it as somebody else's code. The `debug-source` branch had that gap
      // from the beginning; it is fixed alongside rather than left as the older
      // half of one inconsistency.
      const { source, line } = component.stamp;
      table[component.id] = {
        name: component.name,
        status: 'resolved',
        via: 'plugin',
        source,
        line,
        ...(isAbsolutePath(source) ? { absolutePath: source } : {}),
        ...(isDependencyPath(source) ? { dependency: true } : {}),
      };
    } else if (component.debugSource?.source && !isPlaceholderId(component.id)) {
      // A development build recorded the JSX position itself. This is where the
      // element was *written* — a position in the parent's file — which is a
      // different fact from where the component is defined, but it is free and
      // it points at real code.
      //
      // Never under a placeholder id (`isPlaceholderId`). Those are shared by
      // every unnamed component in the flow, and the first row wins here, so one
      // `_debugSource` would be published as the location of all of them — a
      // confidently wrong file, which is the one outcome worse than no file.
      const { source, line, column } = component.debugSource;
      table[component.id] = {
        name: component.name,
        status: 'resolved',
        via: 'debug-source',
        source,
        line,
        column,
        ...(isAbsolutePath(source) ? { absolutePath: source } : {}),
        ...(isDependencyPath(source) ? { dependency: true } : {}),
      };
    } else if (component.needle) {
      table[component.id] = { name: component.name, status: 'pending' };
      needles[component.id] = { ...component.needle, pageUrl };
    } else {
      table[component.id] = describeMissingNeedle(component);
    }

    changed = true;
  }

  return { table, needles, changed };
}
