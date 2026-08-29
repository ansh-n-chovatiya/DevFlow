/**
 * What the file surfaces say, derived from the plan and the state of the page.
 *
 * The same split `view.ts` makes, for the same reason: every decision about
 * what the import dialog and the JSON view *say* is made here, which leaves
 * `components.ts` with nothing to decide and `main.ts` with nothing to word.
 * `tests/settings-import.test.ts` drives all of it through the real dialog —
 * the wording and the surface it appears on are one claim, and asserting the
 * string on its own would pass while the banner it belongs in was hidden.
 *
 * Pure: no `chrome.*`, no DOM, no clock.
 *
 * ## Why this is not in `view.ts`
 *
 * `view.ts` answers "which rows survive the query". This answers "what does
 * applying this file do". They share `ChangeRow` — deliberately, because the
 * reset-all dialog and the import diff are the same list of *setting · from →
 * to* and the whole argument is that there is one of each thing — and share
 * nothing else.
 */

import { SCHEMA, type ImportPlan } from '../../features/settings/file.js';
import type { ChangeRow } from './view.js';

/** `3 settings`, `1 setting`. Every count on these surfaces goes through it. */
function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

// ── The import dialog ────────────────────────────────────────────────────────

/**
 * Import step four, in words: *show the diff, and require confirmation*.
 *
 * "Step 4 is the point of the feature." A teammate's file quietly halving your
 * screenshot quality is exactly the unanswerable question about how a recording
 * was made that the stamp exists to prevent — so every value that would move is named,
 * with what it is now beside what it would become, and nothing is applied until
 * somebody has looked at that list and said yes.
 */
export interface ImportView {
  readonly title: string;
  readonly body: string;
  /**
   * `null` when there is nothing to confirm: a file equal to the current
   * overrides "produces an empty diff and the dialog says so rather than
   * offering to apply nothing".
   */
  readonly confirmLabel: string | null;
  readonly cancelLabel: string;
  /** The version message. Never a refusal — see `$schema` handling below. */
  readonly schemaNote: string | null;
  /** How many of the file's values this version had to move, and to where. */
  readonly clampNote: string | null;
  /** The refusal, stated. Present exactly while a recording is running. */
  readonly recordingNote: string | null;
  readonly changesHeading: { readonly title: string; readonly description: string } | null;
  readonly changes: readonly ChangeRow[];
  readonly unknownHeading: { readonly title: string; readonly description: string } | null;
  readonly unknown: readonly ChangeRow[];
  /** The empty state, when applying this file would do nothing at all. */
  readonly empty: { readonly title: string; readonly body: string } | null;
}

/** The one sentence the refusal has to state, and it states the reason. */
export const RECORDING_REFUSAL =
  'A recording is in progress, and its settings are frozen for its duration. Applying this file now would leave the flow following one rule for its first steps and another for the rest, with nothing in the recording saying so.';

/** What the deferred import promises, on the Settings page while it waits. */
export function pendingNote(changes: number): string {
  return `A settings file is waiting: ${count(changes, 'setting')} will change when this recording stops.`;
}

export function importView(plan: ImportPlan, recording: boolean): ImportView {
  const changed = plan.changes.length;
  const newUnknown = plan.unknown.filter((entry) => entry.changes).length;

  if (plan.empty) {
    return {
      title: 'Nothing to import',
      body: '',
      confirmLabel: null,
      cancelLabel: 'Close',
      schemaNote: plan.schemaNote,
      clampNote: clampNote(plan),
      recordingNote: null,
      changesHeading: null,
      changes: [],
      unknownHeading: null,
      unknown: [],
      empty: {
        title: 'This file matches your settings',
        body:
          plan.unknown.length > 0
            ? 'Every setting in it already has the value it would be given, including the keys this version does not recognise. There is nothing to apply.'
            : 'Every setting in it already has the value it would be given. There is nothing to apply.',
      },
    };
  }

  return {
    title: 'Import settings',
    body: summary(changed, newUnknown),
    confirmLabel: recording
      ? 'Apply when this recording stops'
      : `Apply ${count(changed, 'setting')}`,
    cancelLabel: 'Cancel',
    schemaNote: plan.schemaNote,
    clampNote: clampNote(plan),
    recordingNote: recording ? RECORDING_REFUSAL : null,
    changesHeading:
      changed === 0
        ? null
        : {
            title: 'What would change',
            description:
              'Current value on the left of the arrow, the file’s on the right. Everything not listed here is already what the file says, or goes back to its default.',
          },
    changes: plan.changes.map((change) => ({
      name: change.title,
      key: change.key,
      from: change.from,
      to: change.to,
      // Short, because the pill sits beside the setting's own title and a long
      // one crushes it. The section's heading carries the full sentence.
      note: change.clamped ? 'clamped' : change.reset ? 'not in the file' : undefined,
    })),
    unknownHeading:
      plan.unknown.length === 0
        ? null
        : {
            title: 'Not settings in this version',
            description:
              'Kept exactly as they are and ignored. Dropping them would mean a file that has passed through an older FlowSnap comes back with the newer version’s settings silently deleted.',
          },
    unknown: plan.unknown.map((entry) => ({
      name: entry.key,
      key: entry.key,
      from: entry.changes ? '' : 'unchanged',
      to: entry.value,
      note: 'not a setting in this version',
    })),
    empty: null,
  };
}

