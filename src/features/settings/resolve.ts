/**
 * The half of the settings mechanism that is pure.
 *
 * `resolve()` and the four functions around it have no `chrome.*` and no DOM,
 * and this file is where that is *structural* rather than merely true. It was
 * split out of `index.ts` in Phase 4 for one reason: the MCP server needs
 * `resolve`.
 *
 * The server has two channels and one precedence rule — **environment
 * variable > `config.json` > per-flow > default** — and a chain of overrides
 * resolved against a field table is exactly what `resolve()` already is. The
 * alternative was a second validator written in JavaScript on the other side of
 * the wire, which is the thing every phase of this plan has been told not to
 * build: *`resolve()` is the only validator.* A second one would clamp a
 * hand-edited `config.json` by rules that drift from the ones the Settings
 * screen enforces, and the two would disagree about what the user is allowed to
 * ask for without either of them being wrong on its own.
 *
 * So the server imports it, through `core/mcp-bundle.ts`, the same way it
 * imports the markdown renderer and for the same reason. `index.ts` re-exports
 * everything here, so nothing that used to import from there had to change.
 *
 * **Nothing in this file may touch storage.** The moment it does, `core.js`
 * carries `chrome.storage` into a Node process, and the import fails at a
 * distance in a package that has no way to test for it.
 */

import {
  DEFAULTS,
  FIELDS,
  isSettingKey,
  type Field,
  type Overrides,
  type SettingKey,
  type Settings,
} from './fields.js';

// ── resolve ──────────────────────────────────────────────────────────────────

/** Finite numbers only: `NaN`, `Infinity` and `'12px'` are all "no answer". */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  // A string is what a hand-edited settings file holds, and `"800"` plainly
  // means 800. `''` coerces to 0 in JS, which it does not mean here.
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function clampNumber(field: Extract<Field, { type: 'number' }>, value: unknown): number {
  const parsed = asNumber(value);
  if (parsed === null) return field.default;
  const rounded = field.fractional ? parsed : Math.round(parsed);
  return Math.min(field.max, Math.max(field.min, rounded));
}

/**
 * One override, made safe.
 *
 * Out of range clamps; the wrong type, `null`, or a value outside an enum's
 * options falls back to the default. Falling back rather than clamping is
 * deliberate for the non-numeric types: there is no nearest legal string, and
 * guessing one would put a value on screen that the user never chose.
 */
export function resolveField(field: Field, value: unknown): unknown {
  switch (field.type) {
    case 'number':
      return clampNumber(field, value);

    case 'boolean':
      // Strict. `'false'` is a string, and treating it as `true` — which is what
      // any truthiness test does — is the single most expensive coercion bug
      // available to a settings file.
      return typeof value === 'boolean' ? value : field.default;

    case 'string': {
      if (typeof value !== 'string') return field.default;
      const trimmed = field.maxLength === undefined ? value : value.slice(0, field.maxLength);
      if (field.pattern && !field.pattern.test(trimmed)) return field.default;
      return trimmed;
    }

    case 'enum':
      return typeof value === 'string' && field.options.includes(value) ? value : field.default;

    case 'levels': {
      if (!Array.isArray(value)) return [...field.default];
      // Filtered and de-duplicated against `options`, so a level this build does
      // not have is dropped rather than passed to `console[level]`. An empty
      // result is a legal answer: it means "capture no console at all".
      const kept = field.options.filter((option) => value.includes(option));
      return kept;
    }
  }
}

/**
 * Every setting, resolved from a sparse set of overrides. Pure and total.
 *
 * Returns only keys this build knows about. A key from a newer version is not
 * lost — it is still in storage, and `passthrough()` returns it — but it is not
 * handed to the recorder, because nothing here can clamp a field it has no
 * description of.
 */
export function resolve(overrides: Overrides | null | undefined): Settings {
  const source = overrides ?? {};
  const out: Record<string, unknown> = {};

  for (const field of FIELDS) {
    out[field.key] = Object.hasOwn(source, field.key)
      ? resolveField(field, source[field.key])
      : DEFAULTS[field.key];
  }

  return out as Settings;
}

/**
 * The overrides `resolve` did not recognise, kept verbatim.
 *
 * A settings file written by a newer FlowSnap imports, is ignored by `resolve`,
 * and is still there when the same profile is exported again. This is the
 * function that makes the second half of that true.
 */
export function passthrough(overrides: Overrides | null | undefined): Overrides {
  const source = overrides ?? {};
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(source)) if (!isSettingKey(key)) out[key] = source[key];
  return out;
}

/** Whether a resolved value differs from the shipped default. The gutter marker. */
export function isModified(key: SettingKey, value: unknown): boolean {
  const shipped = DEFAULTS[key];
  if (Array.isArray(shipped)) {
    return !Array.isArray(value) || shipped.length !== value.length
      || shipped.some((entry, index) => entry !== (value as unknown[])[index]);
  }
  return shipped !== value;
}

/**
 * Every setting in `fields` whose resolved value differs from the shipped
 * default — the sparse override object, derived rather than stored.
 *
 * Takes a *resolved* `Settings` rather than the raw storage area on purpose.
 * Two callers need it and both need the same answer: the export, which must
 * describe the configuration that is actually in force, and the recording
 * stamp, which must describe what the recorder actually used. A stored value of
 * 9,000 against a maximum of 5,000 is clamped by `resolve` before either of
 * them sees it, and a file or a stamp reading 9,000 would describe a
 * configuration that has never existed.
 *
 * It is also what makes an export round-trip byte-identical: the file holds the
 * resolved answer, so importing it and exporting again cannot move a value.
 */
export function modifiedOverrides(
  settings: Settings,
  fields: readonly { readonly key: string }[] = FIELDS,
): Overrides {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.key as SettingKey;
    const value = settings[key];
    if (isModified(key, value)) out[key] = Array.isArray(value) ? [...value] : value;
  }
  return out;
}
