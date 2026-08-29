/**
 * The six states the table names, decided rather than drawn.
 *
 * `view.ts` is pure — it takes the settings and a query and says which rows
 * survive, what the rail counts, whether the body is a list or an empty state,
 * and which rows are inert and why. All of it is testable without a DOM, which
 * is the point of the split: a state that only exists inside a render function
 * can only be checked by reading pixels, and nobody re-reads sixty rows.
 */

import { describe, expect, it } from 'vitest';
import { portOf } from '../src/features/mcp/port.js';
import {
  consequenceApplies,
  DEFAULTS,
  FIELDS,
  WIRED,
  type Field,
} from '../src/features/settings/fields.js';
import {
  EMPTY_QUERY,
  activeGroups,
  defaultLabel,
  highlight,
  lift,
  matches,
  normalise,
  commitProblem,
  settingsModel,
  unmetReason,
  type Query,
} from '../src/ui/settings/view.js';

const fields = FIELDS as readonly Field[];
const field = (key: string): Field => fields.find((entry) => entry.key === key)!;

function model(overrides: Partial<typeof DEFAULTS> = {}, query: Query = EMPTY_QUERY, open = false) {
  return settingsModel({
    settings: { ...DEFAULTS, ...overrides },
    query,
    advancedOpen: open,
  });
}

describe('what the screen carries', () => {
  it('shows every wired setting and nothing that does nothing', () => {
    /*
     * Phase 0 tabled all seventy-one fields it then knew about so the type,
     * the clamp and the generated default file could come from one place — and
     * wired none of them beyond the eight that already existed, because a
     * control that silently does nothing is worse than an absent one. That is
     * the shipped page's own reason for not drawing the redaction toggles.
     *
     * Asserted as the invariant rather than as a count of eight: a later phase
     * wiring a consumer flips `wired` and the setting appears, and this has to
     * still be the statement being made when it does.
     */
    const rendered = [
      ...model().groups.flatMap((group) => group.rows),
      ...settingsModel({
        settings: DEFAULTS,
        query: EMPTY_QUERY,
        advancedOpen: true,
      }).advanced.rows,
    ].map((row) => row.field.key);

    expect(rendered.sort()).toEqual(WIRED.map((entry) => entry.key).sort());
  });

  it('still carries all eight of the settings that already existed', () => {
    // The done-condition of the phase this screen was built in. These eight are
    // the keys users' machines are already synced under; losing one from the
    // screen would silently strand a value that is still in force.
    const rendered = new Set(
      model().groups.flatMap((group) => group.rows.map((row) => row.field.key)),
    );

    for (const key of [
      'theme',
      'reactCapture',
      'reactResolve',
      'projectRoot',
      'editor',
      'customEditorTemplate',
      'mcpServerUrl',
      'mcpAutoSend',
    ]) {
      expect(rendered, key).toContain(key);
    }
  });

  it('opens each group with a paragraph, and puts the rail in table order', () => {
    // Derived from the table, not written out: the rail is one row per group
    // that actually holds a visible setting, in `GROUPS` order, with the two
    // places — Advanced and Storage — below the hairline at the foot.
    const groups = model().rail.filter((item) => !item.foot).map((item) => item.id);
    expect(groups).toEqual(activeGroups(WIRED.filter((entry) => entry.tier === 1)));
    expect(model().rail.at(-1)!.id).toBe('storage');

    for (const group of model().groups) {
      expect(group.info.description.length, group.info.id).toBeGreaterThan(20);
    }
  });

  it('counts what a group holds, and swaps in a modified count once it has one', () => {
    const inReact = WIRED.filter((entry) => entry.group === 'react' && entry.tier === 1).length;
    const rest = model().rail.find((item) => item.id === 'react')!;
    expect(rest.mark).toEqual({ kind: 'count', count: inReact });

    const moved = model({ projectRoot: '/code/app' }).rail.find((item) => item.id === 'react')!;
    expect(moved.mark).toEqual({ kind: 'modified', count: 1 });
  });

  it('gives Advanced a chevron rather than a count, and puts it below the hairline', () => {
    /*
     * Phase 6 wired the twenty-eight Tier 2 settings, so Advanced is in the rail
     * of the shipped screen rather than only of the whole table. A chevron and
     * not a count, always: the count of a section you have not opened is a
     * number about things you cannot see.
     */
    const advanced = model().rail.find((item) => item.id === 'advanced')!;
    expect(advanced.mark).toEqual({ kind: 'chevron' });
    expect(advanced.foot).toBe(true);
    expect(model().rail.at(-2)!.id).toBe('advanced');
  });

  it('keeps Advanced shut until it is opened, and holds every Tier 2 row', () => {
    // Collapsed by default — the states table — and the rows are still in the
    // model, which is what lets a search reach into it.
    const shut = model();
    expect(shut.advanced.expanded).toBe(false);
    expect(shut.advanced.rows).toHaveLength(WIRED.filter((entry) => entry.tier === 2).length);
    expect(shut.groups.every((group) => group.rows.every((row) => row.field.tier === 1))).toBe(true);

    const open = settingsModel({ settings: DEFAULTS, query: EMPTY_QUERY, advancedOpen: true });
    expect(open.advanced.expanded).toBe(true);
  });
});

