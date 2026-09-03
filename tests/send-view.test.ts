/**
 * What the send dialog promises before the POST leaves.
 *
 * Two numbers and three switches, and the numbers are the whole reason the
 * dialog exists — a switch that does not move the total is a switch nobody
 * believes. `pruneSteps` is here rather than in mcp-payload.test.ts because the
 * dialog's arithmetic and the payload's contents have to agree: what the total
 * drops, the wire must actually stop carrying.
 */

import { describe, expect, it } from 'vitest';
import { pruneSteps, SEND_EVERYTHING } from '../src/features/mcp/send.js';
import { VISION_TOKENS_PER_IMAGE } from '../src/shared/constants.js';
import type {
  ConsoleEntry,
  ExportOptions,
  FlowReact,
  NetworkCall,
  Step,
} from '../src/shared/types.js';
import { deriveSendView, SEND_DEFAULTS, type SendProbe } from '../src/ui/viewer/send-view.js';
import { pos1 } from '../src/core/locate/positions.js';

const NOW = 1_700_000_000_000;

/** A 600-character data URL, long enough that dropping it is visible. */
const IMAGE = `data:image/jpeg;base64,${'A'.repeat(600)}`;

function call(over: Partial<NetworkCall> = {}): NetworkCall {
  return {
    method: 'POST',
    url: 'https://api.example.com/checkout',
    requestHeaders: { 'content-type': 'application/json' },
    requestBody: JSON.stringify({ card: '4242424242424242' }),
    status: 500,
    responseHeaders: {},
    responseBody: 'internal error',
    durationMs: 120,
    timestamp: NOW,
    ...over,
  };
}

function log(over: Partial<ConsoleEntry> = {}): ConsoleEntry {
  return { level: 'error', args: ['payment failed'], timestamp: NOW, ...over };
}

function step(over: Partial<Step> = {}): Step {
  return {
    type: 'click',
    url: 'https://shop.example.com/cart',
    timestamp: NOW,
    action: 'Clicked "Buy"',
    element: { tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null },
    ...over,
  } as Step;
}

const LOADED = [
  step({ screenshot: IMAGE, networkCalls: [call()], consoleLogs: [log()] }),
  step({ screenshot: IMAGE, networkCalls: [call()], consoleLogs: [log()] }),
];

const ALL: ExportOptions = { images: true, network: true, logs: true, react: true };
const NONE: ExportOptions = { images: false, network: false, logs: false, react: false };

/** The same flow, recorded on a React page that resolved to a real file. */
const REACT_TABLE: FlowReact = {
  detected: true,
  components: {
    a1b2c3d4: {
      name: 'CheckoutButton',
      status: 'resolved',
      source: 'src/components/checkout/CheckoutButton.tsx',
      line: pos1(42),
    },
  },
};

const REACT_LOADED = LOADED.map((one) => ({
  ...one,
  element: { ...one.element, react: { chain: ['a1b2c3d4'] } },
})) as Step[];

function view(options: ExportOptions, steps = LOADED, busy = false, react?: FlowReact) {
  return deriveSendView({ steps, options, react, busy });
}

describe('the default', () => {
  /**
   * The reason the dialog exists is that sending took everything. Keeping the
   * two text parts off by default is most of the fix: a screenshot is written
   * to disk and read on demand, while network bodies and console logs are read
   * back with every step and are what actually fills the context.
   */
  it('keeps screenshots and leaves the parts that cost context switched off', () => {
    expect(SEND_DEFAULTS).toEqual({ images: true, network: false, logs: false, react: true });
  });

  it('costs less context than sending everything, on the same flow', () => {
    expect(view(SEND_DEFAULTS).context).toBeLessThan(view(ALL).context);
  });

  it('still shows what switching them on would cost, so the choice is informed', () => {
    const rows = view(SEND_DEFAULTS).includes;
    expect(rows[1].bytes).toBeGreaterThan(0);
    expect(rows[2].bytes).toBeGreaterThan(0);
  });

  it('says nothing about unredacted bodies, because none are going', () => {
    expect(view(SEND_DEFAULTS).warnBodies).toBe(false);
  });
});

