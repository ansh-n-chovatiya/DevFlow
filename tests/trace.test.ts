/**
 * When DevFlow may change what somebody else's application sends, and — mostly
 * — when it may not.
 *
 * This is the one module in the product that writes rather than watches, so
 * nearly all of its value is in the refusals and nearly all of this file is
 * spent on them. A test suite that proved the headers get built correctly and
 * nothing else would pass just as happily against a version that injects into
 * every cross-origin request in the world and breaks the recorded app's own
 * `fetch` on a preflight the backend never allowed.
 *
 * Four rules carry the weight, and each is asserted on its own rather than only
 * as a side effect of some larger case:
 *
 *   - **Cross-origin needs the user to have named the origin.** The ordinary
 *     case — an SPA on `:3000` calling an API on `:8000` — is a *different
 *     origin*, and a rule that compared hosts instead of origins would let it
 *     through while every other test in this file still passed. That case is
 *     asserted explicitly for exactly that reason.
 *   - **`unsafe-request` outranks everything.** It is checked against a request
 *     that is otherwise perfectly injectable, because a precedence test built
 *     on a fixture that would have been refused anyway proves nothing.
 *   - **An existing `traceparent` refuses the whole injection**, not just that
 *     one header. Asserted with `devflow` also switched on, since that is the
 *     only shape that can tell "refused outright" apart from "skipped one
 *     header".
 *   - **The sampled flag is `01`.** Asserted as a whole string, because a
 *     `toContain` on the trace id would survive every mutation of the two bytes
 *     that actually decide whether a backend records the trace.
 *
 * Every URL here is a shape a page really produces — a relative path, a
 * localhost port, a `blob:` from `URL.createObjectURL` — because inventing a
 * shape would test `originOf` against a fiction rather than against the browser.
 */

import { describe, expect, it } from 'vitest';
import type { TraceDecision, TracePolicy } from '../src/core/trace/index.js';
import {
  NO_TRACING,
  decideTrace,
  describeTrace,
  isSpanId,
  isTraceId,
  originOf,
  parseOrigins,
  traceparentValue,
} from '../src/core/trace/index.js';

const PAGE = 'http://localhost:3000';
const API = 'http://localhost:8000';

const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SPAN_ID = '0123456789abcdef';
const TRACEPARENT_VALUE = `00-${TRACE_ID}-${SPAN_ID}-01`;

type Ask = Parameters<typeof decideTrace>[0];

const BOTH: TracePolicy = { devflow: true, traceparent: true, allowedOrigins: [] };

/*
 * Every field is spelled out here rather than left off, so that a case which
 * overrides one of them is testing that one field against a fixture that would
 * otherwise have been accepted. A fixture missing `canRebuild` or `policy`
 * would read the same under the rule and under its negation.
 */
function ask(over: Partial<Ask> = {}): TraceDecision {
  return decideTrace({
    pageOrigin: PAGE,
    requestUrl: `${PAGE}/api/cart`,
    existingHeaders: [],
    policy: BOTH,
    canRebuild: true,
    traceId: TRACE_ID,
    spanId: SPAN_ID,
    ...over,
  });
}

/** Narrows, and fails with the refusal rather than with `undefined is not an object`. */
function injected(decision: TraceDecision): { headers: Record<string, string>; traceId: string } {
  if (!decision.inject) throw new Error(`expected an injection, got refusal: ${decision.reason}`);
  return decision;
}

