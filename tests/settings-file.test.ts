/**
 * Settings as a file, and the four claims made about it.
 *
 * The whole design rests on one observation: a sparse override object with
 * clamped, defaulted resolution *is* a `settings.json`, so the file is not a
 * second mechanism but the same one serialised. Everything below is a way of
 * asking whether that is still true, because the moment it stops being true the
 * symptom is a settings file that quietly means something different from the
 * settings screen it came from — and nothing fails.
 *
 * These are pure: `file.ts` has no `chrome.*`, no DOM and no clock, so the
 * round-trip claims are arithmetic rather than a sequence of clicks.
 * `settings-import.test.ts` drives the screen.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  EXPORT_FILENAME,
  SCHEMA,
  defaultsJson,
  exportable,
  parseSettingsFile,
  planImport,
  serialise,
  unknownLines,
  type ParsedFile,
} from '../src/features/settings/file.js';
import { DEFAULTS, resolve } from '../src/features/settings/index.js';
import type { Overrides } from '../src/shared/types.js';

const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');

/** Parse-or-throw, for the cases where the parse is not what is under test. */
function parsed(text: string): ParsedFile {
  const result = parseSettingsFile(text);
  if (!result.ok) throw new Error(`could not parse: ${result.error.message}`);
  return result.value;
}

/** The whole trip: an area, out to a file, back in, and out again. */
function roundTrip(area: Overrides): { first: string; second: string; applied: Overrides } {
  const first = serialise(exportable(area));
  const plan = planImport(area, parsed(first));
  const second = serialise(exportable(plan.overrides));
  return { first, second, applied: plan.overrides };
}

describe('what an export contains', () => {
  it('is the sparse override object, not the resolved one', () => {
    const text = serialise(exportable({ 'screenshots.quality': 20 }));
    const object = JSON.parse(text) as Record<string, unknown>;

    // "A file that pins all sixty values freezes today's defaults into
    // whoever imports it, forever, and the mistake is invisible until the
    // release where a default improves and they do not get it."
    expect(Object.keys(object)).toEqual(['$schema', 'screenshots.quality']);
    expect(object.$schema).toBe(SCHEMA);
  });

  it('holds nothing but the marker when nothing has been changed', () => {
    expect(JSON.parse(serialise(exportable({})))).toEqual({ $schema: SCHEMA });
  });

  it('writes the resolved value, not whatever storage happened to hold', () => {
    // A hand-edited profile, or a build that has since been downgraded. `"800"`
    // plainly means 800, and a file that said `"800"` would not survive its own
    // round trip — the import resolves it on the way past.
    const object = JSON.parse(serialise(exportable({ 'recording.domDeltaMs': '800' })));
    expect(object['recording.domDeltaMs']).toBe(800);
  });

  it('drops a stored value that is already the default', () => {
    const area = { 'screenshots.quality': DEFAULTS['screenshots.quality'] };
    expect(JSON.parse(serialise(exportable(area)))).toEqual({ $schema: SCHEMA });
  });

  it('is sorted, so two builds with different table orders still diff', () => {
    const text = serialise({ 'screenshots.quality': 20, 'console.captureUncaught': false });
    expect(text.indexOf('console.captureUncaught')).toBeLessThan(
      text.indexOf('screenshots.quality'),
    );
  });

  it('has no timestamp in it — two exports must be byte-identical', () => {
    const area = { 'screenshots.quality': 20, mcpAutoSend: true };
    expect(serialise(exportable(area))).toBe(serialise(exportable(area)));
    expect(serialise(exportable(area))).not.toMatch(/\d{4}-\d{2}-\d{2}|timestamp|generated/i);
  });

  it('names the file with no date either, for the same reason', () => {
    expect(EXPORT_FILENAME).toBe('flowsnap-settings.json');
  });
});

describe('the shipped default file', () => {
  it('is what the read-only pane renders, byte for byte', () => {
    // The `{}` toggle's left-hand pane *is* `settings.default.json`. The
    // pane builds it from `DEFAULTS` rather than fetching it, so this is the
    // only thing that can notice the two coming apart — and nothing reads that
    // file at runtime, so nothing else ever would.
    const shipped = readFileSync(resolvePath(root, 'public/settings.default.json'), 'utf8');
    expect(defaultsJson()).toBe(shipped);
  });

  it('is not a configuration, so it carries no $schema', () => {
    expect(JSON.parse(defaultsJson()).$schema).toBeUndefined();
  });
});

