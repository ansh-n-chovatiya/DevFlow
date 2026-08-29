// @vitest-environment jsdom
/**
 * A flow records the settings it was made under.
 *
 * This is the single most important part
 * in the plan, and the reason is a failure mode rather than a feature: *a flow
 * recorded at quality 20 with bodies off is indistinguishable from a flow where
 * capture failed, and the reader will conclude the latter.* Everything below is
 * about that sentence.
 *
 * The stamp has to be four things at once, and each of them is a test here:
 *
 *   - **Sparse.** A flow recorded at the defaults says nothing, so the header
 *     costs nothing and "this recording was unusual" stays a signal.
 *   - **Legible.** The header names the setting and the default beside it,
 *     because `quality 20` means nothing to a reader who does not know 60 is
 *     normal — and knowing it is the whole difference between "made small
 *     deliberately" and "something is wrong with this".
 *   - **Honest across versions.** A key this build cannot name is printed raw
 *     rather than dropped, because `npx -y flowsnap-mcp` makes "an older server
 *     reading a newer flow" ordinary rather than exotic.
 *   - **Present wherever the flow is.** The payload, the walkthrough header,
 *     `flow.json`, and the ZIP.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';
import { describeStamp, showValue, stampHeadline } from '../src/features/settings/stamp.js';
import { buildPayload, bodyLimits } from '../src/features/mcp/send.js';
import { exportToMarkdown } from '../src/core/export/markdown.js';
import { exportToJSON } from '../src/core/export/json.js';
import { compactBody } from '../src/core/schema/index.js';
import { RECORDED, RENDERED, STAMPED } from '../src/features/settings/fields.js';
import type { Step } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

function step(overrides: Partial<Step> = {}): Step {
  return {
    type: 'click',
    url: 'https://shop.example.com/cart',
    timestamp: NOW,
    action: 'Clicked "Checkout"',
    element: { tag: 'button', cssSelector: '#checkout', xpath: '/button', boundingBox: null },
    ...overrides,
  } as Step;
}

describe('what a stamp says', () => {
  it('says nothing at all for a recording made at the defaults', () => {
    expect(describeStamp({})).toEqual([]);
    expect(describeStamp(null)).toEqual([]);
    expect(stampHeadline({})).toBeNull();
  });

  it('names the setting, the value and the default it is not', () => {
    expect(describeStamp({ 'screenshots.quality': 20 })).toEqual([
      'Screenshot quality: 20 (default 60)',
    ]);
  });

  it('reads switches as on and off rather than as true and false', () => {
    expect(describeStamp({ 'screenshots.capture': false })).toEqual([
      'Capture screenshots: off (default on)',
    ]);
    expect(showValue(true)).toBe('on');
    expect(showValue([])).toBe('none');
    expect(showValue(['error', 'warn'])).toBe('error, warn');
  });

  it('prints in table order, so two identical recordings read identically', () => {
    const one = describeStamp({ 'network.bodyCap': 1024, 'screenshots.quality': 20 });
    const other = describeStamp({ 'screenshots.quality': 20, 'network.bodyCap': 1024 });

    expect(one).toEqual(other);
    // Screenshots come before network in `fields.ts`, and the object's own key
    // order — which is whatever order the user happened to change things in —
    // must not be what a reader sees.
    expect(one[0]).toContain('Screenshot quality');
  });

  it('prints a key from a newer FlowSnap rather than dropping it', () => {
    /*
     * The situation this exists for: the extension updates, the MCP server does
     * not — `npx -y flowsnap-mcp` resolves to whatever npm has cached. Dropping
     * the key would render a flow made under an unusual setting as one made at
     * the defaults, which is the exact wrong answer this whole mechanism is for.
     */
    const lines = describeStamp({ 'screenshots.quality': 20, 'capture.somethingNew': false });

    expect(lines).toContain('Screenshot quality: 20 (default 60)');
    expect(lines).toContain('capture.somethingNew: off');
  });
});

describe('which settings a flow stamps', () => {
  it('splits capture from hand-over, and every stamped key is one or the other', () => {
    // The distinction is not pedantry: freezing `network.summariseBodies` at
    // record time would mean somebody who turns summarising off to read the raw
    // bytes of yesterday's flow gets the summary anyway, forever.
    const recorded = RECORDED.map((field) => field.key);
    const rendered = RENDERED.map((field) => field.key);

    expect(recorded).toContain('screenshots.quality');
    expect(rendered).toContain('network.summariseBodies');
    expect(recorded.filter((key) => rendered.includes(key))).toEqual([]);
    expect(STAMPED.map((field) => field.key).sort()).toEqual(
      [...recorded, ...rendered].sort(),
    );
  });

  it('stamps every setting that can make a recording look broken', () => {
    // The rows this phase wired, minus the ones that shape nothing a reader
    // of a flow can see. If a later phase wires a capture-shaping setting and
    // forgets the flag, this is the list that notices.
    const keys = STAMPED.map((field) => field.key);

    for (const key of [
      'screenshots.capture',
      'screenshots.quality',
      'network.captureBodies',
      'network.bodyCap',
      'console.levels',
      'console.captureUncaught',
      'recording.maxSteps',
      'recording.domDelta',
      'recording.trailingStep',
      'network.summariseBodies',
      'network.schemaThreshold',
    ]) {
      expect(keys).toContain(key);
    }
  });
});

