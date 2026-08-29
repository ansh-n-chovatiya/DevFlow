/**
 * What the Settings screen should show, derived from the settings and the query.
 *
 * Pure: no `chrome.*`, no DOM, no clock. Every decision about which state the
 * screen is in — which rows survive the filter, what the rail counts, whether
 * the body is a list or an empty state, which rows are disabled and why — is
 * made here and covered by `tests/settings-view.test.ts`, which leaves
 * `components.ts` with nothing to decide and `main.ts` with nothing to render.
 *
 * The same split the library already uses (`ui/viewer/library-view.ts`), for the
 * same reason: state that only exists inside a render function is state that can
 * only be tested by reading pixels.
 */

import { isEditorScheme } from '../../core/react/editor.js';
import type { Alignment } from '../../features/mcp/port.js';
import { showValue } from '../../features/settings/stamp.js';
import type { RowNote } from './components.js';
import {
  consequenceApplies,
  DEFAULTS,
  GROUPS,
  groupInfo,
  isModified,
  WIRED,
  type Field,
  type Group,
  type GroupInfo,
  type SettingKey,
  type Settings,
} from '../../features/settings/index.js';

// ── The query ────────────────────────────────────────────────────────────────

/**
 * The three filter tokens. Typed into the search box, they become
 * chips rather than staying as text — the box is then only ever free text, and
 * "what is filtering this list" is a thing you can see and remove rather than a
 * string you have to re-read.
 */
export const FILTERS = ['@modified', '@default', '@advanced'] as const;

export type Filter = (typeof FILTERS)[number];

export interface Query {
  /** Free text, already lowercased. `''` when there is none. */
  readonly text: string;
  readonly filters: readonly Filter[];
}

export const EMPTY_QUERY: Query = { text: '', filters: [] };

export function isFilter(value: string): value is Filter {
  return (FILTERS as readonly string[]).includes(value);
}

/** Whether anything is narrowing the list — what the results row is gated on. */
export function isActive(query: Query): boolean {
  return query.text !== '' || query.filters.length > 0;
}

/**
 * Lift any complete filter token out of what was typed.
 *
 * A token is complete when it is a whole word: `@modified` followed by a space,
 * or standing alone at the end. `@mod` is left alone because the user is still
 * typing it, and turning it into a chip mid-word would eat the keystroke that
 * finishes it. Returns the text with the tokens removed and the tokens found,
 * so the caller can put one in the box and the other in the chip row.
 *
 * **Lowercased here, because this is the only thing that builds a `Query`.**
 * `matches` lowercases the field and `highlight` lowercases the haystack, so
 * both are written against a lowercased query and neither can do it itself —
 * `highlight` needs the original case to slice out of. Without this, typing a
 * capital letter matched nothing at all: "Walkthrough" found neither of the two
 * settings whose titles begin with the word. Found by rendering the page, which
 * is now three sessions running.
 */
export function lift(raw: string, existing: readonly Filter[]): {
  text: string;
  filters: Filter[];
} {
  const filters = [...existing];
  const kept: string[] = [];

  for (const word of raw.toLowerCase().split(/\s+/)) {
    if (isFilter(word)) {
      if (!filters.includes(word)) filters.push(word);
    } else if (word !== '') {
      kept.push(word);
    }
  }

  // The trailing space matters: it is the one the user just typed to finish a
  // word, and swallowing it makes the next character join the previous one.
  const trailing = /\s$/.test(raw) && kept.length > 0 ? ' ' : '';
  return { text: kept.join(' ') + trailing, filters };
}

// ── Matching ─────────────────────────────────────────────────────────────────

/**
 * Search matches title, description **and** key.
 *
 * The key is in there because it is the name the file, the error messages and
 * the documentation all use — somebody who has read `recording.maxSteps`
 * somewhere should be able to type it here and land on the control.
 */
export function matches(field: Field, text: string): boolean {
  if (text === '') return true;
  return (
    field.title.toLowerCase().includes(text) ||
    field.description.toLowerCase().includes(text) ||
    field.key.toLowerCase().includes(text)
  );
}

/** One run of text, and whether the query put it there. */
export interface Segment {
  readonly text: string;
  readonly match: boolean;
}

/**
 * Split `text` on every occurrence of `query`, so the caller can mark the hits.
 *
 * Returns a single unmatched segment when there is no query, which is what makes
 * highlighting free at the call site: the row always renders segments, and the
 * no-search case is one of them.
 */