describe('the upload total', () => {
  it('falls when a part is switched off, so the switch is worth pressing', () => {
    expect(view({ ...ALL, images: false }).total).toBeLessThan(view(ALL).total);
    expect(view({ ...ALL, network: false }).total).toBeLessThan(view(ALL).total);
    expect(view({ ...ALL, logs: false }).total).toBeLessThan(view(ALL).total);
  });

  it('counts screenshots at their full data-URL length, which is what is POSTed', () => {
    const withImages = view(ALL).total;
    const without = view({ ...ALL, images: false }).total;
    expect(withImages - without).toBe(IMAGE.length * 2);
  });

  it('still reports the step text when everything optional is off', () => {
    expect(view(NONE).total).toBeGreaterThan(0);
  });
});

describe('the context estimate', () => {
  /*
   * It is the walkthrough, rendered. `deriveSendView` runs the send's own
   * pipeline — prune, attribute, compact, render — and measures the document
   * `get_flow` will return, rather than adding up the JSON that produced it.
   *
   * These cases are about the two ways the old arithmetic lied. A switch that
   * changes what Claude reads has to move this number, and a switch that
   * changes it a lot less than the upload has to move it a lot less: those are
   * the two halves of a figure anybody believes.
   */
  it('charges a screenshot for its path, not for its bytes and not for nothing', () => {
    const on = view(ALL).context;
    const off = view({ ...ALL, images: false }).context;

    /*
     * It used to be exactly equal, on the grounds that an image costs nothing
     * until it is opened. True of the image; false of the line naming it. The
     * one switch that changes a send by megabytes moved the token figure by
     * zero, which is how a user learns a number is decorative.
     */
    expect(off).toBeLessThan(on);

    // And nowhere near the data URL: two paths, not two base64 images. The
    // whole point of writing them to disk is that this stays small.
    expect(on - off).toBeLessThan(IMAGE.length);
  });

  it('falls with the parts that are read alongside the steps', () => {
    expect(view({ ...ALL, network: false }).context).toBeLessThan(view(ALL).context);
    expect(view({ ...ALL, logs: false }).context).toBeLessThan(view(ALL).context);
  });

  /**
   * The reason the estimate is rendered rather than summed. `leanCalls` turns a
   * response body into its schema and drops every header before anything is
   * sent — the change that took a 15-step recording from 93k tokens to 9k — so
   * counting the raw call JSON priced the send at the number that change exists
   * to avoid.
   */
  it('prices network at what compaction leaves, not at what was captured', () => {
    const network = view(ALL).context - view({ ...ALL, network: false }).context;
    const captured = view(ALL).includes.find((row) => row.id === 'network')!.bytes;

    expect(network).toBeGreaterThan(0);
    expect(network).toBeLessThan(captured);
  });

  /*
   * The half of the cost the estimate cannot see, and used not to mention.
   *
   * A screenshot is a path in the walkthrough — about fifty characters — and a
   * picture on disk worth around fifteen hundred tokens when it is opened. So
   * `context` alone described a nine-shot send as a few hundred tokens while it
   * was really handing over something nearer fourteen thousand, and the switch
   * that dominates what a send costs was the one the cost line was blind to.
   *
   * Two numbers rather than one sum, because they are not the same promise: the
   * walkthrough is paid the moment the flow is read, an image only if it is
   * opened.
   */
  it('names what the images would cost, which the walkthrough cannot', () => {
    const vision = view(ALL).vision;

    expect(vision).not.toBeNull();
    expect(vision!.images).toBe(2);
    expect(vision!.tokens).toBe(2 * VISION_TOKENS_PER_IMAGE);
  });

  it('dwarfs the text, which is the whole reason it is shown', () => {
    const { context, vision } = view(ALL);

    // Not a tuning knob — an order-of-magnitude claim. If these ever converge,
    // the walkthrough has started carrying the pictures and this line is wrong.
    expect(vision!.tokens).toBeGreaterThan((context / 4) * 5);
  });

  it('is a fact about the recording, not about the switch', () => {
    /*
     * Like `IncludeRow.bytes` beside it, and for the same reason: the figure
     * lives on the Screenshots row, and a row has to be able to say what
     * turning it *on* would cost. Gated on the switch it would read `—` at
     * exactly the moment somebody is deciding whether to flip it.
     */
    expect(view({ ...ALL, images: false }).vision).toEqual(view(ALL).vision);
  });

  it('says nothing for a recording that has no screenshots', () => {
    const bare = [step(), step()];
    expect(deriveSendView({ steps: bare, options: ALL, busy: false }).vision).toBeNull();
  });

  it('is never larger than the upload it is a part of', () => {
    // A sanity floor rather than a claim about a ratio: the walkthrough is a
    // rendering of the payload, so a context figure above the upload would mean
    // the estimate had stopped being about the same flow.
    expect(view(ALL).context).toBeLessThan(view(ALL).total);
  });
});

