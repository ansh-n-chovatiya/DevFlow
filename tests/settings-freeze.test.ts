/**
 * A recording is frozen.
 *
 * One of the things that has to be tested, and why: changing the body cap
 * halfway through produces a
 * flow whose first ten steps followed one rule and whose last ten followed
 * another, with nothing recording that. The flow is then not wrong in any way a
 * reader can see, which is the worst kind of wrong a recording can be.
 *
 * The claim has two halves and both are here:
 *
 *   - **Internally consistent.** Every consumer that shapes a capture reads the
 *     same answer for the last step as it did for the first, however many times
 *     the user opened Settings in between.
 *   - **The stamp reflects what was actually used.** Not what is in force when
 *     the flow is sent, and not what the user typed at any point in the middle.
 *
 * Against real storage, not a mock. The freeze is a claim about two storage
 * areas — the overrides in `sync`, the snapshot in `local` — and a fake that
 * answers with a fixed object could not tell the difference between a value
 * that was frozen and one that never changed.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';
import { CONSOLE_LEVELS, SCREENSHOT_QUALITY } from '../src/shared/constants.js';
import type * as SettingsModule from '../src/features/settings/index.js';
import type * as RecordingModule from '../src/features/settings/recording.js';

let chromeFake: SyncFake;

/*
 * Imported inside the tests, after `installChromeSync` has run.
 *
 * Both modules reach for `chrome.storage` the moment they are called, and a
 * top-level import would bind them to whatever global was in place when the
 * file was loaded — which is exactly the module-scope bug the mechanism is
 * written against, reproduced in the test that is supposed to catch it.
 */
async function settings(): Promise<typeof SettingsModule> {
  return import('../src/features/settings/index.js');
}

async function recording(): Promise<typeof RecordingModule> {
  return import('../src/features/settings/recording.js');
}

/** What the popup does when Record is pressed: snapshot, then go live. */
async function startRecording(): Promise<void> {
  const { snapshotForRecording, RECORDING_SETTINGS_KEY } = await recording();
  const stamp = await snapshotForRecording();
  chromeFake.seedLocal({ recordingActive: true, [RECORDING_SETTINGS_KEY]: stamp });
}

beforeEach(() => {
  chromeFake = installChromeSync();
});

afterEach(() => {
  chromeFake.restore();
});

describe('settings are frozen for the duration of a recording', () => {
  it('keeps the value the recording started with, however the live one moves', async () => {
    const { save, load } = await settings();
    const { loadRecordingSettings } = await recording();

    await save({ 'screenshots.quality': 35, 'network.bodyCap': 1024 });
    await startRecording();

    // The user opens Settings mid-recording and changes their mind. The write
    // succeeds — nothing is disabled, only deferred.
    await save({ 'screenshots.quality': 90, 'network.bodyCap': 4096 });

    const live = await load();
    expect(live['screenshots.quality']).toBe(90);
    expect(live['network.bodyCap']).toBe(4096);

    const frozen = await loadRecordingSettings();
    expect(frozen['screenshots.quality']).toBe(35);
    expect(frozen['network.bodyCap']).toBe(1024);
  });

  it('is internally consistent: the last step reads what the first step read', async () => {
    const { save } = await settings();
    const { loadRecordingSettings } = await recording();

    await save({ 'recording.inputDebounceMs': 200 });
    await startRecording();

    const first = await loadRecordingSettings();

    // Four changes, of the kind somebody fiddling with the form makes.
    for (const ms of [400, 900, 1500, 3000]) await save({ 'recording.inputDebounceMs': ms });

    const last = await loadRecordingSettings();

    expect(last).toEqual(first);
    expect(last['recording.inputDebounceMs']).toBe(200);
  });

  it('applies the change to the next recording, which is the whole promise', async () => {
    const { save } = await settings();
    const { loadRecordingSettings } = await recording();

    await save({ 'screenshots.quality': 35 });
    await startRecording();
    await save({ 'screenshots.quality': 90 });
    expect((await loadRecordingSettings())['screenshots.quality']).toBe(35);

    // Stop, start again. Nothing else changes.
    await startRecording();
    expect((await loadRecordingSettings())['screenshots.quality']).toBe(90);
  });

  it('freezes what the MAIN-world agent is told, not just what the worker reads', async () => {
    const { save } = await settings();
    const { loadRecordingSettings } = await recording();
    const { toAgentConfig } = await import('../src/features/settings/agent.js');

    await save({ 'network.bodyCap': 2048, 'console.levels': ['error'] });
    await startRecording();
    await save({ 'network.bodyCap': 999_999, 'console.levels': [...CONSOLE_LEVELS] });

    /*
     * The agent is the consumer most likely to break this rule, because it is
     * the only one that is *pushed* to rather than reading for itself — and the
     * content script pushes on every settings change. If that push carried live
     * values, the worker's half of the recording would be frozen and the page's
     * half would not: one flow, two rules, and the stamp describing only one.
     */
    const config = toAgentConfig(await loadRecordingSettings());
    expect(config.bodyCap).toBe(2048);
    expect(config.consoleLevels).toEqual(['error']);
  });

  it('resolves the snapshot rather than trusting it', async () => {
    const { RECORDING_SETTINGS_KEY, loadRecordingSettings } = await recording();

    // A hand-edited profile, a value from a build with a wider range, a write
    // that landed half-way. `resolve()` is the only validator, here too.
    chromeFake.seedLocal({
      [RECORDING_SETTINGS_KEY]: {
        'screenshots.quality': 100_000,
        'recording.maxSteps': 'lots',
        'console.levels': 'error',
        'nothing.known': 7,
      },
    });

    const frozen = await loadRecordingSettings();
    expect(frozen['screenshots.quality']).toBe(100);
    expect(frozen['recording.maxSteps']).toBe(500);
    expect(frozen['console.levels']).toEqual(CONSOLE_LEVELS);
    expect('nothing.known' in frozen).toBe(false);
  });

  it('reads as the defaults when a recording predates snapshots entirely', async () => {
    const { loadRecordingSettings } = await recording();

    // No `recordingSettings` key at all: a flow started by an older build, or
    // the very first read after an update. The honest answer is the shipped
    // defaults, not a crash and not an empty object handed to the recorder.
    const frozen = await loadRecordingSettings();
    expect(frozen['screenshots.quality']).toBe(SCREENSHOT_QUALITY);
    expect(frozen['screenshots.capture']).toBe(true);
  });
});