export function highlight(text: string, query: string): Segment[] {
  if (query === '') return [{ text, match: false }];

  const segments: Segment[] = [];
  const haystack = text.toLowerCase();
  let at = 0;

  for (;;) {
    const found = haystack.indexOf(query, at);
    if (found === -1) break;
    if (found > at) segments.push({ text: text.slice(at, found), match: false });
    segments.push({ text: text.slice(found, found + query.length), match: true });
    at = found + query.length;
  }

  if (at < text.length) segments.push({ text: text.slice(at), match: false });
  return segments.length > 0 ? segments : [{ text, match: false }];
}

// ── Dependencies ─────────────────────────────────────────────────────────────

/**
 * Settings that cannot do anything until another setting says so.
 *
 * A table rather than four `if`s in the controller, because the controller is
 * where this drifted before: the shipped page disabled three React fields and
 * *hid* a fourth, which meant the custom template's key could not be found by
 * anybody who did not already know the editor had to be set to Custom first.
 *
 * Disabled, not hidden. A hidden row is a row whose key does not exist as far as
 * search is concerned, and the whole argument for showing the key is that the
 * form and the file are the same product.
 */
interface Dependency {
  readonly key: SettingKey;
  readonly met: (settings: Settings) => boolean;
  /** Shown in the row's note while it is unmet — the answer to "why is this grey". */
  readonly reason: string;
}

const DEPENDENCIES: readonly Dependency[] = [
  {
    key: 'screenshots.quality',
    met: (settings) => settings['screenshots.capture'],
    reason: 'Applies while screenshots are being captured.',
  },
  {
    key: 'screenshots.settleDelayMs',
    met: (settings) => settings['screenshots.capture'],
    reason: 'Applies while screenshots are being captured.',
  },
  {
    key: 'recording.domDeltaMs',
    met: (settings) => settings['recording.domDelta'],
    reason: 'Applies while on-screen changes are being recorded.',
  },
  {
    key: 'recording.containerTextCap',
    met: (settings) => settings['recording.domDelta'],
    reason: 'Applies while on-screen changes are being recorded.',
  },
  {
    key: 'network.bodyCap',
    met: (settings) => settings['network.captureBodies'],
    reason: 'Applies while request and response bodies are being captured.',
  },
  {
    /*
     * Depends on two, one of them the switch directly above it.
     *
     * Summarising a body it does not have is not a thing FlowSnap can do, so a
     * threshold that stayed live while bodies were switched off would be a
     * number with no effect and no explanation — the same shape as the custom
     * editor template below, and the same answer.
     */
    key: 'network.schemaThreshold',
    met: (settings) => settings['network.captureBodies'] && settings['network.summariseBodies'],
    reason: 'Applies while bodies are being captured and summarised.',
  },
  {
    key: 'network.summariseBodies',
    met: (settings) => settings['network.captureBodies'],
    reason: 'Applies while request and response bodies are being captured.',
  },
  {
    key: 'reactResolve',
    met: (settings) => settings.reactCapture,
    reason: 'Applies while the component behind each step is being recorded.',
  },
  {
    key: 'projectRoot',
    met: (settings) => settings.reactCapture,
    reason: 'Applies while the component behind each step is being recorded.',
  },
  {
    key: 'editor',
    met: (settings) => settings.reactCapture,
    reason: 'Applies while the component behind each step is being recorded.',
  },
  {
    key: 'customEditorTemplate',
    met: (settings) => settings.reactCapture && settings.editor === 'custom',
    reason: 'Applies when the editor above is set to “Custom…”.',
  },
];

const BY_DEPENDENT = new Map(DEPENDENCIES.map((entry) => [entry.key as string, entry]));

/** The reason a row is inert right now, or `null` when it is live. */
export function unmetReason(key: string, settings: Settings): string | null {
  const dependency = BY_DEPENDENT.get(key);
  if (!dependency) return null;
  return dependency.met(settings) ? null : dependency.reason;
}

// ── The model ────────────────────────────────────────────────────────────────

export interface RowModel {
  readonly field: Field;
  readonly value: unknown;
  /** The gutter bar, and everything derived from it. */
  readonly modified: boolean;
  /** Set by a dependency, never by a recording — see `RECORDING_NOTE`. */
  readonly disabled: boolean;
  readonly disabledReason: string | null;
  /** Whether the value is currently in the range the consequence describes. */
  readonly consequence: boolean;
}

export interface GroupModel {
  readonly info: GroupInfo;
  readonly rows: readonly RowModel[];
}

export interface AdvancedModel {
  readonly rows: readonly RowModel[];
  /** Collapsed to one row until the user opens it, or a search finds something in it. */
  readonly expanded: boolean;
}