describe('the rows', () => {
  it('offers exactly the four parts a flow is made of', () => {
    expect(view(ALL).includes.map((row) => row.id)).toEqual([
      'images',
      'network',
      'logs',
      'react',
    ]);
  });

  /**
   * Unlike the JSON export, the server keeps every part it is handed — so the
   * only row this destination ever disables is one the flow has nothing for,
   * which is React on a page that was not React.
   */
  it('never disables a row for a flow that has all four parts', () => {
    expect(
      view(ALL, REACT_LOADED, false, REACT_TABLE).includes.every((row) => row.ignored === null),
    ).toBe(true);
  });

  it('disables React, and only React, on a flow that recorded none', () => {
    const rows = view(ALL).includes;
    expect(rows.find((row) => row.id === 'react')?.ignored).not.toBeNull();
    expect(rows.filter((row) => row.id !== 'react').every((row) => row.ignored === null)).toBe(true);
  });

  it('reports each part at the size it costs, not the size of the flow', () => {
    const rows = view(ALL).includes;
    expect(rows[0].bytes).toBe(IMAGE.length * 2);
    expect(rows[1].bytes).toBeGreaterThan(0);
    expect(rows[2].bytes).toBeGreaterThan(0);
  });
});

describe('what the dialog says out loud', () => {
  it('warns about bodies only when bodies are actually going', () => {
    expect(view(ALL).warnBodies).toBe(true);
    expect(view({ ...ALL, network: false }).warnBodies).toBe(false);
    expect(view(ALL, [step()]).warnBodies).toBe(false);
  });

  it('explains what is left when every switch is off, rather than looking broken', () => {
    expect(view(NONE).note).not.toBeNull();
    expect(view(ALL).note).toBeNull();
  });

  it('allows a send with nothing optional attached — the steps are the point', () => {
    expect(view(NONE).canSend).toBe(true);
  });

  it('refuses while one is in flight, and with nothing to send', () => {
    expect(view(ALL, LOADED, true).canSend).toBe(false);
    expect(view(ALL, []).canSend).toBe(false);
  });
});

describe('pruning, which is what the totals are promising', () => {
  it('drops screenshots — both the annotated one and the original', () => {
    const [first] = pruneSteps(
      [step({ screenshot: IMAGE, screenshotOriginal: IMAGE })],
      { ...ALL, images: false },
    );

    expect('screenshot' in first).toBe(false);
    expect('screenshotOriginal' in first).toBe(false);
  });

  it('drops network calls and console logs independently', () => {
    const [noNetwork] = pruneSteps(LOADED, { ...ALL, network: false });
    expect(noNetwork.networkCalls).toBeUndefined();
    expect(noNetwork.consoleLogs).toBeDefined();

    const [noLogs] = pruneSteps(LOADED, { ...ALL, logs: false });
    expect(noLogs.consoleLogs).toBeUndefined();
    expect(noLogs.networkCalls).toBeDefined();
  });

  it('keeps the step itself, whatever is switched off', () => {
    const [bare] = pruneSteps(LOADED, NONE);
    expect(bare.action).toBe('Clicked "Buy"');
    expect(bare.url).toBe('https://shop.example.com/cart');
    expect(bare.type).toBe('click');
  });

  it('never mutates the flow the viewer is still showing', () => {
    pruneSteps(LOADED, NONE);
    expect(LOADED[0].screenshot).toBe(IMAGE);
    expect(LOADED[0].networkCalls).toHaveLength(1);
  });

  it('hands back the same array when nothing is being dropped', () => {
    expect(pruneSteps(LOADED, SEND_EVERYTHING)).toBe(LOADED);
  });
});