describe('export round-trips', () => {
  it('is byte-identical on the second export', () => {
    const { first, second } = roundTrip({
      'screenshots.quality': 20,
      'network.captureBodies': false,
      'console.levels': ['error', 'warn'],
      editor: 'webstorm',
    });
    expect(second).toBe(first);
  });

  it('leaves the resolved settings unchanged', () => {
    const area = { 'screenshots.quality': 20, mcpAutoSend: true };
    const { applied } = roundTrip(area);
    expect(resolve(applied)).toEqual(resolve(area));
  });

  it('stays sparse: a file of nothing but defaults applies as an empty area', () => {
    // The freeze-the-defaults bug, arriving through the file instead of through
    // storage. A colleague's export that happens to match every default must not
    // pin them.
    const everything: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(DEFAULTS)) everything[key] = value;

    const plan = planImport({}, parsed(serialise(everything)));
    expect(plan.overrides).toEqual({});
    expect(plan.empty).toBe(true);
  });
});

describe('keys this version does not recognise', () => {
  const area: Overrides = { 'screenshots.quality': 20, 'recording.futureThing': 7 };

  it('survive an export, an import, and a second export', () => {
    const { first, second, applied } = roundTrip(area);
    expect(JSON.parse(first)['recording.futureThing']).toBe(7);
    expect(applied['recording.futureThing']).toBe(7);
    expect(second).toBe(first);
  });

  it('are listed separately in the diff, with the reason', () => {
    const plan = planImport({}, parsed(serialise(exportable(area))));

    expect(plan.unknown).toEqual([
      { key: 'recording.futureThing', value: '7', changes: true },
    ]);
    // And never as a setting: nothing here can clamp a field it has no
    // description of, so nothing here pretends to know what it means.
    expect(plan.changes.map((change) => change.key)).not.toContain('recording.futureThing');
  });

  it('do not make a diff non-empty when they are already stored', () => {
    const plan = planImport(area, parsed(serialise(exportable(area))));
    expect(plan.empty).toBe(true);
    expect(plan.unknown[0].changes).toBe(false);
  });

  it('are found by line, so the pane can mark them while it does not parse', () => {
    const text = '{\n  "$schema": "flowsnap/settings-1",\n  "screenshots.quality": 20,\n  "nope.nope": 1,\n';
    // Deliberately unterminated: the gutter is most useful mid-edit, which is
    // exactly when `JSON.parse` has nothing to say.
    expect(parseSettingsFile(text).ok).toBe(false);
    expect(unknownLines(text)).toEqual([4]);
  });

  it('does not mark `$schema`, which is the format marker and not a setting', () => {
    expect(unknownLines('{\n  "$schema": "flowsnap/settings-1"\n}\n')).toEqual([]);
  });
});

describe('the eight keys that predate the dotted namespace', () => {
  /**
   * `theme`, `editor`, `mcpAutoSend` and the rest keep the `chrome.storage.sync`
   * names users' machines are already synced under — decided in Phase 3, see the
   * header of `fields.ts` for why renaming is worse than the mixed namespace.
   *
   * The decision is only defensible while it costs nothing but sort order, and
   * that is what these assert: to every part of the file they are ordinary
   * settings. The failure they guard against is the loud one — a legacy key
   * treated as unrecognised would be flagged in the pane's gutter as "not a
   * setting in this version" and listed in the import diff as a key to be kept
   * verbatim, on the eight settings most people have actually changed.
   */
  const LEGACY = [
    'theme',
    'mcpServerUrl',
    'mcpAutoSend',
    'reactCapture',
    'reactResolve',
    'projectRoot',
    'editor',
    'customEditorTemplate',
  ];

  it('are settings, not unrecognised keys, everywhere the file touches them', () => {
    const area = { editor: 'webstorm', mcpAutoSend: true, 'screenshots.quality': 20 };
    const text = serialise(exportable(area));

    // Nothing in the gutter, nothing in the unknown list, and a diff row that
    // names the setting rather than quoting the key back.
    expect(unknownLines(text)).toEqual([]);

    const plan = planImport({}, parsed(text));
    expect(plan.unknown).toEqual([]);
    expect(plan.changes.map((change) => change.key).sort()).toEqual([
      'editor',
      'mcpAutoSend',
      'screenshots.quality',
    ]);
  });

  it('round-trip like any other key', () => {
    const area = Object.fromEntries(
      LEGACY.map((key) => [key, key === 'theme' ? 'dark' : key === 'editor' ? 'webstorm' : true]),
    );
    const { first, second } = roundTrip(area);
    expect(second).toBe(first);
  });

  it('are all still in the table, so the decision cannot be half-reversed', () => {
    // A rename that moved four of them and left four would be the worst of both:
    // a migration's risk and the mixed namespace it was meant to remove.
    for (const key of LEGACY) expect(DEFAULTS).toHaveProperty(key);
  });
});

