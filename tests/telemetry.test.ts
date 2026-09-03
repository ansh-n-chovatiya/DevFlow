/**
 * What a relayed crash report is allowed to become.
 *
 * Most of this file is about what is **not** kept. A Sentry event carries a
 * user's id and email, the request that failed with its cookies and body, the
 * breadcrumbs leading up to it, and an exception `value` that is routinely an
 * interpolated string holding an order number or a token. None of that is what
 * makes a crash useful to somebody about to change a file, and all of it is
 * somebody else's user's data, so the tests below assert its absence rather
 * than trusting a reading of the parser.
 *
 * The rest is the refusal ladder. A webhook's ordinary answer is "no", and a
 * relay that is working and one that is misconfigured both produce "nothing
 * arrived" — the reason code is the only thing that tells them apart.
 */

import { describe, expect, it } from 'vitest';
import { describeProductionError, parseSentryDelivery } from '../src/core/telemetry/index.js';

/** A delivery shaped like Sentry's issue alert, carrying every field it really sends. */
const delivery = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    action: 'triggered',
    data: {
      event: {
        event_id: 'e'.repeat(32),
        issue_id: '4507',
        level: 'error',
        culprit: 'CartButton(src/Cart.tsx)',
        timestamp: 1_760_000_000,
        count: 42,
        web_url: 'https://sentry.io/organizations/acme/issues/4507/',
        // Everything below this line is data this must never keep.
        user: { id: '9931', email: 'someone@example.com', ip_address: '203.0.113.9' },
        request: {
          url: 'https://shop.example.com/cart?token=secret',
          headers: { Cookie: 'session=abc123', Authorization: 'Bearer xyz' },
          data: { cardNumber: '4111111111111111' },
        },
        contexts: { device: { name: "Ada's iPhone" } },
        breadcrumbs: { values: [{ message: 'clicked Buy for order #55123' }] },
        extra: { orderId: '55123' },
        exception: {
          values: [
            {
              type: 'TypeError',
              value: "Cannot read properties of undefined (reading 'paymentMethodId') for user 9931",
              stacktrace: {
                frames: [
                  { filename: 'src/index.tsx', lineno: 4, in_app: true, vars: { token: 'xyz' } },
                  {
                    filename: 'src/Cart.tsx',
                    lineno: 12,
                    in_app: true,
                    context_line: '  const id = user.paymentMethodId;',
                    pre_context: ['  // secret comment'],
                  },
                ],
              },
            },
          ],
        },
      },
    },
    ...over,
  });

const parsed = (raw = delivery()) => {
  const result = parseSentryDelivery(raw);
  if (!result.ok) throw new Error(`expected a parse, got ${result.reason}`);
  return result.error;
};

describe('what is kept', () => {
  it('keys the issue on the provider’s own issue id, which is stable across deliveries', () => {
    expect(parsed().id).toBe('sentry:4507');
    expect(parsed().provider).toBe('sentry');
  });

  it('keeps the exception type, the culprit, the level, the count and the link', () => {
    expect(parsed()).toMatchObject({
      type: 'TypeError',
      culprit: 'CartButton(src/Cart.tsx)',
      level: 'error',
      count: 42,
      url: 'https://sentry.io/organizations/acme/issues/4507/',
    });
  });

  it('reads a second-resolution timestamp as milliseconds', () => {
    expect(parsed().lastSeenMs).toBe(1_760_000_000_000);
  });

  it('keeps frames top of the stack first, so a cap keeps the useful end', () => {
    // Sentry lists frames oldest-first: the last entry is where it broke.
    expect(parsed().frames.map((frame) => frame.filename)).toEqual(['src/Cart.tsx', 'src/index.tsx']);
    expect(parsed().frames[0]).toMatchObject({ lineno: 12, inApp: true });
  });
});

describe('what is dropped, which is the longer list', () => {
  const asText = () => JSON.stringify(parsed());

  it('keeps no user, no request, no cookie and no header', () => {
    for (const secret of ['someone@example.com', '203.0.113.9', 'session=abc123', 'Bearer xyz', '9931']) {
      expect(asText()).not.toContain(secret);
    }
  });

  it('keeps no breadcrumbs, contexts or extra', () => {
    for (const secret of ["Ada's iPhone", 'clicked Buy', '55123']) {
      expect(asText()).not.toContain(secret);
    }
  });

  it('keeps the exception type and never its interpolated value', () => {
    // The value is where an order number, an email or a token ends up.
    expect(asText()).toContain('TypeError');
    expect(asText()).not.toContain('paymentMethodId');
  });

  it('keeps a frame’s filename and line and nothing else from it', () => {
    expect(asText()).not.toContain('const id = user.paymentMethodId');
    expect(asText()).not.toContain('secret comment');
    expect(asText()).not.toContain('xyz');
    for (const frame of parsed().frames) {
      expect(Object.keys(frame).sort()).toEqual(['filename', 'inApp', 'lineno']);
    }
  });

  it('keeps no card number from a request body', () => {
    expect(asText()).not.toContain('4111111111111111');
  });
});

describe('the refusals, each a different thing to do about it', () => {
  const reason = (raw: string) => {
    const result = parseSentryDelivery(raw);
    return result.ok ? 'ok' : result.reason;
  };

  it('tells a body that is not JSON from one that is not an object', () => {
    expect(reason('not json at all')).toBe('not-json');
    expect(reason('[1,2,3]')).toBe('not-an-object');
    expect(reason('"a string"')).toBe('not-an-object');
  });

  it('refuses a payload with no issue id, because nothing in it is stable', () => {
    expect(reason(JSON.stringify({ data: { event: { exception: { values: [{ type: 'TypeError' }] } } } })))
      .toBe('no-issue-id');
  });

  it('refuses a message event, which has no failure shape to record', () => {
    expect(reason(JSON.stringify({ data: { event: { issue_id: '1', message: 'hello' } } })))
      .toBe('no-exception');
  });

  it('unwraps all three envelope shapes a relay might send', () => {
    const raw = { issue_id: '77', exception: { values: [{ type: 'RangeError' }] } };
    expect(reason(JSON.stringify(raw))).toBe('ok');
    expect(reason(JSON.stringify({ data: { event: raw } }))).toBe('ok');
    expect(reason(JSON.stringify({ data: { issue: raw } }))).toBe('ok');
  });

  it('accepts an issue with a type from metadata and no stack at all', () => {
    const result = parseSentryDelivery(
      JSON.stringify({ data: { issue: { id: '9', metadata: { type: 'ChunkLoadError' } } } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.error).toMatchObject({ type: 'ChunkLoadError', frames: [] });
  });

  it('drops a frame with no filename, since a filename is all this joins on', () => {
    const result = parseSentryDelivery(
      JSON.stringify({
        issue_id: '3',
        exception: {
          values: [
            { type: 'Error', stacktrace: { frames: [{ lineno: 4 }, { filename: 'src/a.ts', lineno: 9 }] } },
          ],
        },
      }),
    );
    if (!result.ok) throw new Error('expected a parse');
    expect(result.error.frames).toEqual([{ filename: 'src/a.ts', lineno: 9, inApp: false }]);
  });
});

describe('describeProductionError', () => {
  it('says the count is production events, so it is never read as an observation count', () => {
    const line = describeProductionError({
      type: 'TypeError',
      culprit: 'CartButton',
      count: 42,
      level: 'error',
      lastSeenMs: 1_760_000_000_000,
    });
    expect(line).toContain('42 events in production');
    expect(line).toContain('TypeError in CartButton');
  });
});