/**
 * The banner that is not behind a switch.
 *
 * Every other warning in this dialog is gated on the Include switch that
 * controls the thing it warns about, which is right for all of them and wrong
 * for this one: a step URL is behind no switch, so gating it meant the dialog
 * fell silent — and printed its most reassuring line — at the exact moment
 * somebody had turned everything off to be careful.
 */
describe('credentials in step URLs', () => {
  const callback = (url: string) => [step({ url })];

  it('raises the banner with every switch off, which is the whole point', () => {
    const bare = view(NONE, callback('https://app.example.com/callback?code=4/0AY0e-g7'));

    expect(bare.credentials).not.toBeNull();
    expect(bare.credentials?.steps).toBe(1);
    expect(bare.credentials?.text).toContain('?code=');
  });

  it('does not let the bare note claim "nothing else" over a URL like that', () => {
    const clean = view(NONE, callback('https://shop.example.com/cart'));
    const dirty = view(NONE, callback('https://app.example.com/callback?code=abc'));

    expect(clean.note).toContain('nothing else');
    expect(dirty.note).not.toContain('nothing else');
    expect(dirty.note).toContain('does not strip the URLs');
  });

  it('says nothing about a flow whose URLs are ordinary', () => {
    expect(view(ALL, callback('https://shop.example.com/orders?sort=date&page=2')).credentials)
      .toBeNull();
  });

  it('is unmoved by the switches, because the URLs are', () => {
    const steps = callback('https://app.example.com/callback?code=abc');
    expect(view(ALL, steps).credentials?.text).toBe(view(NONE, steps).credentials?.text);
  });

  it('counts URLs, and names each parameter once however often it appears', () => {
    const found = view(NONE, [
      step({ url: 'https://app.example.com/callback?code=one&state=xyz' }),
      step({ url: 'https://app.example.com/callback?code=two' }),
      step({ url: 'https://shop.example.com/cart' }),
    ]).credentials;

    expect(found?.steps).toBe(2);
    expect(found?.params).toEqual(['code', 'state']);
  });

  /**
   * `redactUrl` runs at capture, so the ordinary flow has already had its
   * grants masked. Warning about those would be the dialog crying wolf about
   * its own redactor, and a warning people learn to click past is worse than
   * none — the one this raises has to mean something.
   */
  it('ignores a parameter capture has already masked', () => {
    expect(view(NONE, callback('https://app.example.com/callback?code=[redacted]')).credentials)
      .toBeNull();
  });

  it('ignores a parameter carrying nothing', () => {
    expect(view(NONE, callback('https://app.example.com/callback?code=')).credentials).toBeNull();
  });

  it('reads an implicit-flow token out of the fragment, and leaves a route alone', () => {
    expect(view(NONE, callback('https://app.example.com/#access_token=ya29.a0')).credentials)
      .not.toBeNull();
    expect(view(NONE, callback('https://app.example.com/#/orders/42')).credentials).toBeNull();
  });

  it('reads as one sentence for one parameter and for many', () => {
    const one = view(NONE, callback('https://app.example.com/cb?code=abc')).credentials;
    expect(one?.text).toContain('1 step URL carries a query parameter that looks like');

    const many = view(NONE, [
      step({ url: 'https://app.example.com/cb?code=abc&state=xyz' }),
      step({ url: 'https://app.example.com/cb?token=t' }),
    ]).credentials;
    expect(many?.text).toContain('2 step URLs carry query parameters that look like');
  });

  it('stops listing parameters before the sentence becomes a dump', () => {
    const text = view(
      NONE,
      callback('https://app.example.com/cb?code=a&state=b&token=c&secret=d&api_key=e'),
    ).credentials?.text;

    expect(text).toContain('and 2 more');
  });
});

