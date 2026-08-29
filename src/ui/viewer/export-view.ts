/**
 * What the export dialog should show, derived from the flow and the choices.
 *
 * Structural decision B: three toolbar buttons that were the same export in
 * three file formats, three permanently-visible include checkboxes and a bare
 * filename prompt collapse into one dialog. The thing that makes the dialog
 * worth having rather than a shorter menu is the size estimate — the reason
 * someone picked ZIP over Markdown was previously guesswork.
 *
 * Pure — see tests/export-view.test.ts.
 */

import { defaultFilename, sanitizeFilename } from '../../core/flow/index.js';
import { pruneComponents } from '../../core/react/attribution.js';
import { EXTENSION, FORMAT_NAME, type ExportFormat } from '../../features/export/formats.js';
import type { ExportOptions, FlowReact, Step } from '../../shared/types.js';
import type { IconName } from '../icons.js';

export type { ExportFormat };

export interface ExportInput {
  steps: Step[];
  format: ExportFormat;
  options: ExportOptions;
  /** The flow's component table, so the React row can price itself. */
  react?: FlowReact;
  /** What the user has typed, before sanitising. */
  filename: string;
  /** True while the export is being built. */
  busy: boolean;
  /** Which step is being packaged, for the progress caption. */
  progress: { done: number; total: number } | null;
}

export interface FormatCard {
  id: ExportFormat;
  name: string;
  icon: IconName;
  description: string;
  bytes: number;
  selected: boolean;
  recommended: boolean;
}

export interface IncludeRow {
  id: keyof ExportOptions;
  label: string;
  checked: boolean;
  bytes: number;
  /**
   * Set when the chosen format ignores this content entirely, with the reason.
   * The alternative is a checkbox that changes nothing and a total that does not
   * move — which is how a user learns to distrust the numbers.
   */
  ignored: string | null;
}

export interface ExportView {
  formats: FormatCard[];
  includes: IncludeRow[];
  total: number;
  extension: string;
  /** Sanitised — what the file will actually be called. */
  filename: string;
  /** Bodies are not redacted, and this is the moment that matters. */
  warnBodies: boolean;
  canExport: boolean;
  busy: boolean;
  /** `Compressing screenshot 12 of 18`, or `null` when nothing is running. */
  caption: string | null;
}

/**
 * Bytes behind a base64 payload.
 *
 * A data URL is `data:image/jpeg;base64,` plus four characters per three bytes,
 * so the decoded size — which is what a ZIP entry costs — is three quarters of
 * the tail. Markdown embeds the data URL as text and pays the full length.
 */
function decodedBytes(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return 0;

  const payload = dataUrl.length - comma - 1;
  const padding = dataUrl.endsWith('==') ? 2 : dataUrl.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((payload * 3) / 4) - padding);
}

export interface Parts {
  /** The step text itself: actions, URLs, selectors, notes. */
  base: number;
  /** Screenshots, as they cost in a ZIP. */
  screenshots: number;
  /** Screenshots, as they cost embedded in Markdown. */
  screenshotsInline: number;
  network: number;
  logs: number;
  /**
   * Component ids on the steps plus the table they index into.
   *
   * Counted apart from `base` even though the ids live inside the step objects,
   * because a checkbox whose total never moves is one users learn to distrust —
   * the same reason the ignored-format note exists.
   */
  react: number;
}

/**
 * What each part of the flow weighs.
 *
 * Measured off the real payload rather than guessed from a per-step constant,
 * because the whole point of the number is to explain why one flow is 400 KB and
 * the next is 8 MB. It is still an estimate: the exporters compact bodies and
 * ZIP deflates the text, so the figure shown is an upper bound on everything
 * except the images, which are already compressed and pass through as they are.
 */
export function measure(steps: Step[], react?: FlowReact): Parts {
  let base = 0;
  let screenshots = 0;
  let screenshotsInline = 0;
  let network = 0;
  let logs = 0;
  // The table, pruned the way every exporter prunes it, so the figure is what
  // this flow would actually write rather than what the recording holds.
  let reactBytes = react
    ? JSON.stringify({ ...react, components: pruneComponents(steps, react.components) }).length
    : 0;

  for (const step of steps) {
    const { screenshot, screenshotOriginal, networkCalls, consoleLogs, ...rest } = step;
    void screenshotOriginal;

    if (rest.element?.react) {
      const refBytes = JSON.stringify(rest.element.react).length;
      reactBytes += refBytes;
      // Charged to React, not to the step text it is nested inside — otherwise
      // switching React off would leave `base` overstating what is left.
      base += JSON.stringify(rest).length - refBytes;
    } else {
      base += JSON.stringify(rest).length;
    }

    if (screenshot) {
      screenshots += decodedBytes(screenshot);
      screenshotsInline += screenshot.length;
    }
    if (networkCalls?.length) network += JSON.stringify(networkCalls).length;
    if (consoleLogs?.length) logs += JSON.stringify(consoleLogs).length;
  }

  return { base, screenshots, screenshotsInline, network, logs, react: reactBytes };
}

/**
 * Which parts a format actually writes.
 *
 * JSON never carries image data — `exportToJSON` writes a placeholder unless the
 * ZIP hands it filenames — so the Screenshots checkbox genuinely does nothing
 * there, and the dialog says so rather than pretending.
 */
