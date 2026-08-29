/**
 * A flow's settings stamp, in words.
 *
 * A flow records the settings it was made under, and the walkthrough header
 * shows the non-default ones. This is the sentence that does it, and it is the
 * only place that wording exists — the extension's Markdown export, the
 * `flow.md` written beside a flow on disk and the walkthrough `get_flow`
 * returns all print the same lines, because a reader who sees two descriptions
 * of one recording has to work out which is true.
 *
 * Pure, and deliberately outside `core/`: `core/` is bundled into the MCP
 * server and knows nothing about the field table, so `exportToMarkdown` takes
 * these lines already written rather than the stamp itself. The server gets
 * this function through `core/mcp-bundle.ts` for the same reason it gets the
 * renderer — one wording, two processes.
 *
 * ## What the reader is being told
 *
 * Only what was *changed*. A flow recorded at the defaults stamps `{}` and
 * prints nothing, which is right: the header is for the recording that is not
 * like the others, and a header that repeats sixteen defaults on every flow is
 * a header nobody reads by the third one.
 *
 * The shipped default is named beside the value, because "quality 20" means
 * nothing to a reader who does not know that 60 is normal — and knowing it is
 * the whole difference between "this recording was made deliberately small" and
 * "something is wrong with this recording".
 */

import { DEFAULTS, STAMPED, fieldFor, type Field, type Overrides, type SettingKey } from './fields.js';

/** A value as it reads in a sentence: `on`, `off`, `error, warn`, `20`. */
export function showValue(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.join(', ');
  if (value === '') return 'empty';
  return String(value);
}

function line(field: Field, value: unknown): string {
  const shipped = DEFAULTS[field.key as SettingKey];
  return `${field.title}: ${showValue(value)} (default ${showValue(shipped)})`;
}

/**
 * One line per setting the recording did not use the default for.
 *
 * In table order rather than object order, so two flows recorded under the same
 * overrides print the same header whatever order the user changed them in.
 *
 * A key this build has never heard of — a flow recorded by a newer FlowSnap and
 * read by an older server, which `npx` makes ordinary — is printed raw rather
 * than dropped. The reader cannot be told what it means, but "this recording
 * was made under a setting I cannot describe" is a far better thing to say than
 * nothing at all, which reads as a recording made at the defaults.
 */
export function describeStamp(stamp: Overrides | null | undefined): string[] {
  if (!stamp || typeof stamp !== 'object') return [];

  const lines: string[] = [];

  for (const field of STAMPED) {
    if (!Object.hasOwn(stamp, field.key)) continue;
    lines.push(line(field, (stamp as Record<string, unknown>)[field.key]));
  }

  for (const key of Object.keys(stamp)) {
    const field = fieldFor(key);
    if (field?.recorded === true || field?.rendered === true) continue;
    lines.push(`${key}: ${showValue((stamp as Record<string, unknown>)[key])}`);
  }

  return lines;
}

/**
 * The stamp as one header line, or `null` when the flow used the defaults.
 *
 * `null` rather than an empty string so a caller cannot accidentally push a
 * blank line into a document that has nothing to say.
 */
export function stampHeadline(stamp: Overrides | null | undefined): string | null {
  const lines = describeStamp(stamp);
  return lines.length === 0 ? null : lines.join(' · ');
}