describe('isTraceId', () => {
  it('accepts 32 lowercase hex', () => {
    expect(isTraceId(TRACE_ID)).toBe(true);
  });

  /*
   * W3C Trace Context defines the id as lowercase hex, so an uppercase one is
   * not a stylistic variant — a validating backend rejects the header, and the
   * request it was attached to goes with it.
   */
  it('rejects uppercase hex', () => {
    expect(isTraceId(TRACE_ID.toUpperCase())).toBe(false);
    expect(isTraceId('A1b2c3d4e5f60718293a4b5c6d7e8f90')).toBe(false);
  });

  /*
   * The all-zero id is forbidden by the spec and is exactly what a broken
   * generator produces. It is 32 hex characters, so a length-and-charset check
   * alone would mint a header that looks right in every log and is rejected by
   * every conformant backend.
   */
  it('rejects the all-zero id', () => {
    expect(isTraceId('0'.repeat(32))).toBe(false);
    // One non-zero digit is a legal id, however unlikely — the rule is "not all
    // zeros", not "does not start with zeros".
    expect(isTraceId(`${'0'.repeat(31)}1`)).toBe(true);
  });

  it('rejects lengths one either side of 32', () => {
    expect(isTraceId(TRACE_ID.slice(0, 31))).toBe(false);
    expect(isTraceId(`${TRACE_ID}a`)).toBe(false);
  });

  it('rejects non-hex characters and non-strings', () => {
    expect(isTraceId(`${TRACE_ID.slice(0, 31)}g`)).toBe(false);
    expect(isTraceId('')).toBe(false);
    expect(isTraceId(undefined)).toBe(false);
    expect(isTraceId(null)).toBe(false);
    expect(isTraceId(12345)).toBe(false);
    expect(isTraceId({ id: TRACE_ID })).toBe(false);
  });
});

describe('isSpanId', () => {
  it('accepts 16 lowercase hex', () => {
    expect(isSpanId(SPAN_ID)).toBe(true);
  });

  it('rejects uppercase hex', () => {
    expect(isSpanId('0123456789ABCDEF')).toBe(false);
  });

  // Same reason as the trace id: the zero span id is forbidden, and it is the
  // shape a zero-filled buffer produces.
  it('rejects the all-zero id', () => {
    expect(isSpanId('0'.repeat(16))).toBe(false);
  });

  /*
   * A trace id is not a span id. The two lengths are the whole difference
   * between the two fields, and a shared 32-hex check would put a trace id in
   * the parent-id slot of every header this module builds.
   */
  it('rejects lengths one either side of 16, and a trace id', () => {
    expect(isSpanId(SPAN_ID.slice(0, 15))).toBe(false);
    expect(isSpanId(`${SPAN_ID}0`)).toBe(false);
    expect(isSpanId(TRACE_ID)).toBe(false);
  });

  it('rejects non-strings', () => {
    expect(isSpanId(undefined)).toBe(false);
    expect(isSpanId(null)).toBe(false);
    expect(isSpanId(1)).toBe(false);
  });
});

describe('traceparentValue', () => {
  /*
   * Asserted as one whole string rather than in pieces. The four fields are
   * positional and hyphen-delimited, so a check that only looked for the trace
   * id inside the value would pass against a header with the version, the span
   * and the flags all wrong.
   */
  it('is version 00, the trace id, the span id and the flags, in that order', () => {
    expect(traceparentValue(TRACE_ID, SPAN_ID)).toBe(
      `00-a1b2c3d4e5f60718293a4b5c6d7e8f90-0123456789abcdef-01`,
    );
  });

  /*
   * The flags byte is `01` — sampled — and that is a decision, not a formality.
   * `00` would ask an OpenTelemetry backend to record nothing, leaving a header
   * with no purpose; `01` asks it to record a trace it would otherwise have
   * sampled away, which costs the user money on somebody else's observability
   * bill. It is asserted here on its own so that changing it has to be a choice
   * somebody makes deliberately and re-argues in this comment.
   */
  it('sets the sampled flag', () => {
    expect(traceparentValue(TRACE_ID, SPAN_ID)?.endsWith('-01')).toBe(true);
  });

  /*
   * A malformed `traceparent` is worse than no `traceparent`: the backend either
   * rejects the request or opens a broken trace, and neither failure points
   * anywhere near DevFlow. So a bad input yields null and the caller adds
   * nothing, rather than yielding a string with a hole in it.
   */
  it('is null for an unusable trace id', () => {
    expect(traceparentValue('0'.repeat(32), SPAN_ID)).toBeNull();
    expect(traceparentValue(TRACE_ID.toUpperCase(), SPAN_ID)).toBeNull();
    expect(traceparentValue('nope', SPAN_ID)).toBeNull();
    expect(traceparentValue('', SPAN_ID)).toBeNull();
  });

  it('is null for an unusable span id', () => {
    expect(traceparentValue(TRACE_ID, '0'.repeat(16))).toBeNull();
    expect(traceparentValue(TRACE_ID, '0123456789ABCDEF')).toBeNull();
    // A trace id in the span slot is the likeliest way to get this wrong.
    expect(traceparentValue(TRACE_ID, TRACE_ID)).toBeNull();
    expect(traceparentValue(TRACE_ID, '')).toBeNull();
  });
});

