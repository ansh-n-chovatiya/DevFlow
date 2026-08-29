/**
 * What the export and send dialogs open on.
 *
 * Two different things decide that, and Phase 4's one rule about them is that
 * they must not be collapsed into one:
 *
 *   - **The configured default** — `export.*` in Settings. "This is what I
 *     normally want." It is a standing answer, set once, in a screen the user
 *     went to deliberately.
 *   - **The dialog's memory** — `exportOptions` / `sendOptions` in local
 *     storage. "This is what I did last time." It is set by unticking a box on
 *     the way past, without meaning to state a policy.
 *
 * Both are real and people rely on both. Somebody who turns screenshots off for
 * one enormous flow expects the next export to remember; somebody who goes to
 * Settings and turns them off expects that to take effect even though the
 * dialog has a memory older than the decision.
 *
 * ## The rule
 *
 * The more recent statement of intent wins, per choice.
 *
 * That is decidable because the memory records *what the defaults were when it
 * was made*. If the configured default for a key has moved since, the user has
 * spoken about that key more recently than the dialog did, and the new default
 * wins. If it has not moved, the memory is the only thing anybody has said and
 * it stands.
 *
 * The naive alternatives are both wrong in a way somebody would file:
 *
 *   - *Memory always wins* — changing a setting does nothing for anyone who has
 *     used the dialog once, which is everyone. The switch on the Settings
 *     screen reads as broken, and it is the exact failure named for
 *     `network.summariseBodies`.
 *   - *Default always wins* — the dialog forgets, and the per-export override
 *     the shipped build already had is gone.
 *
 * ## Upgrading
 *
 * A memory written before this existed has no record of what it was made
 * against. It resolves to the memory, which is right: it is that user's last
 * deliberate choice, and the configured default they are being compared to is
 * one they have never seen, let alone changed.
 *
 * Pure — the dialogs read storage and settings and hand the values here.
 */

import type { ExportOptions } from '../../shared/types.js';
import type { ExportFormat } from './formats.js';

/** The four include switches, as both a setting group and a dialog's state. */
export type IncludeKey = keyof ExportOptions;

const INCLUDES: readonly IncludeKey[] = ['images', 'network', 'logs', 'react'];

/**
 * One choice, resolved.
 *
 * `against` is the configured default in force when `remembered` was written.
 * `undefined` for either means "nothing was remembered" and "nothing recorded
 * what it was remembered against" respectively; both fall back, in the
 * direction the header explains.
 */
export function openingValue<T>(configured: T, remembered?: T, against?: T): T {
  if (remembered === undefined) return configured;
  if (against === undefined) return remembered;
  return configured === against ? remembered : configured;
}

/** Every include switch, resolved the same way. */
export function openingOptions(
  configured: ExportOptions,
  remembered?: Partial<ExportOptions>,
  against?: Partial<ExportOptions>,
): ExportOptions {
  const out = {} as Record<IncludeKey, boolean>;
  for (const key of INCLUDES) {
    out[key] = openingValue(configured[key], remembered?.[key], against?.[key]);
  }
  return out;
}

/**
 * The configured defaults for the export dialog, read off resolved settings.
 *
 * The two dialogs answer the same four questions and keep separate answers,
 * because a ZIP on disk costs nothing to over-pack and a flow in a model's
 * context costs tokens. `export.send*` is that second set.
 */
export function exportDefaults(settings: {
  'export.images': boolean;
  'export.network': boolean;
  'export.logs': boolean;
  'export.react': boolean;
}): ExportOptions {
  return {
    images: settings['export.images'],
    network: settings['export.network'],
    logs: settings['export.logs'],
    react: settings['export.react'],
  };
}

/** The same, for "Send to Claude". */
export function sendDefaults(settings: {
  'export.sendImages': boolean;
  'export.sendNetwork': boolean;
  'export.sendLogs': boolean;
  'export.sendReact': boolean;
}): ExportOptions {
  return {
    images: settings['export.sendImages'],
    network: settings['export.sendNetwork'],
    logs: settings['export.sendLogs'],
    react: settings['export.sendReact'],
  };
}

/** The format the export dialog opens on, already clamped by `resolve`. */
export function exportFormat(settings: { 'export.format': string }): ExportFormat {
  return settings['export.format'] as ExportFormat;
}
