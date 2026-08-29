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
 * Adds anything new. Never downgrades an entry that already carries an answer —
 * a later click on the same component learns nothing about where it lives.
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
    if (table[component.id]) continue;

    if (Object.keys(table).length >= limit) {
      if (!table[CAPPED_ID]) {
        table[CAPPED_ID] = {
          name: 'FlowSnap',
          status: 'skipped',
          detail: `More than ${limit} distinct components were seen in this flow; later ones were not recorded.`,
        };
        changed = true;
      }
      break;
    }

    if (component.debugSource?.source && !isPlaceholderId(component.id)) {
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