describe('originOf', () => {
  it('reads the origin of an absolute URL, dropping path, query and fragment', () => {
    expect(originOf('https://api.example.com/v1/cart?id=3#top')).toBe('https://api.example.com');
  });

  // The commonest shape in a real page: `fetch('/api/cart')`, which means
  // nothing at all until it is resolved against the page it was written on.
  it('resolves a relative URL against the page origin', () => {
    expect(originOf('/api/cart', PAGE)).toBe(PAGE);
    expect(originOf('cart', `${PAGE}/checkout/`)).toBe(PAGE);
  });

  /*
   * The port is part of the origin and this is where the whole cross-origin
   * rule is decided, so it is asserted on the value rather than only through
   * `decideTrace`.
   */
  it('keeps the port', () => {
    expect(originOf('http://127.0.0.1:8000/api')).toBe('http://127.0.0.1:8000');
    expect(originOf('http://127.0.0.1:8000/api')).not.toBe('http://127.0.0.1');
  });

  /*
   * `data:` and `file:` have the opaque origin, which is never same-origin with
   * anything — including itself — so there is no origin here that can be
   * compared and the answer has to be null rather than the string `"null"`,
   * which would compare equal to another opaque origin.
   */
  it('is null for the opaque origins', () => {
    expect(originOf('data:text/plain,hello')).toBeNull();
    expect(originOf('file:///Users/dev/app/index.html')).toBeNull();
    expect(originOf('blob:null/6f3c-11ee')).toBeNull();
  });

  /*
   * Recorded because it contradicts the header, which lists `blob:` alongside
   * `data:` and `file:` as producing the opaque origin. It does not: a blob URL
   * minted by `URL.createObjectURL` in a page carries that page's origin in its
   * path, and both the URL Standard and Node hand it back. Same-origin blob
   * fetches are therefore injectable — harmless (a blob fetch cannot preflight)
   * but not what the comment says.
   */
  it('gives a blob URL the origin of the page that minted it', () => {
    expect(originOf(`blob:${PAGE}/6f3c-11ee-be56`)).toBe(PAGE);
  });

  it('is null for a string that is not a URL at all', () => {
    expect(originOf('not a url')).toBeNull();
    expect(originOf('')).toBeNull();
    expect(originOf('http://')).toBeNull();
    // Relative, with nothing to resolve against.
    expect(originOf('/api/cart')).toBeNull();
  });
});

describe('decideTrace — off', () => {
  /*
   * The default the product ships. A user who upgrades and reads no release
   * notes must find their traffic unchanged, so "off" is checked before
   * anything else and does not depend on the request being interesting.
   */
  it('refuses when neither switch is on', () => {
    expect(ask({ policy: NO_TRACING })).toEqual({ inject: false, reason: 'off' });
  });

  /*
   * The same request that every accept case in this file uses — same-origin,
   * rebuildable, untraced. Being *safe* to inject is not a reason to inject:
   * the user has not asked for it.
   */
  it('refuses a same-origin request that is safe in every other way', () => {
    expect(
      ask({
        requestUrl: `${PAGE}/api/cart`,
        policy: { devflow: false, traceparent: false, allowedOrigins: [PAGE, API] },
      }),
      // `off`, not `nothing-to-add`: both switches are down, which is the
      // shipped default and genuinely is the user having this switched off.
    ).toEqual({ inject: false, reason: 'off' });
  });
});