describe('search', () => {
  it('matches the title, the description and the key', () => {
    const maxSteps = field('recording.maxSteps');
    expect(matches(maxSteps, 'stop recording')).toBe(true);
    expect(matches(maxSteps, 'qa pass')).toBe(true);
    // The key is the name the file, the errors and the docs all use. Somebody
    // who read it somewhere should be able to type it here.
    expect(matches(maxSteps, 'recording.maxsteps')).toBe(true);
    expect(matches(maxSteps, 'thumbnail')).toBe(false);
  });

  it('collapses groups with no match and dims their rail rows', () => {
    const found = model({}, { text: 'editor', filters: [] });
    expect(found.body).toBe('list');
    expect(found.groups.map((group) => group.info.id)).toEqual(['react']);

    const appearance = found.rail.find((item) => item.id === 'appearance')!;
    expect(appearance.muted).toBe(true);
    // While searching, the rail counts matches rather than totals.
    // Three: the editor select, its custom template, and the project root,
    // whose description explains that it is what makes an editor link possible.
    expect(found.rail.find((item) => item.id === 'react')!.mark).toEqual({
      kind: 'count',
      count: 3,
    });
  });

  it('becomes an empty state when nothing matches', () => {
    const none = model({}, { text: 'retry', filters: [] });
    expect(none.body).toBe('no-matches');
    expect(none.shown).toBe(0);
  });

  it('hides the storage panel while a query is on — a query is not about it', () => {
    expect(model().showStorage).toBe(true);
    expect(model({}, { text: 'theme', filters: [] }).showStorage).toBe(false);
  });

  it('marks every occurrence, and leaves one plain segment when there is none', () => {
    expect(highlight('Stop recording', 'record')).toEqual([
      { text: 'Stop ', match: false },
      { text: 'record', match: true },
      { text: 'ing', match: false },
    ]);
    expect(highlight('Stop recording', '')).toEqual([{ text: 'Stop recording', match: false }]);
  });
});

describe('filter tokens become chips', () => {
  it('lifts a completed token and leaves a half-typed one alone', () => {
    expect(lift('@modified', [])).toEqual({ text: '', filters: ['@modified'] });
    expect(lift('@mod', [])).toEqual({ text: '@mod', filters: [] });
    expect(lift('quality @advanced ', [])).toEqual({
      text: 'quality ',
      filters: ['@advanced'],
    });
  });

  it('does not add the same chip twice', () => {
    expect(lift('@modified ', ['@modified'])).toEqual({ text: '', filters: ['@modified'] });
  });

  it('@modified shows only changed rows, and names them for "Reset all shown"', () => {
    const changed = model({ mcpAutoSend: true, projectRoot: '/code/app' }, {
      text: '',
      filters: ['@modified'],
    });

    expect(changed.shown).toBe(2);
    expect([...changed.shownModified].sort()).toEqual(['mcpAutoSend', 'projectRoot']);
    // Cutting across groups is the whole reason it is a filter and not a tab.
    expect(changed.groups.map((group) => group.info.id)).toEqual(['react', 'mcp']);
  });

  it('@default is the complement, exactly', () => {
    const untouched = model({ mcpAutoSend: true }, { text: '', filters: ['@default'] });
    expect(untouched.shownModified).toEqual([]);
    expect(untouched.shown).toBe(WIRED.length - 1);
  });

  it('@advanced shows tier 2 and opens the disclosure that holds it', () => {
    const advanced = settingsModel({
      settings: DEFAULTS,
      query: { text: '', filters: ['@advanced'] },
      advancedOpen: false,
      fields,
    });

    expect(advanced.groups).toEqual([]);
    expect(advanced.advanced.rows.every((row) => row.field.tier === 2)).toBe(true);
    // Reporting matches inside a section the user cannot see would be a lie.
    expect(advanced.advanced.expanded).toBe(true);
  });
});