/**
 * Where the flow is going, and whether anything is there.
 *
 * Four causes of a failed send reached one canned sentence that named exactly
 * one of them, and it was the wrong one three times out of four. These are the
 * four, kept apart by the only thing that can tell them apart — what the health
 * probe actually reported.
 */
describe('the destination', () => {
  const URL_LOCAL = 'http://127.0.0.1:4321/flows';

  function target(url: string, probe: SendProbe | null) {
    return deriveSendView({
      steps: LOADED,
      options: SEND_DEFAULTS,
      busy: false,
      target: { url, probe },
    }).target;
  }

  it('names the address before anything has been asked of it', () => {
    expect(target(URL_LOCAL, null)?.url).toBe(URL_LOCAL);
    expect(target(URL_LOCAL, null)?.status).toBeNull();
    expect(target(URL_LOCAL, null)?.problem).toBeNull();
  });

  it('says it is checking, then what answered', () => {
    expect(target(URL_LOCAL, { kind: 'checking' })?.status).toBe('Checking…');
    expect(
      target(URL_LOCAL, { kind: 'ok', service: 'devflow-mcp-server', mode: 'local' })?.status,
    ).toBe('Connected · devflow-mcp-server (local)');
  });

  it('raises no problem while the server is answering', () => {
    expect(target(URL_LOCAL, { kind: 'ok', service: 'x', mode: 'local' })?.problem).toBeNull();
  });

  it('reads a refused connection as nothing listening, not as a closed editor', () => {
    const problem = target(URL_LOCAL, { kind: 'failed', detail: 'Failed to fetch' })?.problem;

    expect(problem?.title).toBe('Nothing is listening on that port');
    expect(problem?.text).toContain('127.0.0.1:4321');
    expect(problem?.text).toContain('npx devflow-mcp-server install');
  });

  it('reads an HTTP answer as something else holding the port', () => {
    const problem = target(URL_LOCAL, { kind: 'failed', detail: 'HTTP 404' })?.problem;

    expect(problem?.title).toBe('Something else is on that port');
    expect(problem?.text).toContain('HTTP 404');
    // Nothing to install and nothing to open: something *is* listening.
    expect(problem?.text).not.toContain('install');
  });

  it('reads an abort as a timeout, and points at the setting that governs it', () => {
    const problem = target(URL_LOCAL, {
      kind: 'failed',
      detail: 'The operation was aborted.',
    })?.problem;

    expect(problem?.title).toBe('The server did not answer in time');
    expect(problem?.text).toContain('mcp.healthTimeoutMs');
  });

  /** `port.ts` refuses to rewrite a remote address; the same fact makes every
   *  local remedy the wrong advice here. */
  it('does not tell somebody to start a server on a machine that is not theirs', () => {
    const problem = target('http://build-box.example.com:4321/flows', {
      kind: 'failed',
      detail: 'Failed to fetch',
    })?.problem;

    expect(problem?.title).toContain('is not this machine');
    expect(problem?.text).toContain('not loopback');
    expect(problem?.text).not.toContain('install');
  });

  it('says an unusable address is unusable rather than guessing at a port', () => {
    const problem = target('not a url', { kind: 'failed', detail: 'not a URL: not a url' })
      ?.problem;

    expect(problem?.title).toBe('That address is not a URL');
    expect(problem?.text).toContain('Settings');
  });

  it('is absent for a caller that asked only about the bytes', () => {
    expect(view(SEND_DEFAULTS).target).toBeNull();
  });
});