/** What a rail row shows on its right-hand side. */
export type RailMark =
  | { readonly kind: 'count'; readonly count: number }
  /** Accent-filled: this group holds values the user has changed. */
  | { readonly kind: 'modified'; readonly count: number }
  | { readonly kind: 'chevron' }
  | { readonly kind: 'none' };

export interface RailItem {
  /** The anchor the rail scrolls to, and the row's identity. */
  readonly id: string;
  readonly title: string;
  readonly mark: RailMark;
  /** Dimmed and not clickable: nothing under it survived the query. */
  readonly muted: boolean;
  /** Advanced and Storage sit below the hairline at the foot of the rail. */
  readonly foot: boolean;
}

/** Which block fills the list column. Exactly one, always. */
export type SettingsBody = 'list' | 'no-matches';

export interface SettingsModel {
  readonly query: Query;
  readonly body: SettingsBody;
  /** Groups with at least one surviving row, in table order. */
  readonly groups: readonly GroupModel[];
  readonly advanced: AdvancedModel;
  readonly rail: readonly RailItem[];
  /** Rows on screen, after the query. The number in the results row. */
  readonly shown: number;
  /** Keys of the modified rows on screen — what "Reset all shown" resets. */
  readonly shownModified: readonly SettingKey[];
  /** The storage panel is page furniture, and a query is not about it. */
  readonly showStorage: boolean;
}

export interface ModelInput {
  readonly settings: Settings;
  readonly query: Query;
  /** User-held, not derived: whether the Advanced disclosure has been opened. */
  readonly advancedOpen: boolean;
  /**
   * The fields to render. Defaults to the settings the extension actually reads
   * — see `Common.wired` in `fields.ts`. Injectable so a test can drive the
   * screen with the whole table without waiting for six more phases.
   */
  readonly fields?: readonly Field[];
}

function row(field: Field, settings: Settings): RowModel {
  const value = settings[field.key as SettingKey];
  const modified = isModified(field.key as SettingKey, value);
  const reason = unmetReason(field.key, settings);

  return {
    field,
    value,
    modified,
    disabled: reason !== null,
    disabledReason: reason,
    consequence: consequenceApplies(field, value, modified),
  };
}

function survives(entry: RowModel, query: Query): boolean {
  if (!matches(entry.field, query.text)) return false;
  if (query.filters.includes('@modified') && !entry.modified) return false;
  if (query.filters.includes('@default') && entry.modified) return false;
  if (query.filters.includes('@advanced') && entry.field.tier !== 2) return false;
  return true;
}

/**
 * The whole screen, from the settings and the query.
 *
 * Tier 1 goes to its group; tier 2 goes to Advanced regardless of its group,
 * because Advanced is a place on the screen rather than a property of a
 * row — the point of the disclosure is that a bad value in there looks like
 * FlowSnap being broken, and that is true of all of them at once.
 */
export function settingsModel({
  settings,
  query,
  advancedOpen,
  fields = WIRED,
}: ModelInput): SettingsModel {
  const rows = fields.map((field) => row(field, settings));
  const kept = rows.filter((entry) => survives(entry, query));

  const groups: GroupModel[] = [];
  const rail: RailItem[] = [];

  for (const info of GROUPS) {
    const all = rows.filter((entry) => entry.field.group === info.id && entry.field.tier === 1);
    if (all.length === 0) continue;

    const here = kept.filter((entry) => entry.field.group === info.id && entry.field.tier === 1);
    if (here.length > 0) groups.push({ info, rows: here });

    rail.push({
      id: info.id,
      title: info.title,
      mark: railMark(isActive(query) ? here : all, isActive(query)),
      muted: here.length === 0,
      foot: false,
    });
  }

  const advancedAll = rows.filter((entry) => entry.field.tier === 2);
  const advancedKept = kept.filter((entry) => entry.field.tier === 2);

  if (advancedAll.length > 0) {
    rail.push({
      id: 'advanced',
      title: 'Advanced',
      // A chevron rather than a count, always: the count of a section you have
      // not opened is a number about things you cannot see.
      mark: { kind: 'chevron' },
      muted: advancedKept.length === 0,
      foot: true,
    });
  }

  const showStorage = !isActive(query);
  if (showStorage) {
    rail.push({ id: 'storage', title: 'Storage', mark: { kind: 'none' }, muted: false, foot: true });
  }

  return {
    query,
    // Advanced counts as a result even while collapsed — the disclosure says how
    // many are in there, so "no setting matches" would be untrue.
    body: kept.length === 0 ? 'no-matches' : 'list',
    groups,
    advanced: {
      rows: advancedKept,
      // A search that found something in Advanced opens it. Leaving it shut
      // would report matches the user cannot see and cannot reach.
      expanded: advancedOpen || (isActive(query) && advancedKept.length > 0),
    },
    rail,
    shown: kept.length,
    shownModified: kept.filter((entry) => entry.modified).map((entry) => entry.field.key as SettingKey),
    showStorage,
  };
}