describe('decideTrace — unsafe-request', () => {
  /*
   * `canRebuild` is the caller saying it cannot reissue the request without
   * disturbing what the page built — a streaming body is the case. The safe
   * failure is to send exactly what the page asked for.
   *
   * The fixture is deliberately the most injectable request in this file: same
   * origin, both switches on, no existing headers, valid ids. It would be
   * accepted if the flag were ignored, which is what makes this a test of
   * precedence and not just of a refusal that would have happened anyway.
   */
  it('outranks a request that would otherwise be accepted', () => {
    expect(ask({ canRebuild: false })).toEqual({ inject: false, reason: 'unsafe-request' });
  });

  // And it outranks the other refusals too, so the reason a caller is shown is
  // the one it can actually do something about.
  it('outranks cross-origin, already-traced and bad-url', () => {
    expect(ask({ canRebuild: false, requestUrl: `${API}/api/cart` })).toEqual({
      inject: false,
      reason: 'unsafe-request',
    });
    expect(ask({ canRebuild: false, existingHeaders: ['traceparent'] })).toEqual({
      inject: false,
      reason: 'unsafe-request',
    });
    expect(ask({ canRebuild: false, requestUrl: 'not a url', pageOrigin: null })).toEqual({
      inject: false,
      reason: 'unsafe-request',
    });
  });
});

describe('decideTrace — cross-origin', () => {
  /*
   * The rule the module exists for, in the shape it will almost always be met:
   * a dev server on :3000 calling an API on :8000. **A different port is a
   * different origin** — this request is subject to CORS, adding a header makes
   * it non-simple, and the preflight that follows fails unless the backend
   * names the header. There is no falling back from that: by the time the
   * browser reports it, the page's own `fetch` has already rejected.
   */
  it('refuses a different port on the same host', () => {
    expect(ask({ pageOrigin: PAGE, requestUrl: `${API}/api/cart` })).toEqual({
      inject: false,
      reason: 'cross-origin',
    });
  });

  // The scheme is part of the origin too, and an http page calling its own
  // https host is a real deployment shape rather than a contrivance.
  it('refuses a different scheme on the same host and port', () => {
    expect(ask({ requestUrl: 'https://localhost:3000/api/cart' })).toEqual({
      inject: false,
      reason: 'cross-origin',
    });
  });

  it('refuses a different host', () => {
    expect(ask({ requestUrl: 'https://api.stripe.com/v1/charges' })).toEqual({
      inject: false,
      reason: 'cross-origin',
    });
  });

  /*
   * Naming the origin is the user saying "my backend accepts this header" —
   * informed consent per backend, which is the only honest form it can take,
   * since DevFlow cannot discover whether a server allows a header without
   * sending the request that might fail.
   */
  it('accepts the same request once its origin is on the allow-list', () => {
    expect(
      ask({
        requestUrl: `${API}/api/cart`,
        policy: { devflow: true, traceparent: true, allowedOrigins: [API] },
      }),
    ).toEqual({
      inject: true,
      headers: { 'X-DevFlow-Trace-Id': TRACE_ID, traceparent: TRACEPARENT_VALUE },
      traceId: TRACE_ID,
    });
  });

  /*
   * The allow-list is compared as origins, exactly. An entry pasted from the
   * address bar with its trailing slash does not match, and a user who has
   * "added" their API and still sees no header has no way to tell why — worth
   * pinning so the shape of the entry is a known constraint rather than a
   * surprise.
   */
  it('does not match an allow-list entry that is not a bare origin', () => {
    for (const entry of [`${API}/`, `${API}/api`, 'localhost:8000']) {
      expect(
        ask({
          requestUrl: `${API}/api/cart`,
          policy: { devflow: true, traceparent: true, allowedOrigins: [entry] },
        }),
      ).toEqual({ inject: false, reason: 'cross-origin' });
    }
  });

  /*
   * A page with no origin — an opaque or unknown one — is same-origin with
   * nothing, so every destination is cross-origin and needs naming. It must not
   * degrade into "no origin, so nothing to compare, so allow".
   */
  it('refuses when the page has no origin to be same-origin with', () => {
    expect(ask({ pageOrigin: null, requestUrl: `${PAGE}/api/cart` })).toEqual({
      inject: false,
      reason: 'cross-origin',
    });
  });
});

