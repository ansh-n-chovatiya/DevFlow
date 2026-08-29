/**
 * The failure that happens after the last click.
 *
 * Console and network activity is attached to the *next* step, because a step is
 * the thing it gets written onto — so whatever a page produced after the user's
 * final interaction had nowhere to land, and stopping the recording dropped it.
 * That is exactly backwards: the ordinary shape of a bug report is *click the
 * thing, watch it break, stop recording*, and the break is the part that was
 * being thrown away.
 *
 * The worker asks every tab for what it is still holding; this is the rule that
 * turns those answers into one trailing step's worth.
 */

import { describe, expect, it } from 'vitest';
import { mergeTrailing, type Pending } from '../src/core/flow/index.js';
import type { ConsoleEntry, NetworkCall } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

const logAt = (at: number, message: string): ConsoleEntry => ({
  level: 'error',
  args: [message],
  timestamp: NOW + at,
});

const callAt = (at: number, url: string): NetworkCall =>
  ({
    method: 'POST',
    url,
    requestHeaders: {},
    requestBody: null,
    status: 500,
    responseHeaders: {},
    responseBody: '{"error":"nope"}',
    durationMs: 12,
    timestamp: NOW + at,
  });

describe('what is left over when a recording stops', () => {
  it('is nothing when no tab was holding anything', () => {
    expect(mergeTrailing([])).toBeNull();
    expect(mergeTrailing([null, undefined])).toBeNull();
    // An empty answer is a tab that replied and had nothing — which must not
    // produce a step saying something happened.
    expect(mergeTrailing([{ consoleLogs: [], networkCalls: [] }])).toBeNull();
  });

  it('keeps a failure that arrived after the final interaction', () => {
    const merged = mergeTrailing([
      { consoleLogs: [logAt(10, 'TypeError: total is undefined')], networkCalls: [] },
    ]);

    expect(merged?.consoleLogs).toHaveLength(1);
    expect(merged?.consoleLogs[0].args[0]).toContain('total is undefined');
  });

  it('gathers from every tab, because a recording follows the user across them', () => {
    const merged = mergeTrailing([
      { consoleLogs: [logAt(5, 'from tab one')], networkCalls: [] },
      null, // a tab with no content script listening
      { consoleLogs: [], networkCalls: [callAt(7, 'https://api.example.com/orders')] },
    ]);

    expect(merged?.consoleLogs).toHaveLength(1);
    expect(merged?.networkCalls).toHaveLength(1);
  });

  it('puts it back in the order it happened, not the order tabs answered', () => {
    const merged = mergeTrailing([
      { consoleLogs: [logAt(900, 'third')], networkCalls: [] },
      { consoleLogs: [logAt(100, 'first'), logAt(500, 'second')], networkCalls: [] },
    ]);

    // A stack trace printed before a request failed is a different story from
    // one printed after it; tab response order is not a story at all.
    expect(merged?.consoleLogs.map((entry) => entry.args[0])).toEqual(['first', 'second', 'third']);
  });

  it('sorts the calls too', () => {
    const merged = mergeTrailing([
      { consoleLogs: [], networkCalls: [callAt(80, 'https://api.example.com/b')] },
      { consoleLogs: [], networkCalls: [callAt(20, 'https://api.example.com/a')] },
    ]);

    expect(merged?.networkCalls.map((call) => call.url)).toEqual([
      'https://api.example.com/a',
      'https://api.example.com/b',
    ]);
  });

  it('takes the page from the tab that had something, not the first to reply', () => {
    const answers: Pending[] = [
      { consoleLogs: [], networkCalls: [], url: 'https://unrelated.example.com/' },
      {
        consoleLogs: [logAt(1, 'boom')],
        networkCalls: [],
        url: 'https://shop.example.com/checkout',
      },
    ];

    // The page this activity belongs to is the page that produced it.
    expect(mergeTrailing(answers)?.url).toBe('https://shop.example.com/checkout');
  });

  it('leaves the url out rather than inventing one', () => {
    const merged = mergeTrailing([{ consoleLogs: [logAt(1, 'boom')], networkCalls: [] }]);

    expect(merged).not.toBeNull();
    expect(merged?.url).toBeUndefined();
  });
});