function railMark(entries: readonly RowModel[], searching: boolean): RailMark {
  const modified = entries.filter((entry) => entry.modified).length;
  // The count of settings the group holds, "replaced by an accent-filled
  // count of modified settings when it has any". While searching it is the match
  // count instead — the rail's job under a query is to say where the hits are.
  if (!searching && modified > 0) return { kind: 'modified', count: modified };
  return { kind: 'count', count: entries.length };
}

// ── One changed value ────────────────────────────────────────────────────────

/**
 * A setting, what it is now, and what it is about to become.
 *
 * Shared by the reset-all confirmation and the import diff, because they are
 * the same list: *setting · current → incoming*, with a count that means
 * nothing without it. Two shapes for one list is how the two dialogs end up
 * disagreeing about whether the arrow points at the default or away from it.
 *
 * Lives here rather than in `components.ts` so the pure modules that build these
 * rows — `main.ts` for a reset, `file-view.ts` for an import — do not have to
 * import the file that draws them.
 */
export interface ChangeRow {
  readonly name: string;
  readonly from: string;
  readonly to: string;
  /** The setting's key, shown in mono under the name. Absent where there is none. */
  readonly key?: string;
  /** A few words about this row in particular: `clamped`, `not a setting here`. */
  readonly note?: string;
}

// ── Copy the screen needs and `fields.ts` does not hold ──────────────────────

/**
 * Settings are frozen for the duration of a recording, and the screen says
 * so. It does not *disable* anything — configuring the next recording while the
 * current one runs is a reasonable thing to be doing, and a greyed-out form with
 * no explanation is how you get somebody to think the page is broken.
 */
export const RECORDING_NOTE =
  'A recording is in progress. Changes you make now apply to the next recording.';

/** The Advanced disclosure, collapsed. */
export const ADVANCED_NOTE =
  'These change how recording behaves, and a bad value looks like FlowSnap being broken.';

/** The persistent banner over the group once it is open. */
export const ADVANCED_WARNING =
  'A bad value in here does not look like a setting. It looks like a failed recording, days later, with nothing to point at.';

/**
 * What an out-of-range entry is told, in the units the field is in.
 *
 * The message names the range rather than the mistake, because the range is the
 * part the user does not know. `resolve()` is still the validator — this is the
 * good message the form exists to give.
 */
export function rangeNote(field: Extract<Field, { type: 'number' }>): string {
  const unit = field.unit ? ` ${field.unit}` : '';
  return `Enter a number between ${field.min}${unit} and ${field.max}${unit}.`;
}

/** Said after a commit moved the value: the row says what it clamped to. */
export function clampedNote(
  field: Extract<Field, { type: 'number' }>,
  clamped: number,
): string {
  const unit = field.unit ? ` ${field.unit}` : '';
  return `Outside the accepted range, so it was set to ${clamped}${unit}.`;
}

// ── The machine-wide settings, and their two sides ───────────────────────────

/**
 * What a `POST /config` turned out to mean for the row that caused it.
 *
 * The three machine-wide settings are the only ones on this screen whose value
 * is not in force the moment it is written: the number goes into
 * `chrome.storage`, and the thing it governs is a Node process on the other
 * side of an HTTP boundary that may not be running, may be launched with an
 * environment variable that outranks it, and — for the port — cannot act on it
 * at all until it restarts. Every one of those is a way for a setting to look
 * saved and do nothing, which is the failure the whole mechanism is built
 * against, so each has a sentence here.
 *
 * Ordered by what the user most needs to know. A value that will never be used
 * beats one that was clamped, which beats one that waits for a restart, because
 * the first is the only one where what is on screen is not what will happen.
 */