function summary(changed: number, newUnknown: number): string {
  const parts: string[] = [];
  if (changed > 0) parts.push(`${count(changed, 'setting')} would change`);
  if (newUnknown > 0) {
    parts.push(`${count(newUnknown, 'key')} this version does not recognise would be kept`);
  }
  return `${parts.join(', and ')}. Nothing is applied until you confirm, and applying can be undone.`;
}

/**
 * The clamp report, which appears whether or not the clamped value produced a
 * row.
 *
 * A file that says 9,000 against a maximum of 5,000, on a machine already at
 * 5,000, changes nothing and would otherwise be silent about having been
 * corrected — and the person who wrote 9,000 is the person who most needs to
 * know that this version will never do it.
 */
function clampNote(plan: ImportPlan): string | null {
  if (plan.clamped === 0) return null;
  return `${count(plan.clamped, 'value')} in this file ${plan.clamped === 1 ? 'is' : 'are'} outside the range this version accepts, and ${plan.clamped === 1 ? 'was' : 'were'} moved to the nearest value it does. Marked below.`;
}

// ── The JSON view ────────────────────────────────────────────────────────────

/**
 * Defaults on the left, read-only; the user's sparse overrides on the right.
 *
 * `meta` is the word in the top-right of each pane's caption bar. The left
 * one's is standing — it is read-only for the life of the page — and the right
 * one's appears only while the pane differs from what is stored.
 *
 * Both used to carry a `description` as well, and the two of them side by side
 * were a hundred and thirty pixels of ragged two-line paragraph above two
 * editors. They said what the panes are, which the captions now say in two
 * words each, and one thing that is genuinely not obvious — which is `PANES_NOTE`
 * below, said once for both.
 */
export const DEFAULTS_PANE = { title: 'Default settings', meta: 'read-only' } as const;

export const OVERRIDES_PANE = { title: 'Your settings', meta: 'edited' } as const;

/**
 * The one line above both panes.
 *
 * Not "this is JSON" — anybody who opened the `{}` view knows that, and not
 * which pane is which, which the captions say two inches lower. The fact worth
 * the line is that the editable pane is not a way to write straight to storage:
 * whatever is typed or pasted here goes through the same parse, validate,
 * resolve, diff and confirm that a picked file does, so nothing here can quietly
 * replace a setting the way it looks like it could.
 */
export const PANES_NOTE =
  'Edit the right pane or paste a file in — applying goes through the same review an import does.';

/** The note under an edited pane that no longer parses. */
export function paneProblem(message: string): string {
  return `Cannot apply: ${message}`;
}

/** The gutter's own words, said once and hovered on every marked line. */
export const UNKNOWN_LINE_NOTE = 'not a setting in this version';

/**
 * How many lines of the pane name a key this version does not have.
 *
 * Above the pane rather than only in the gutter: the unrecognised key is often
 * the one below the fold, and a warning nobody scrolls to is a warning that did
 * not happen.
 */
export function unknownPaneNote(lines: number): string | null {
  if (lines === 0) return null;
  return `${count(lines, 'line')} name${lines === 1 ? 's' : ''} a key that is not a setting in this version. It is kept and ignored, not dropped.`;
}

// ── Export ───────────────────────────────────────────────────────────────────

/** Said after the file is handed to the browser. */
export function exportedNote(filename: string, changed: number): string {
  return changed === 0
    ? `Saved ${filename}. You have not changed any setting, so it holds only ${SCHEMA}.`
    : `Saved ${filename} — ${count(changed, 'setting')}.`;
}
