/**
 * Settings as a file: the serialiser, the parser, and the import plan.
 *
 * The settings file is not a second mechanism. The sparse override store had
 * already decided it, without saying the word "file":
 *
 * > Storage holds overrides only, never the resolved object. Sparse.
 *
 * A sparse override object with clamped, defaulted resolution *is* a
 * `settings.json`. So there is no second mechanism here — no second validator,
 * no second notion of what a default is, no second serialisation of a value.
 * Everything below is `resolve()`, `modifiedOverrides()` and `passthrough()`
 * arranged into a document and back again.
 *
 * Pure: no `chrome.*`, no DOM, no clock. Which is what lets the round-trip
 * claims — export, import, export again, byte-identical — be tested as
 * arithmetic rather than as a sequence of clicks.
 *
 * ## Three rules the shape of this file comes from
 *
 * **The file holds the *resolved* override, not the stored one.** A sync area
 * can hold `"800"` where a number belongs, written by a hand-edit or a build
 * that has since been downgraded. Writing that string into the file would mean
 * export → import → export was not byte-identical, because the import resolves
 * it to `800` on the way past. Exporting what `resolve()` sees closes that, and
 * it is also the honest answer: the file describes the configuration that is in
 * force, which is the thing a colleague asked for.
 *
 * **Unknown keys are preserved, ignored and flagged.** Dropping them means a
 * file that round-trips through an older FlowSnap comes back with the newer
 * version's settings silently deleted. They cost a few unused bytes; `resolve`
 * never sees them, `passthrough` carries them, and the import diff lists them
 * separately with the reason.
 *
 * **`$schema` is checked to produce a good message, never to refuse a file.**
 * Refusing on version is how you strand a user whose other machine updated
 * first — the one person who most needs to move their settings between the two.
 */

import type { Result } from '../../shared/result.js';
import { showValue } from './stamp.js';
import {
  DEFAULTS,
  FIELDS,
  isSettingKey,
  modifiedOverrides,
  passthrough,
  resolve,
  resolveField,
  type Field,
  type Overrides,
  type SettingKey,
} from './index.js';

/**
 * The format marker. Version `1` is "flat dotted keys, sparse, values as
 * `resolve` returns them" — the specified shape, and the only one there has
 * ever been.
 */
export const SCHEMA = 'flowsnap/settings-1';

/** The one key in a settings file that is not a setting. */
export const SCHEMA_KEY = '$schema';

/**
 * No date, no machine name, no version of the extension that wrote it.
 *
 * Two exports of the same configuration are byte-identical and can be
 * diffed. A timestamp inside the file makes every export differ from every
 * other one, which turns "did anything actually change" — the question the file
 * exists to answer — back into a question you have to read sixty lines to
 * answer.
 */
export const EXPORT_FILENAME = 'flowsnap-settings.json';

// ── Writing ──────────────────────────────────────────────────────────────────

/**
 * An override object as a settings file: `$schema` first, then every key sorted.
 *
 * Sorted rather than in table order, and for a different reason than the
 * generated default file has: this one is diffed against *other people's*
 * files, which were written by other versions with other table orders. Sorting
 * is the only order two builds can agree on without agreeing on the table.
 */
export function serialise(overrides: Overrides): string {
  const body: Record<string, unknown> = { [SCHEMA_KEY]: SCHEMA };
  for (const key of Object.keys(overrides).sort()) body[key] = overrides[key];
  return `${JSON.stringify(body, null, 2)}\n`;
}

/**
 * What an export contains, from the raw sync area.
 *
 * The sparse override object, for the reason that keeps storage
 * sparse: a file that pins all seventy-three values freezes today's defaults into
 * whoever imports it, forever, and the mistake is invisible until the release
 * where a default improves and they do not get it.
 */
export function exportable(area: Overrides): Overrides {
  return { ...modifiedOverrides(resolve(area)), ...passthrough(area) };
}

/**
 * The shipped defaults, as the left-hand pane renders them.
 *
 * Byte-identical to `public/settings.default.json`, which
 * `scripts/build-settings.mjs` writes from the same `DEFAULTS` — and
 * `tests/settings-file.test.ts` compares the two, so the pane cannot come to
 * show something the shipped file does not say. Built here rather than fetched
 * because the fetch has a failure mode (a blocked extension URL) whose only
 * honest fallback is this function anyway, and a fallback that is never
 * exercised is a fallback nobody has read.
 *
 * No `$schema`: it is a template of every default, not a configuration, and a
 * `$schema` in a read-only pane is a line the user cannot act on.
 */