describe('a setting that cannot do anything says so', () => {
  it('greys the three React fields that follow the master switch', () => {
    const off = model({ reactCapture: false });
    const react = off.groups.find((group) => group.info.id === 'react')!;

    const inert = react.rows.filter((row) => row.disabled).map((row) => row.field.key);
    expect(inert).toEqual(['reactResolve', 'projectRoot', 'editor', 'customEditorTemplate']);

    for (const row of react.rows.filter((entry) => entry.disabled)) {
      expect(row.disabledReason, row.field.key).toBeTruthy();
    }
  });

  it('keeps the custom template searchable rather than hiding it', () => {
    /*
     * The shipped page hid this row unless the editor was already Custom, which
     * meant its key could not be found by anybody who did not already know the
     * editor had to be set first. Disabled, not hidden: the argument for showing
     * the key at all is that the form and the file are the same product.
     */
    const shown = model({ reactCapture: true, editor: 'vscode' });
    const react = shown.groups.find((group) => group.info.id === 'react')!;
    const template = react.rows.find((row) => row.field.key === 'customEditorTemplate')!;

    expect(template.disabled).toBe(true);
    expect(unmetReason('customEditorTemplate', { ...DEFAULTS, editor: 'custom' })).toBeNull();
  });
});

describe('what a committed value is tidied into', () => {
  it('takes the trailing slash off a project root', () => {
    // Every path built from it joins one on, and `/repo//src/App.tsx` is a path
    // no editor opens.
    expect(normalise(field('projectRoot'), '/code/app/')).toBe('/code/app');
    expect(normalise(field('projectRoot'), '/code/app')).toBe('/code/app');
  });

  it('reads an empty MCP address as the default, not as no server', () => {
    expect(normalise(field('mcpServerUrl'), '   ')).toBe(DEFAULTS.mcpServerUrl);
  });

  it('says at once that an http editor template will be refused later', () => {
    const template = field('customEditorTemplate');
    expect(commitProblem(template, 'vscode://file/{path}:{line1}')).toBeNull();
    expect(commitProblem(template, '')).toBeNull();
    // The refusal happens days later, when somebody clicks a source link, and
    // looks like the link being broken rather than the template being wrong.
    expect(commitProblem(template, 'https://example.com/{path}')).toContain('app link');
  });
});

describe('the key line', () => {
  it('names the shipped default in words a person can read', () => {
    expect(defaultLabel(field('mcpAutoSend'))).toBe('default off');
    expect(defaultLabel(field('reactCapture'))).toBe('default on');
    expect(defaultLabel(field('recording.maxSteps'))).toBe('default 500');
    expect(defaultLabel(field('projectRoot'))).toBe('default empty');
    expect(defaultLabel(field('console.levels'))).toContain('default ');
  });

  it('is the default, never the value on screen', () => {
    // Getting this backwards makes the line agree with the input at all times,
    // which is exactly when it stops being able to tell you anything.
    expect(defaultLabel(field('mcpAutoSend'))).toBe('default off');
  });
});