export function machineNote(
  field: Field,
  sent: unknown,
  address: string,
  reply: MachineReply | null,
): RowNote {
  if (!reply) {
    return {
      text:
        `No server answered at ${address}, so ${CONFIG_FILE_NAME} was not written. ` +
        'Start the MCP server and press Send to server.',
      tone: 'danger',
    };
  }

  const beaten = reply.overridden.find((entry) => entry.key === field.key);
  if (beaten) {
    return {
      text:
        `Saved, but ${beaten.by ?? 'an environment variable'} is set where the server runs and ` +
        `outranks the file — it is using ${showValue(beaten.using)}.`,
      tone: 'danger',
    };
  }

  const effective = reply.effective[field.key];
  if (effective !== undefined && effective !== sent) {
    return {
      text: `Saved, but the server clamped it to ${showValue(effective)}.`,
      tone: 'danger',
    };
  }

  // The port, and only the port: a bound socket does not move. Said as a plain
  // note rather than a success, because the thing the user just asked for has
  // not happened yet.
  if (reply.restart) return { text: `Saved to ${reply.file}. ${reply.restart}`, tone: 'muted' };

  return { text: `Saved to ${reply.file}.`, tone: 'success' };
}

/** Only what `machineNote` reads — see `features/mcp/remote.ts` for the whole. */
export interface MachineReply {
  readonly file: string;
  readonly effective: Record<string, unknown>;
  readonly overridden: readonly { readonly key: string; readonly by?: string; readonly using: unknown }[];
  readonly restart: string | null;
}

/** Named before the server has answered, when there is no `reply.file` to quote. */
const CONFIG_FILE_NAME = '~/.flowsnap/config.json';

/**
 * What changing the port did to the address — the other side of the same
 * setting, said on the other side's own row.
 *
 * Why this exists: a port setting that changes one side and
 * not the other is worse than no port setting, because the failure it produces
 * — sends refused, "Test connection" red, an empty `list_flows` — looks like
 * every other kind of server problem. So the two rows are kept in step, and
 * both of them say so.
 */
export function addressNote(alignment: Alignment): RowNote | null {
  switch (alignment.kind) {
    case 'moved':
      return {
        text: `Moved from port ${alignment.from} to match the MCP server port.`,
        tone: 'success',
      };
    case 'remote':
      return {
        text:
          `Left alone: ${alignment.host} is not this machine’s server, and the port setting ` +
          'only says what the server here listens on.',
        tone: 'muted',
      };
    // Nothing to say. An address that is not a URL already has its own problem,
    // and `resolve()` is about to fall back to the default anyway.
    case 'agreed':
    case 'unusable':
      return null;
  }
}

/**
 * Field-specific tidying, applied at commit before the value reaches storage.
 *
 * Two of the eight settings have earned an entry here, and both were already
 * doing this in the page being replaced:
 *
 *   - A project root keeps its trailing slash off. Every path built from it
 *     joins one on, and `/repo//src/App.tsx` is a path no editor opens.
 *   - An empty MCP address means "the default", not "no server". Storing `''`
 *     would leave `resolve()` handing the recorder a blank URL to POST to.
 *
 * `resolve()` is still the only validator. This is tidying a value the user
 * plainly meant, not deciding whether it is legal.
 */
export function normalise(field: Field, value: unknown): unknown {
  if (typeof value !== 'string') return value;
  if (field.key === 'projectRoot') return value.replace(/[/\\]+$/, '');
  if (field.key === 'mcpServerUrl' && value.trim() === '') return DEFAULTS.mcpServerUrl;
  return value;
}

/**
 * What is wrong with a value that `resolve()` will nonetheless accept.
 *
 * The custom editor template is handed to `chrome.tabs.create`, so a template
 * that produced an `https://` address would turn this field into a way to open
 * arbitrary pages — which is why the worker refuses anything but an app scheme
 * before it opens a tab. The refusal happens days later, at the moment somebody
 * clicks a source link, and looks like the link being broken. Saying it here,
 * at the keystroke that caused it, is the whole difference.
 */
export function commitProblem(field: Field, value: unknown): string | null {
  if (field.key !== 'customEditorTemplate') return null;
  if (typeof value !== 'string' || value === '') return null;
  const probe = value.replace(/\{[a-z0-9]+\}/gi, '1');
  return isEditorScheme(probe)
    ? null
    : 'Not an app link. An http://, https:// or file:// template is refused when the link is opened.';
}

/** The `key · default N` line. `N` is the shipped default, never the current value. */
export function defaultLabel(field: Field): string {
  const shipped = DEFAULTS[field.key as SettingKey];
  if (typeof shipped === 'boolean') return shipped ? 'default on' : 'default off';
  if (Array.isArray(shipped)) return shipped.length === 0 ? 'default none' : `default ${shipped.join(', ')}`;
  if (shipped === '') return 'default empty';
  return `default ${String(shipped)}`;
}

/** Groups that hold at least one renderable setting — used by the tests and the rail. */
export function activeGroups(fields: readonly Field[]): readonly Group[] {
  return GROUPS.map((group) => group.id).filter((id) =>
    fields.some((field) => field.group === id),
  );
}

export { groupInfo };