describe('the stamp reflects what was actually used', () => {
  it('holds only what was changed, and holds it as the recorder saw it', async () => {
    const { save } = await settings();
    const { snapshotForRecording } = await recording();

    // 9,000 is over `recording.maxSteps`' maximum, so the recorder used 5,000.
    // A stamp saying 9,000 would describe a recording that never happened.
    chromeFake.seed({ 'recording.maxSteps': 9000 });
    await save({ 'screenshots.quality': 35 });

    const stamp = await snapshotForRecording();

    expect(stamp).toEqual({ 'recording.maxSteps': 5000, 'screenshots.quality': 35 });
  });

  it('is empty for a recording made at the defaults', async () => {
    const { snapshotForRecording } = await recording();
    expect(await snapshotForRecording()).toEqual({});
  });

  it('does not move when the live settings do', async () => {
    const { save } = await settings();
    const { readRecordingStamp } = await recording();

    await save({ 'screenshots.capture': false });
    await startRecording();
    await save({ 'screenshots.capture': true });

    // The flow still has no pictures. Anything else here is a stamp that says a
    // recording was made under settings it was not, which is worse than none.
    expect(await readRecordingStamp()).toEqual({ 'screenshots.capture': false });
  });

  it('survives the recording ending, because archiving happens afterwards', async () => {
    const { save } = await settings();
    const { readRecordingStamp, RECORDING_SETTINGS_KEY } = await recording();

    await save({ 'network.captureBodies': false });
    await startRecording();
    // Stop writes `recordingActive: false` and nothing else — the snapshot is
    // deliberately left behind, because the user archives or sends the flow
    // from the review tab minutes later and the stamp has to still be there.
    chromeFake.seedLocal({ recordingActive: false });

    expect(await readRecordingStamp()).toEqual({ 'network.captureBodies': false });
    expect(chromeFake.local()[RECORDING_SETTINGS_KEY]).toBeDefined();
  });

  it('carries the settings that are frozen and not the ones that are not', async () => {
    const { save } = await settings();
    const { snapshotForRecording } = await recording();

    // `theme` shapes nothing about a recording, and `network.summariseBodies` is
    // applied when a flow is handed over rather than when it is captured — so
    // neither belongs in the freeze. Both are stamped or not by the rules in
    // `fields.ts`, which is the only place that decision lives.
    await save({ theme: 'dark', 'network.summariseBodies': false, 'screenshots.quality': 35 });

    expect(await snapshotForRecording()).toEqual({ 'screenshots.quality': 35 });
  });
});