export function defaultsJson(): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(DEFAULTS).sort()) sorted[key] = DEFAULTS[key as SettingKey];
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

// ── Reading ──────────────────────────────────────────────────────────────────

/** Why a file could not be read, with the line to look at when there is one. */
export interface FileProblem {
  readonly message: string;
  /** 1-based, or `null` when the failure is not about a position in the text. */
  readonly line: number | null;
}

export interface ParsedFile {
  /** Every key except `$schema`, verbatim. Nothing is resolved yet. */
  readonly overrides: Overrides;
  /** What the file said it was, or `null` when it did not say. */
  readonly schema: string | null;
}

/**
 * Turn a `JSON.parse` failure into a line and a column.
 *
 * V8 has three message shapes and this build of Chrome can produce any of them:
 *
 *   Expected ',' or '}' after property value in JSON at position 68 (line 4 column 3)
 *   Unexpected token } in JSON at position 42
 *   Unexpected token ',', ..."b": ,\n}" is not valid JSON
 *
 * The first two say where; the third does not, and no amount of reading its
 * snippet reliably recovers it. So: take the line and column when the message
 * carries them, work them out from the position when it carries that, and
 * otherwise say what is wrong without pretending to know where.
 *
 * Which is worth the trouble because of who is reading it. The user is looking
 * at their own document in the pane beside this message; "line 4" is a place
 * they can put a caret, and "position 68" is a number they would have to count
 * to.
 */
function locate(text: string, error: unknown): FileProblem {
  const raw = error instanceof Error ? error.message : String(error);

  /*
   * The part that says what is actually wrong, with the engine's own attempt at
   * saying *where* removed — both the `in JSON at position …` tail and the
   * `..."snippet" is not valid JSON` one, which quotes the user's text back at
   * them mangled by escaping.
   */
  const what = raw
    .replace(/\s*in JSON at position[\s\S]*$/, '')
    .replace(/,?\s*\.\.\.[\s\S]*is not valid JSON$/, '')
    .replace(/^JSON\.parse:\s*/, '')
    .trim();

  const stated = /\(line (\d+) column (\d+)\)/.exec(raw);
  if (stated) {
    return {
      message: `Line ${stated[1]}, column ${stated[2]}: ${lower(what)}.`,
      line: Number(stated[1]),
    };
  }

  const position = /position (\d+)/.exec(raw);
  if (!position) return { message: `Not valid JSON. ${what}.`, line: null };

  const at = Math.min(Number(position[1]), text.length);
  const before = text.slice(0, at);
  const line = before.split('\n').length;
  const column = at - (before.lastIndexOf('\n') + 1) + 1;

  return { message: `Line ${line}, column ${column}: ${lower(what)}.`, line };
}

/** Lowercased unless it opens with a quoted character, which `Expected ','` does. */
function lower(what: string): string {
  return /^[A-Z][a-z]/.test(what) ? what.charAt(0).toLowerCase() + what.slice(1) : what;
}

/**
 * Parse and validate — step 2 of the five.
 *
 * Nothing is resolved and nothing is applied here. The one thing this refuses
 * is a document that is not an object of keys, because there is no reading of
 * an array or a number that is a configuration; a *value* it does not like is
 * `resolve`'s business, and `resolve` accepts everything.
 */
export function parseSettingsFile(text: string): Result<ParsedFile, FileProblem> {
  if (text.trim() === '') {
    return { ok: false, error: { message: 'The file is empty.', line: null } };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { ok: false, error: locate(text, error) };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = Array.isArray(parsed) ? 'a list' : `a ${parsed === null ? 'null' : typeof parsed}`;
    return {
      ok: false,
      error: {
        message: `A settings file is a JSON object of setting keys. This one is ${kind}.`,
        line: null,
      },
    };
  }

  const source = parsed as Record<string, unknown>;
  const schema = typeof source[SCHEMA_KEY] === 'string' ? source[SCHEMA_KEY] : null;

  const overrides: Record<string, unknown> = {};
  for (const key of Object.keys(source)) {
    if (key === SCHEMA_KEY) continue;
    overrides[key] = source[key];
  }

  return { ok: true, value: { overrides, schema } };
}

// ── The plan ─────────────────────────────────────────────────────────────────

/** One row of the diff: *setting · current → incoming*. */
export interface ImportChange {
  readonly key: string;
  readonly title: string;
  readonly from: string;
  readonly to: string;
  /** The file's value was outside what this version accepts, so it moved. */
  readonly clamped: boolean;
  /** The file does not carry this key, so it goes back to its default. */
  readonly reset: boolean;
}