describe('decideTrace — same-origin', () => {
  /*
   * Same-origin requests are not subject to CORS at all, so no preflight is
   * reachable and no header can break them. That asymmetry is the whole design,
   * and it is why an empty allow-list is not an obstacle here.
   */
  it('accepts an absolute same-origin URL with an empty allow-list', () => {
    expect(ask({ requestUrl: `${PAGE}/api/cart`, policy: BOTH })).toEqual({
      inject: true,
      headers: { 'X-DevFlow-Trace-Id': TRACE_ID, traceparent: TRACEPARENT_VALUE },
      traceId: TRACE_ID,
    });
  });

  // The way an app actually writes it. Resolution against the page happens
  // inside the decision, so the caller is not asked to normalise first.
  it('accepts a relative URL, resolved against the page', () => {
    expect(ask({ requestUrl: '/api/cart', policy: BOTH })).toEqual({
      inject: true,
      headers: { 'X-DevFlow-Trace-Id': TRACE_ID, traceparent: TRACEPARENT_VALUE },
      traceId: TRACE_ID,
    });
  });
});

describe('decideTrace — already-traced', () => {
  /*
   * A page that already sends `traceparent` has its own tracing, and writing
   * over it would reparent somebody's production spans under an id their
   * backend has never seen.
   *
   * `devflow` is on here as well, and that is the point of the case: it
   * distinguishes "the whole injection is refused" from "we skipped that one
   * header and sent ours anyway". The module refuses outright, because a
   * request that is already traced does not need a second id — the one it
   * carries is the one the backend will file the span under.
   */
  it('refuses the whole injection, not just the traceparent header', () => {
    expect(ask({ existingHeaders: ['traceparent'], policy: BOTH })).toEqual({
      inject: false,
      reason: 'already-traced',
    });
  });

  // HTTP header names are case-insensitive and every library spells them
  // differently; `Headers` normalises, a plain object literal does not.
  it('recognises the header in any case', () => {
    for (const name of ['traceparent', 'Traceparent', 'TRACEPARENT', 'tRaCePaReNt']) {
      expect(ask({ existingHeaders: ['accept', name, 'content-type'] })).toEqual({
        inject: false,
        reason: 'already-traced',
      });
    }
  });

  // It outranks the header-building step but not the cheaper guards above it,
  // so a cross-origin request that is also traced is reported as cross-origin.
  it('does not shadow the cross-origin refusal', () => {
    expect(ask({ requestUrl: `${API}/api/cart`, existingHeaders: ['traceparent'] })).toEqual({
      inject: false,
      reason: 'cross-origin',
    });
  });
});

describe('decideTrace — an existing X-DevFlow-Trace-Id', () => {
  /*
   * Our own header is treated differently from `traceparent`, and this is what
   * that difference is: it is not overwritten, but it does not refuse the
   * injection either. Nothing downstream depends on it the way somebody's trace
   * tree depends on `traceparent`, so the traceparent still goes on.
   */
  it('is left alone while the traceparent is still injected', () => {
    expect(ask({ existingHeaders: ['X-DevFlow-Trace-Id'], policy: BOTH })).toEqual({
      inject: true,
      headers: { traceparent: TRACEPARENT_VALUE },
      traceId: TRACE_ID,
    });
  });

  it('is matched in any case', () => {
    expect(ask({ existingHeaders: ['x-devflow-trace-id'] })).toEqual({
      inject: true,
      headers: { traceparent: TRACEPARENT_VALUE },
      traceId: TRACE_ID,
    });
  });

  /*
   * With nothing left to add, the decision is a refusal rather than an
   * injection of an empty header set — there is no reason to rebuild a request
   * for no change.
   *
   * The reason is its own word. It was `off` first, and `off` says *the user
   * has this switched off*, which here is false and would send whoever read it
   * at the wrong fix — in a list whose whole promise is that each entry is a
   * different thing to tell somebody.
   */
  it('refuses when it is the only header the policy would have added', () => {
    expect(
      ask({
        existingHeaders: ['X-DevFlow-Trace-Id'],
        policy: { devflow: true, traceparent: false, allowedOrigins: [] },
      }),
    ).toEqual({ inject: false, reason: 'nothing-to-add' });
  });
});

