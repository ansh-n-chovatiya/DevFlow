/**
 * The settings one recording was made under, frozen at `START_RECORDING`.
 *
 * Two decisions that are really one thing, and this file is both of them.
 *
 * **Settings are frozen for the duration of a recording.** Changing the body
 * cap halfway through produces a flow whose first ten steps followed one rule
 * and whose last ten followed another, with nothing recording that. So the
 * moment the user presses Record, the overrides in force are copied to
 * `chrome.storage.local` under `recordingSettings`, and every consumer of a
 * recording-shaping setting reads *that* rather than `load()` until the
 * recording ends. Changes made in the meantime are saved, are shown as saved,
 * and apply to the next recording.
 *
 * **A flow records the settings it was made under.** The same copy is the stamp
 * that travels in `FlowPayload.settings`, is persisted in `flow.json`, and is
 * printed in the walkthrough header. Without it a flow recorded at quality 20
 * with bodies off is indistinguishable from a flow where capture failed, and
 * the reader concludes the latter.
 *
 * One object serves both because they are the same claim: *this is what was in
 * force*. Two objects would be two chances to disagree.
 *
 * ## Sparse, like storage
 *
 * The snapshot holds overrides, never the resolved object — the same rule
 * `index.ts` states for `chrome.storage.sync`, for the same reason plus one. A
 * flow recorded at today's defaults reads as "defaults" rather than as sixteen
 * numbers that happen to match, so the header prints nothing and costs nothing.
 * And a default improved in a later version is not frozen into every flow ever
 * recorded.
 *
 * ## One exception, and it is deliberate
 *
 * `reactCapture` is in the snapshot — a flow says whether component capture was
 * on — but the content script still applies a *change* to it immediately, mid
 * recording, because switching it off purges what has already been collected.
 * "Stop recording this" cannot honestly mean "stop at the next recording" when
 * the data is already on disk. See `applyCaptureSetting` in `content/index.ts`;
 * the asymmetry is on both sides on purpose.
 */

import { getLocal, setLocal } from '../../chrome/storage.js';
import type { Result } from '../../shared/result.js';
import { loadOverrides, modifiedOverrides, resolve } from './index.js';
import {
  RECORDED,
  RENDERED,
  type Overrides,
  type RecordingSettings,
  type RenderSettings,
  type SettingKey,
  type Settings,
} from './fields.js';

/** The local-storage key the snapshot lives under. */
export const RECORDING_SETTINGS_KEY = 'recordingSettings';

/**
 * What a recording freezes: the non-default values of the `recorded` fields.
 *
 * `modifiedOverrides` rather than a derivation of its own — the sparseness rule
 * and the "stamp what the recorder actually used, after the clamp" rule are the
 * same two rules the settings file follows, and two copies of them would be
 * two chances for a stamp and an export of the same machine to disagree.
 */
export function recordedOverrides(settings: Settings): Overrides {
  return modifiedOverrides(settings, RECORDED);
}

/** What a hand-over stamps: the non-default values of the `rendered` fields. */
export function renderedOverrides(settings: Settings): Overrides {
  return modifiedOverrides(settings, RENDERED);
}

/**
 * A stamp, resolved back into the values the recorder used.
 *
 * `resolve` is the only validator, here as everywhere: the snapshot is a stored
 * object, and a stored object can hold anything — a flow.json hand-edited, a
 * key from a build that has since been downgraded, a write that was interrupted.
 * Anything it does not recognise falls back to this build's default.
 */
export function frozen(stamp: Overrides | null | undefined): RecordingSettings {
  return pick(resolve(stamp ?? {}), RECORDED) as RecordingSettings;
}

/** The same, for the keys read when a flow is handed over. */
export function rendered(stamp: Overrides | null | undefined): RenderSettings {
  return pick(resolve(stamp ?? {}), RENDERED) as RenderSettings;
}

function pick(settings: Settings, fields: readonly { key: string }[]): Partial<Settings> {
  const out: Record<string, unknown> = {};
  for (const field of fields) out[field.key] = settings[field.key as SettingKey];
  return out;
}

/** The compiled-in answer, for the window before storage has replied. */
export const RECORDING_DEFAULTS: RecordingSettings = frozen({});

// ── Storage ──────────────────────────────────────────────────────────────────

/**
 * The stamp for the recording about to start.
 *
 * Returned rather than written, because the one caller is already writing
 * `recordingActive: true` and the two have to land in the same batch: a
 * recording that is live for even one capture before its snapshot exists is a
 * recording whose first step followed a different rule from its second.
 */
export async function snapshotForRecording(): Promise<Overrides> {
  return recordedOverrides(resolve(await loadOverrides()));
}

/** The stamp the live recording is running under, or `{}` if there is none. */
export async function readRecordingStamp(): Promise<Overrides> {
  const stored = await getLocal([RECORDING_SETTINGS_KEY]);
  if (!stored.ok) return {};
  const held = stored.value[RECORDING_SETTINGS_KEY];
  // A recording made by a build that predates the snapshot has no key at all,
  // which reads correctly as "the defaults of the build that made it".
  return held && typeof held === 'object' && !Array.isArray(held) ? held : {};
}

/**
 * The frozen settings for the live recording.
 *
 * Every recording-shaping read in the worker and the content script goes
 * through here or through a stamp already in hand. Reading `load()` instead
 * would be the freeze bug: correct on the first step, and wrong on every step
 * after somebody opened Settings.
 */
export async function loadRecordingSettings(): Promise<RecordingSettings> {
  return frozen(await readRecordingStamp());
}

/** Write the snapshot. Callers that are already writing storage inline it. */
export function writeRecordingStamp(stamp: Overrides): Promise<Result<void>> {
  return setLocal({ [RECORDING_SETTINGS_KEY]: stamp });
}
