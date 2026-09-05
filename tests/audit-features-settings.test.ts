/**
 * The settings table against the things derived from it.
 *
 * `tests/settings-defaults.test.ts` holds every default against
 * `shared/constants.ts`, which is the drift that costs a *value*. This holds
 * the two things that cost a whole answer instead: an enum whose options no
 * longer cover the type they name, and a range a default has fallen outside of.
 * Neither has a compiler behind it — `Settings['export.format']` is whatever
 * the options happen to say, so a format the dialog draws and the table has
 * never heard of typechecks perfectly and simply cannot be chosen.
 */

import { describe, expect, it } from 'vitest';
import { EXTENSION, type ExportFormat } from '../src/features/export/formats.js';
import { FIELDS, fieldFor } from '../src/features/settings/fields.js';
import { resolveField } from '../src/features/settings/resolve.js';

describe('the default export format can name every format there is', () => {
  const field = fieldFor('export.format');

  /**
   * The export dialog offers five formats; this enum offered three, so somebody
   * who exports a Playwright spec every time could pick it once per export and
   * never once for good — and a stored `playwright` resolved back to `zip`,
   * silently, because a value outside an enum's options falls back to the
   * default.
   */
  it('offers exactly the formats `ExportFormat` has', () => {
    expect(field?.type).toBe('enum');
    if (field?.type !== 'enum') return;

    // `EXTENSION` is a `Record<ExportFormat, string>`, so its keys are the union
    // — read from there rather than retyped, which is the only way this test
    // notices a sixth format rather than agreeing with a stale list.
    expect([...field.options].sort()).toEqual((Object.keys(EXTENSION) as ExportFormat[]).sort());
  });

  it('keeps every one of them through the clamp', () => {
    if (field?.type !== 'enum') return;
    for (const option of field.options) {
      expect(resolveField(field, option), option).toBe(option);
    }
  });
});

/**
 * `resolve()` clamps a number to `[min, max]`, so a default outside that range
 * is a default the extension can never actually be running under: the Settings
 * screen would show it, `resolve` would move it, and the two would disagree
 * about what is in force with nothing going red.
 */
describe('every field is internally consistent', () => {
  it.each(FIELDS.map((field) => [field.key, field] as const))(
    '%s holds a default its own clamp accepts',
    (_key, field) => {
      expect(resolveField(field, field.default)).toEqual(field.default);
    },
  );

  it('has no key twice', () => {
    const keys = FIELDS.map((field) => field.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