function bytesFor(parts: Parts, format: ExportFormat, options: ExportOptions): number {
  const network = options.network ? parts.network : 0;
  const logs = options.logs ? parts.logs : 0;
  const react = options.react ? parts.react : 0;

  switch (format) {
    case 'zip':
      // Markdown and JSON both go in the archive, so the text is counted twice.
      return (parts.base + react) * 2 + network + logs + (options.images ? parts.screenshots : 0);
    case 'markdown':
      return parts.base + react + network + logs + (options.images ? parts.screenshotsInline : 0);
    case 'json':
      return parts.base + react + network + logs;
  }
}

const DESCRIPTION: Record<ExportFormat, string> = {
  zip: 'Markdown, JSON and screenshot files. Best for Claude — attach the folder.',
  markdown: 'One file, screenshots embedded. Readable anywhere.',
  json: 'Full selectors and timings. For replay and tooling.',
};

const FORMAT_ICON: Record<ExportFormat, IconName> = {
  zip: 'file-archive',
  markdown: 'file-text',
  json: 'braces',
};

/**
 * Said when the flow has no components to offer, in both dialogs.
 *
 * Short on purpose: it shares a row with the longest label of the four, so a
 * sentence here is one that gets truncated.
 */
export const NO_REACT_NOTE = 'None in this flow';

/** Shared with the send dialog, so one part is never named two things. */
export const INCLUDE_LABEL: Record<keyof ExportOptions, string> = {
  images: 'Screenshots',
  network: 'Network calls',
  logs: 'Console logs',
  react: 'React components & source',
};

/**
 * What this dialog is doing differently from the configured defaults, in words.
 *
 * `null` when nothing differs, which is the ordinary case and draws nothing.
 *
 * The point of saying it at all is that the dialog's memory and the Settings
 * default are two different things — see `features/export/defaults.ts` — and a
 * user whose dialog remembers a deviation they made three weeks ago has no way
 * to know that is what they are looking at. It is also where the way back
 * lives: the banner carries the action that puts the defaults back.
 *
 * Deliberately lists *what* differs rather than counting. "2 settings differ" is
 * a number somebody has to take on trust, and the one that matters is always
 * the one they had forgotten about — the same argument that is made for the import
 * diff.
 */
export function driftFromDefaults(
  options: ExportOptions,
  configured: ExportOptions,
  format?: { chosen: ExportFormat; configured: ExportFormat },
): string | null {
  const parts: string[] = [];

  if (format && format.chosen !== format.configured) {
    parts.push(`${FORMAT_NAME[format.chosen]} rather than ${FORMAT_NAME[format.configured]}`);
  }

  for (const key of ['images', 'network', 'logs', 'react'] as const) {
    if (options[key] === configured[key]) continue;
    parts.push(`${INCLUDE_LABEL[key].toLowerCase()} ${options[key] ? 'on' : 'off'}`);
  }

  return parts.length === 0 ? null : `Not your defaults: ${parts.join(', ')}.`;
}

export function deriveExportView(input: ExportInput): ExportView {
  const { steps, format, options, busy, progress } = input;
  const parts = measure(steps, input.react);

  const formats: FormatCard[] = (['zip', 'markdown', 'json'] as const).map((id) => ({
    id,
    name: FORMAT_NAME[id],
    icon: FORMAT_ICON[id],
    description: DESCRIPTION[id],
    bytes: bytesFor(parts, id, options),
    selected: id === format,
    recommended: id === 'zip',
  }));

  const includes: IncludeRow[] = [
    {
      id: 'images',
      label: INCLUDE_LABEL.images,
      checked: options.images,
      bytes: format === 'markdown' ? parts.screenshotsInline : parts.screenshots,
      ignored:
        format === 'json' ? 'JSON records the step data; images ship with the ZIP.' : null,
    },
    {
      id: 'network',
      label: INCLUDE_LABEL.network,
      checked: options.network,
      bytes: parts.network,
      ignored: null,
    },
    {
      id: 'logs',
      label: INCLUDE_LABEL.logs,
      checked: options.logs,
      bytes: parts.logs,
      ignored: null,
    },
    {
      id: 'react',
      label: INCLUDE_LABEL.react,
      checked: options.react,
      bytes: parts.react,
      // Said here rather than by hiding the row: a switch that vanishes on some
      // flows is one nobody can find when they want it, and "this page was not
      // React" is a fact about the recording worth reading.
      ignored: parts.react === 0 ? NO_REACT_NOTE : null,
    },
  ];

  const name = sanitizeFilename(input.filename.trim() || defaultFilename());

  return {
    formats,
    includes,
    total: bytesFor(parts, format, options),
    extension: EXTENSION[format],
    filename: name,
    // Headers are redacted at capture; bodies are not. Saying so belongs at the
    // moment the bodies are about to leave the machine, not in a settings page
    // nobody opened.
    warnBodies: options.network && parts.network > 0,
    canExport: steps.length > 0 && !busy,
    busy,
    caption:
      progress === null
        ? null
        : `Packaging screenshot ${progress.done} of ${progress.total}`,
  };
}
