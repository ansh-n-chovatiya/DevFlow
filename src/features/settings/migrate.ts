/**
 * The one settings shape that is not this one, read once and turned into this
 * one.
 *
 * The sibling extension stored a single JSON blob — editor, custom template,
 * project root, a source-map switch and a `hidden` object — under one key in
 * `sync`, and pushed the same blob through `managed`. This build stores flat
 * dotted keys, sparsely, and derives everything from `FIELDS`. Both shapes are
 * coherent; only one of them has the derivation guarantees, the generated
 * defaults file and the validator the MCP server imports, so this one wins.
 *
 * What that costs, if nothing is done about it, is precise and silent: somebody
 * who had been using the other extension opens this one and finds their editor
 * back on the default and their project root empty, with the values still sitting
 * in `sync` under a key nothing reads any more. Nothing throws. Nothing is
 * logged. The first they know is a source link that opens the wrong machine's
 * file, or no link at all.
 *
 * So the blob is read once and mapped. The mapping is *total* — every field the
 * old shape had has somewhere to go, including the one that stopped existing
 * two versions before the merge — and it is *sparse*, because a migration that
 * materialised the values it agreed with would freeze today's defaults into
 * every migrated profile forever, which is the failure the whole override model
 * exists against.
 *
 * There is precedent for this in the file the blob came from: `coerce()` there
 * already upgrades a pre-2.0 `hideFrameworkComponents` boolean into per-category
 * flags. This is the same move one shape further on, and it keeps that upgrade
 * rather than making somebody who never opened the old version's settings screen
 * lose the choice twice.
 *
 * Pure — no `chrome.*`, no DOM. `index.ts` reads the area and writes the result.
 */

import {
  fieldFor,
  hiddenKeyFor,
  HIDDEN_CATEGORIES,
  type Overrides,
  type SettingKey,
} from './fields.js';
import { isModified, resolveField } from './resolve.js';

/**
 * The key the blob is under.
 *
 * The single occurrence of the other product's storage prefix that survives the
 * merge, and it survives here because a migration cannot name a key without
 * naming it. Everything else this prefix used to reach is gone; see
 * docs/CONTRACTS.md §4.5, which greps for exactly this string.
 */
export const LEGACY_KEY = 'rst:settings';

/** The blob's string fields, and the key each becomes. Names, not values. */
const STRINGS: readonly (readonly [string, SettingKey])[] = [
  ['editor', 'editor'],
  ['customEditorTemplate', 'customEditorTemplate'],
  ['projectRoot', 'projectRoot'],
];

/**
 * A legacy blob as sparse overrides in this build's shape.
 *
 * Every value goes through `resolveField` on the way, for the same reason
 * storage does: a blob is as capable of holding an editor this build has never
 * heard of as a hand-edited profile is, and a migration is not a second
 * validator. Anything that resolves back to the shipped default is then dropped,
 * so a user who had changed nothing arrives with an empty override object rather
 * than with five booleans pinned at today's answer.
 *
 * Order matters in exactly one place. `hideFrameworkComponents` is the pre-2.0
 * single switch and `hidden` is what replaced it; a blob written during the
 * changeover can carry both, and the newer one is the one the user last saw on
 * screen. So the categories are applied after the boolean, and win.
 */
export function legacyOverrides(blob: unknown): Overrides {
  if (!blob || typeof blob !== 'object') return {};
  const raw = blob as Record<string, unknown>;
  const out: Record<string, unknown> = {};

  const put = (key: SettingKey, value: unknown): void => {
    const field = fieldFor(key);
    if (!field) return;
    const resolved = resolveField(field, value);
    if (isModified(key, resolved)) out[key] = resolved;
    else delete out[key];
  };

  for (const [from, to] of STRINGS) if (typeof raw[from] === 'string') put(to, raw[from]);

  if (typeof raw.useSourceMaps === 'boolean') put('react.useSourceMaps', raw.useSourceMaps);

  if (typeof raw.hideFrameworkComponents === 'boolean') {
    for (const category of HIDDEN_CATEGORIES) {
      const key = hiddenKeyFor(category);
      if (key) put(key, raw.hideFrameworkComponents);
    }
  }

  const hidden = raw.hidden;
  if (hidden && typeof hidden === 'object') {
    const stored = hidden as Record<string, unknown>;
    for (const category of HIDDEN_CATEGORIES) {
      const key = hiddenKeyFor(category);
      if (key && typeof stored[category] === 'boolean') put(key, stored[category]);
    }
  }

  return out;
}