describe('the diff', () => {
  it('lists exactly what changes, current beside incoming', () => {
    const plan = planImport(
      { 'screenshots.quality': 20 },
      parsed('{"screenshots.quality": 45}'),
    );

    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      key: 'screenshots.quality',
      from: '20',
      to: '45',
      clamped: false,
      reset: false,
    });
  });

  it('says a file equal to the current overrides changes nothing', () => {
    // The reason it is a test: the alternative is a dialog that offers
    // to apply nothing, which reads as an import that did not work.
    const area = { 'screenshots.quality': 20, mcpAutoSend: true };
    const plan = planImport(area, parsed(serialise(exportable(area))));

    expect(plan.changes).toEqual([]);
    expect(plan.empty).toBe(true);
  });

  it('shows a setting the file omits going back to its default', () => {
    // The file is the whole configuration, not a patch. "Send me your settings
    // file" has to mean the recipient ends up with the sender's configuration,
    // not the sender's overlaid on their own.
    const plan = planImport({ 'screenshots.quality': 20 }, parsed('{}'));

    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0]).toMatchObject({
      key: 'screenshots.quality',
      from: '20',
      to: String(DEFAULTS['screenshots.quality']),
      reset: true,
    });
    expect(plan.overrides).toEqual({});
  });

  it('marks a value this version had to clamp, and counts it', () => {
    const plan = planImport({}, parsed('{"screenshots.quality": 900}'));

    expect(plan.clamped).toBe(1);
    expect(plan.changes[0]).toMatchObject({ key: 'screenshots.quality', to: '100', clamped: true });
  });

  it('counts a clamp that changed nothing, because nobody else would say so', () => {
    // Already at the maximum, and the file asks for more. No row — the value
    // does not move — but the person who wrote 900 is the person who most needs
    // to know this version will never do it.
    const plan = planImport({ 'screenshots.quality': 100 }, parsed('{"screenshots.quality": 900}'));

    expect(plan.changes).toEqual([]);
    expect(plan.clamped).toBe(1);
    expect(plan.empty).toBe(true);
  });

  it('is in table order, not file order', () => {
    const plan = planImport(
      {},
      parsed('{"editor": "webstorm", "recording.maxSteps": 300, "screenshots.quality": 20}'),
    );
    expect(plan.changes.map((change) => change.key)).toEqual([
      'recording.maxSteps',
      'screenshots.quality',
      'editor',
    ]);
  });

  it('reads a boolean and a list in the words the stamp uses', () => {
    const plan = planImport(
      { mcpAutoSend: true },
      parsed('{"mcpAutoSend": false, "console.levels": []}'),
    );
    const by = new Map(plan.changes.map((change) => [change.key, change]));

    expect(by.get('mcpAutoSend')).toMatchObject({ from: 'on', to: 'off' });
    expect(by.get('console.levels')).toMatchObject({ to: 'none' });
  });
});

describe('a file this version cannot read', () => {
  it('names the line — the archetypal hand-edit, a missing comma', () => {
    const result = parseSettingsFile(
      '{\n  "$schema": "flowsnap/settings-1",\n  "screenshots.quality": 20\n  "mcpAutoSend": true\n}\n',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.line).toBe(4);
    expect(result.error.message).toMatch(/^Line 4, column \d+:/);
  });

  it('still says what is wrong when the engine will not say where', () => {
    /*
     * V8 has three message shapes and only two of them carry a position. The
     * third quotes a mangled snippet of the user's own text back at them
     * instead, and there is no reading of it that recovers the offset — so the
     * message says what is wrong and does not pretend to know where.
     */
    const result = parseSettingsFile('{\n  "a": 1,\n  "b": ,\n}\n');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).not.toMatch(/is not valid JSON/);
    expect(result.error.message).not.toMatch(/undefined|NaN|null/);
    expect(result.error.message.length).toBeGreaterThan(10);
  });

  it('says so plainly when the document is not an object of keys', () => {
    const result = parseSettingsFile('[1, 2, 3]');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toContain('This one is a list');
  });

  it('has something to say about an empty file rather than an empty diff', () => {
    const result = parseSettingsFile('   ');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.message).toBe('The file is empty.');
  });
});

describe('$schema', () => {
  it('is checked to produce a good message, never to refuse a file', () => {
    // Refusing on version is how you strand a user whose other machine
    // updated first — the one person who most needs to move their settings.
    const plan = planImport(
      {},
      parsed('{"$schema": "flowsnap/settings-9", "screenshots.quality": 20}'),
    );

    expect(plan.schema).toBe('flowsnap/settings-9');
    expect(plan.schemaNote).toContain('flowsnap/settings-9');
    expect(plan.changes.map((change) => change.key)).toEqual(['screenshots.quality']);
  });

  it('says nothing at all when the file is this version, or says nothing', () => {
    expect(planImport({}, parsed(`{"$schema": "${SCHEMA}"}`)).schemaNote).toBeNull();
    // A hand-written file starting from the shipped defaults has no marker, and
    // nagging about it on every one of those is noise, not a good message.
    expect(planImport({}, parsed('{}')).schemaNote).toBeNull();
  });

  it('is never mistaken for a setting this version does not have', () => {
    const plan = planImport({}, parsed(`{"$schema": "${SCHEMA}", "a.b": 1}`));
    expect(plan.unknown.map((entry) => entry.key)).toEqual(['a.b']);
  });
});