describe('the payload carries it', () => {
  it('is absent when the flow was recorded and rendered at the defaults', () => {
    const payload = buildPayload('flow-1', 'Checkout', [step()], NOW);
    expect('settings' in payload).toBe(false);
  });

  it('is present, verbatim, when it is not', () => {
    const stamp = { 'screenshots.capture': false, 'network.bodyCap': 1024 };
    const payload = buildPayload('flow-1', 'Checkout', [step()], NOW, null, undefined, stamp);

    expect(payload.settings).toEqual(stamp);
  });

  it('renders the bodies under the rules the stamp names', () => {
    const big = JSON.stringify({ rows: Array.from({ length: 400 }, (_, i) => ({ id: i })) });

    // Summarised by default — this is what a flow normally carries.
    expect(compactBody(big)).toContain('[schema —');

    // And not, when the flow says the sender wanted the bytes. A setting that
    // could be turned off and still summarise is a setting that does nothing.
    const verbatim = compactBody(big, undefined, bodyLimits({ 'network.summariseBodies': false }));
    expect(verbatim).toBe(big);
  });

  it('still stamps a truncated body when summarising is off', () => {
    // Nothing may make a recording silently worse. Handing over the bytes
    // must not also hand over a body cut at the capture limit that reads as a
    // complete one.
    const out = compactBody(
      '{"rows":[{"id":1}',
      { truncated: true, bytes: 51_200 },
      { summarise: false },
    );

    expect(out).toContain('{"rows":[{"id":1}');
    expect(out).toContain('truncated at capture');
  });
});

describe('the documents carry it', () => {
  it('puts the header in the Markdown, above the first step', () => {
    const md = exportToMarkdown([step()], {
      title: 'Checkout',
      images: false,
      settings: describeStamp({ 'screenshots.capture': false }),
    });

    const header = md.indexOf('Recorded with non-default settings');
    const first = md.indexOf('### 1.');

    expect(header).toBeGreaterThan(-1);
    expect(md).toContain('Capture screenshots: off (default on)');
    expect(header).toBeLessThan(first);
  });

  it('leaves the header out entirely for an ordinary recording', () => {
    const md = exportToMarkdown([step()], { title: 'Checkout', images: false });
    expect(md).not.toContain('non-default settings');
  });

  it('puts the object in the JSON, which is the file a tool reads', () => {
    const stamp = { 'screenshots.capture': false };
    const json = JSON.parse(
      exportToJSON([step()], { title: 'Checkout', images: false, settings: stamp }),
    ) as { settings?: Record<string, unknown> };

    expect(json.settings).toEqual(stamp);
  });

  it('leaves it out of the JSON when there is nothing to say', () => {
    const json = JSON.parse(exportToJSON([step()], { title: 'Checkout' })) as Record<string, unknown>;
    expect('settings' in json).toBe(false);
  });
});

describe('a step with no picture says which kind of no picture it is', () => {
  it('prints the reason where the image would have been', () => {
    const md = exportToMarkdown(
      [
        step({
          screenshot: null,
          screenshotOmitted: 'Screenshots are switched off in FlowSnap settings for this recording.',
        }),
      ],
      { title: 'Checkout' },
    );

    expect(md).toContain('🚫 no screenshot');
    expect(md).toContain('switched off in FlowSnap settings');
  });

  it('says nothing for a step whose image was simply left out of this export', () => {
    // `images: false` is the sender's choice about this document, not a fact
    // about the recording, and `omitted` already reports it once at the top.
    const md = exportToMarkdown([step({ screenshot: 'data:image/jpeg;base64,x' })], {
      title: 'Checkout',
      images: false,
    });

    expect(md).not.toContain('no screenshot');
  });
});

/**
 * The render-time half of the stamp reaches the *file* export too.
 *
 * This is the gap the phase's delivery audit found, and it is worth a test
 * rather than a fix alone: the send path merged the render-time settings and
 * the download path did not, so `network.summariseBodies` worked when a flow
 * went to Claude and silently did nothing when the same flow was saved as a
 * ZIP. Two exports of one recording, disagreeing about what a body is, with the
 * setting reading "off" on the Settings screen throughout.
 */
describe('an export renders under the settings in force when it is made', () => {
  let chromeFake: SyncFake;
  let downloaded: Blob[];

  beforeEach(() => {
    chromeFake = installChromeSync();
    downloaded = [];
    globalThis.URL.createObjectURL = (blob: Blob | MediaSource) => {
      downloaded.push(blob as Blob);
      return 'blob:mock';
    };
    globalThis.URL.revokeObjectURL = () => undefined;
  });

  afterEach(() => {
    chromeFake.restore();
  });

  it('stamps the render-time keys the caller could not know', async () => {
    const { save } = await import('../src/features/settings/index.js');
    const { exportFlow } = await import('../src/features/export/download.js');

    await save({ 'network.summariseBodies': false });

    await exportFlow({
      steps: [step({ screenshot: null })],
      title: 'Checkout',
      format: 'json',
      options: { images: false, network: true, logs: true, react: false },
      filename: 'flow',
      // What a caller hands over: the recording's frozen half only.
      settings: { 'screenshots.quality': 35 },
    });

    const json = JSON.parse(await downloaded[0].text()) as {
      settings?: Record<string, unknown>;
    };

    // Both halves, in one object, describing the file in the reader's hands.
    expect(json.settings).toEqual({
      'screenshots.quality': 35,
      'network.summariseBodies': false,
    });
  });
});