describe('a consequence appears when it is true, not when the value is touched', () => {
  /**
   * The consequence "appears when the entered value enters the range it
   * describes, not always". A warning that is on for everybody at all times is
   * wallpaper, and the row it sits in is the row the user stops reading.
   *
   * Without a `consequenceWhen` a consequence shows while the setting is merely
   * *modified*, which is right only where "modified" and "the sentence is true"
   * are the same condition. These three are the whole list, and each says why in
   * `fields.ts`; anything else with a `consequence` needs a threshold.
   */
  const BARE = ['console.levels', 'customEditorTemplate', 'mcp.port'];

  it('gives every other wired consequence a range to be true in', () => {
    const missing = WIRED.filter(
      (entry) =>
        entry.consequence &&
        !entry.consequenceWhen &&
        !BARE.includes(entry.key),
    ).map((entry) => entry.key);

    expect(missing).toEqual([]);
  });

  it('keeps that list to the two whose default is the whole condition', () => {
    // Both default to "nothing selected / nothing entered", so modified *is*
    // the range. If a third arrives, it needs the same argument in writing.
    for (const key of ['console.levels', 'customEditorTemplate']) {
      const entry = fields.find((f) => f.key === key)!;
      const shipped = DEFAULTS[key as keyof typeof DEFAULTS];
      expect(Array.isArray(shipped) ? shipped.length > 0 : shipped === '').toBe(true);
      expect(entry.consequence).toBeTruthy();
    }
  });

  it('and to the third, whose argument is that both sides ship agreeing', () => {
    /*
     * `mcp.port`'s consequence is "both sides must agree or sends fail", and the
     * reason it needs no threshold is that at the shipped value they *do* — the
     * default port and the port inside the default address are one number, so
     * the sentence is untrue at the default and can only become true once
     * somebody moves it.
     *
     * Which makes this the assertion that carries the argument, and it is worth
     * having for its own sake: two defaults in `constants.ts` that quietly
     * stopped agreeing would ship an extension that cannot reach its own server
     * out of the box.
     */
    expect(portOf(DEFAULTS.mcpServerUrl)).toBe(DEFAULTS['mcp.port']);
    expect(fields.find((f) => f.key === 'mcp.port')!.consequence).toBeTruthy();
  });

  it('says nothing about unreadable text when the quality went up', () => {
    /*
     * The case this rule exists for, and the one that was live before it: the
     * sentence is "below about 30, small text stops being readable", and it was
     * shown at 90 — where the opposite is true — because the value had moved.
     */
    const quality = field('screenshots.quality');
    expect(consequenceApplies(quality, 90, true)).toBe(false);
    expect(consequenceApplies(quality, 20, true)).toBe(true);
  });

  it('warns at both ends of the one setting that is wrong in both directions', () => {
    const delta = field('recording.domDeltaMs');
    expect(consequenceApplies(delta, 150, true)).toBe(true);
    expect(consequenceApplies(delta, 700, true)).toBe(false);
    expect(consequenceApplies(delta, 3000, true)).toBe(true);
  });
});


/**
 * A query with a capital letter in it.
 *
 * `Query.text` is documented as "already lowercased" and both readers rely on
 * it: `matches` lowercases the field, and `highlight` lowercases the haystack
 * because it has to slice the *original* out of it. Only `lift` builds a
 * `Query`, so only `lift` can hold that up — and it did not, which meant typing
 * a capital letter into the search box matched nothing at all. Nothing threw,
 * the empty state was the correct empty state, and every test in this file
 * passed, because every one of them was written in lower case.
 */
describe('search is not case-sensitive', () => {
  const walkthrough = FIELDS.find((field) => field.key === 'mcp.maxResponseBody') as Field;

  it('finds a setting whose title is capitalised', () => {
    expect(matches(walkthrough, lift('Walkthrough', []).text)).toBe(true);
    expect(matches(walkthrough, lift('WALKTHROUGH BODY', []).text)).toBe(true);
  });

  it('finds a key however it is typed', () => {
    expect(matches(walkthrough, lift('MCP.maxResponseBody', []).text)).toBe(true);
  });

  it('still marks the hit in the original text, not a lowercased copy', () => {
    // `highlight` slices out of the text it was given, so the marked run has to
    // come back with its capital letter — otherwise search would silently
    // rewrite every title it matched.
    const segments = highlight(walkthrough.title, lift('Walkthrough', []).text);

    expect(segments.filter((part) => part.match).map((part) => part.text)).toEqual([
      'Walkthrough',
    ]);
  });

  it('lifts a filter token typed in capitals', () => {
    expect(lift('@Modified', []).filters).toEqual(['@modified']);
  });
});