/** A key this build has never heard of. Preserved, ignored, and listed. */
export interface UnknownKey {
  readonly key: string;
  readonly value: string;
  /** Whether writing it would actually change what is stored. */
  readonly changes: boolean;
}

export interface ImportPlan {
  /**
   * What the sync area's *known* half becomes, plus the file's unknown keys.
   * Handed to `replaceOverrides(plan.overrides, { keepUnknown: true })`.
   */
  readonly overrides: Overrides;
  readonly changes: readonly ImportChange[];
  readonly unknown: readonly UnknownKey[];
  /** How many of the file's values this version had to move. */
  readonly clamped: number;
  readonly schema: string | null;
  /** A good message about the version, or `null`. Never a refusal. */
  readonly schemaNote: string | null;
  /** Applying would change nothing at all — the empty diff. */
  readonly empty: boolean;
}

function same(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((entry, index) => entry === b[index])
    );
  }
  return a === b;
}

function schemaNoteFor(schema: string | null): string | null {
  if (schema === null || schema === SCHEMA) return null;
  return `This file says it is ${schema}; this FlowSnap writes ${SCHEMA}. It is being read anyway — anything in it this version does not recognise is listed below.`;
}

/**
 * Steps three and four of an import, as one pure function: resolve and clamp with the
 * same `resolve()` the form uses, then say exactly what applying would do.
 *
 * ## The file is the whole configuration
 *
 * A key the file does not carry goes **back to its default**, and says so in
 * the diff. the Undo "restores the previous override object wholesale", which
 * only means anything if applying replaced it wholesale. The alternative — a
 * merge — is the one thing a settings file must not be: "send me your settings
 * file" would hand somebody their colleague's configuration overlaid on
 * whatever they had already changed, which is a third configuration that exists
 * on nobody's machine and that neither of them can reproduce.
 *
 * The unknown half is the exception, and it is merged rather than replaced —
 * see `replaceOverrides`. A key from a newer FlowSnap that synced onto this
 * machine did not come from this file and must not be deleted by it.
 */
export function planImport(current: Overrides, parsed: ParsedFile): ImportPlan {
  const now = resolve(current);
  const next = resolve(parsed.overrides);

  const changes: ImportChange[] = [];
  let clamped = 0;

  // Table order, not file order: two files that set the same six settings
  // produce the same six rows in the same places, whatever order they were
  // written in.
  for (const field of FIELDS as readonly Field[]) {
    const key = field.key as SettingKey;
    const present = Object.hasOwn(parsed.overrides, field.key);
    const moved = present && !same(resolveField(field, parsed.overrides[field.key]), parsed.overrides[field.key]);
    if (moved) clamped += 1;

    if (same(now[key], next[key])) continue;

    changes.push({
      key: field.key,
      title: field.title,
      from: showValue(now[key]),
      to: showValue(next[key]),
      clamped: moved,
      reset: !present,
    });
  }

  const incomingUnknown = passthrough(parsed.overrides);
  const unknown: UnknownKey[] = Object.keys(incomingUnknown)
    .sort()
    .map((key) => ({
      key,
      value: showValue(incomingUnknown[key]),
      changes: !same(current[key], incomingUnknown[key]),
    }));

  return {
    overrides: { ...modifiedOverrides(next), ...incomingUnknown },
    changes,
    unknown,
    clamped,
    schema: parsed.schema,
    schemaNote: schemaNoteFor(parsed.schema),
    empty: changes.length === 0 && !unknown.some((entry) => entry.changes),
  };
}

// ── The JSON pane's gutter ───────────────────────────────────────────────────

/**
 * Which lines of a settings document name a key this version does not have.
 *
 * The JSON pane marks them with a warning gutter and the note *not a
 * setting in this version*. Line-based rather than key-based because the gutter
 * is beside the text the user is editing, and a warning that cannot say which
 * line it is about is a warning they have to go and find.
 *
 * Deliberately a scan of the text rather than of the parsed object: the pane is
 * editable, so it is asked this on every keystroke, including the keystrokes in
 * the middle of a key where the document does not parse at all. A regex over
 * the lines answers then too, which is when the gutter is most useful.
 */
export function unknownLines(text: string): readonly number[] {
  const out: number[] = [];

  text.split('\n').forEach((line, index) => {
    const found = /^\s*"((?:[^"\\]|\\.)*)"\s*:/.exec(line);
    if (!found) return;
    const key = found[1];
    if (key === SCHEMA_KEY || isSettingKey(key)) return;
    out.push(index + 1);
  });

  return out;
}