describe('decideTrace — bad-url', () => {
  // A `fetch` of a data URL is real, and it has no origin that can be compared
  // with the page's — so there is nothing to decide and nothing is added.
  it('refuses a URL with an opaque origin', () => {
    expect(ask({ requestUrl: 'data:application/json,{}' })).toEqual({
      inject: false,
      reason: 'bad-url',
    });
    expect(ask({ requestUrl: 'file:///Users/dev/app/fixture.json' })).toEqual({
      inject: false,
      reason: 'bad-url',
    });
  });

  /*
   * A relative URL with no page origin to resolve it against. This is what a
   * caller that lost track of the page hands in, and guessing an origin for it
   * would be guessing which backend to change.
   */
  it('refuses a URL it cannot resolve', () => {
    expect(ask({ pageOrigin: null, requestUrl: '/api/cart' })).toEqual({
      inject: false,
      reason: 'bad-url',
    });
    expect(ask({ pageOrigin: null, requestUrl: 'not a url' })).toEqual({
      inject: false,
      reason: 'bad-url',
    });
  });
});

describe('decideTrace — what gets injected', () => {
  /*
   * The two switches are two decisions, so all four combinations are asserted
   * on the exact header set rather than on "contains ours". `toEqual` on the
   * whole object is what makes "only" mean only.
   */
  it('sends both headers when both switches are on', () => {
    expect(ask({ policy: BOTH })).toEqual({
      inject: true,
      headers: { 'X-DevFlow-Trace-Id': TRACE_ID, traceparent: TRACEPARENT_VALUE },
      traceId: TRACE_ID,
    });
  });

  /*
   * One request, one id: the greppable header and the W3C one name the same
   * operation, or Tier 1's whole payoff — grep the backend log for the id
   * DevFlow reported — finds the wrong half of the request.
   */
  it('puts the same trace id in both headers, and reports it', () => {
    const { headers, traceId } = injected(ask({ policy: BOTH }));

    expect(headers.traceparent.split('-')[1]).toBe(headers['X-DevFlow-Trace-Id']);
    expect(traceId).toBe(headers['X-DevFlow-Trace-Id']);
  });

  it('sends only X-DevFlow-Trace-Id when only that switch is on', () => {
    expect(ask({ policy: { devflow: true, traceparent: false, allowedOrigins: [] } })).toEqual({
      inject: true,
      headers: { 'X-DevFlow-Trace-Id': TRACE_ID },
      traceId: TRACE_ID,
    });
  });

  it('sends only traceparent when only that switch is on', () => {
    expect(ask({ policy: { devflow: false, traceparent: true, allowedOrigins: [] } })).toEqual({
      inject: true,
      headers: { traceparent: TRACEPARENT_VALUE },
      traceId: TRACE_ID,
    });
  });

  /*
   * The ids come from the caller, which owns the randomness — so a caller that
   * mints a bad one must not produce a malformed `traceparent`. The bespoke
   * header still goes (it has no format anyone parses); the standard one is
   * dropped rather than sent broken.
   */
  it('drops a traceparent it cannot build rather than sending a broken one', () => {
    expect(ask({ spanId: '0'.repeat(16), policy: BOTH })).toEqual({
      inject: true,
      headers: { 'X-DevFlow-Trace-Id': TRACE_ID },
      traceId: TRACE_ID,
    });
  });

  // And with nothing else to send, an unbuildable traceparent leaves the
  // request untouched instead of rebuilt for an empty change.
  it('refuses when the traceparent was the only header and could not be built', () => {
    expect(
      ask({
        traceId: 'not-a-trace-id',
        policy: { devflow: false, traceparent: true, allowedOrigins: [] },
      }),
    ).toEqual({ inject: false, reason: 'nothing-to-add' });
  });
});

describe('NO_TRACING', () => {
  /*
   * The shipped default, asserted field by field. This is the constant that
   * decides whether installing DevFlow changes a stranger's traffic, and
   * "genuinely inert" is cheap to state and expensive to discover otherwise.
   */
  it('is off in every field', () => {
    expect(NO_TRACING).toEqual({ devflow: false, traceparent: false, allowedOrigins: [] });
    expect(NO_TRACING.devflow).toBe(false);
    expect(NO_TRACING.traceparent).toBe(false);
    expect(NO_TRACING.allowedOrigins).toHaveLength(0);
  });

  // An empty allow-list is not a loophole: it grants nothing, including to the
  // page's own origin, because with both switches off nothing is reachable.
  it('injects into nothing', () => {
    for (const requestUrl of [`${PAGE}/api/cart`, '/api/cart', `${API}/api/cart`]) {
      expect(ask({ requestUrl, policy: NO_TRACING })).toEqual({ inject: false, reason: 'off' });
    }
  });
});

describe('describeTrace', () => {
  /*
   * A header nobody can see is a change to somebody's traffic in exchange for
   * nothing. The id has to survive into the sentence verbatim — it is what gets
   * pasted into a log search — and the sentence has to say what to do with it.
   */
  it('carries the id and says what to do with it', () => {
    const line = describeTrace(TRACE_ID);

    expect(line).toContain(TRACE_ID);
    expect(line).toMatch(/search/i);
    expect(line).toMatch(/logs/i);
  });
});

describe('parseOrigins', () => {
  /*
   * This function exists because `decideTrace` compares origins with
   * `includes`, which is an exact string match — so the gap between what a
   * person types and what that comparison wants is a silent failure with no
   * error anywhere: no header, no warning, and no way to tell whether the
   * setting or the backend was the problem.
   *
   * Every case below is a shape somebody really types.
   */
  it('normalises a trailing slash, which is what the address bar gives you', () => {
    expect(parseOrigins('http://localhost:8000/')).toEqual(['http://localhost:8000']);
  });

  it('normalises away a path, which is a reasonable thing to paste', () => {
    expect(parseOrigins('http://localhost:8000/api/v1')).toEqual(['http://localhost:8000']);
  });

  it('splits on commas, spaces and newlines, because the field is one line of text', () => {
    expect(parseOrigins('http://a.test, http://b.test\nhttp://c.test')).toEqual([
      'http://a.test',
      'http://b.test',
      'http://c.test',
    ]);
  });

  it('keeps the port, because a different port is a different origin', () => {
    // The single most important thing this function must not do is collapse
    // :3000 and :8000, which is the exact pair the allow-list exists for.
    expect(parseOrigins('http://localhost:3000 http://localhost:8000')).toEqual([
      'http://localhost:3000',
      'http://localhost:8000',
    ]);
  });

  it('collapses duplicates written two ways', () => {
    expect(parseOrigins('http://a.test http://a.test/ http://a.test/x')).toEqual(['http://a.test']);
  });

  /*
   * Dropped rather than kept. An entry that is not a URL can never match a real
   * origin, so keeping it would put a string in the list that looks like an
   * opted-in backend and silently is not.
   */
  it('drops an entry that is not a URL at all', () => {
    expect(parseOrigins('localhost:8000')).toEqual([]);
    expect(parseOrigins('not a url, http://good.test')).toEqual(['http://good.test']);
  });

  it('is empty for empty, absent and whitespace', () => {
    expect(parseOrigins('')).toEqual([]);
    expect(parseOrigins(null)).toEqual([]);
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins('   ')).toEqual([]);
  });

  /*
   * The end-to-end point of the whole function: what the user typed now matches
   * what `decideTrace` compares. Without the normalisation this same input
   * refuses the request.
   */
  it('produces a list a cross-origin request actually matches', () => {
    const decision = decideTrace({
      pageOrigin: PAGE,
      requestUrl: `${API}/cart`,
      existingHeaders: [],
      policy: { devflow: true, traceparent: false, allowedOrigins: parseOrigins(`${API}/`) },
      canRebuild: true,
      traceId: TRACE_ID,
      spanId: SPAN_ID,
    });

    expect(injected(decision).headers).toEqual({ 'X-DevFlow-Trace-Id': TRACE_ID });
  });
});
