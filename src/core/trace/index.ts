/**
 * Whether one outbound request may be given a trace header, and which.
 *
 * ## This is the first thing DevFlow does that is not observation
 *
 * Everything else in this product watches. The recorder reads `window.fetch`
 * and `XMLHttpRequest` and writes down what went past; the locator reads
 * fibers; the graph counts what it was told. **This changes what the recorded
 * application sends to its own backend**, and that is a different kind of act
 * from everything around it — which is why the rule lives here, in a pure
 * module three inputs can be handed, rather than inside `patchedFetch` where it
 * could only be exercised by loading a page.
 *
 * ## The hazard, stated exactly, because "might break CORS" is not a rule
 *
 * A **simple request** — one the browser sends with no preflight — may carry
 * only CORS-safelisted headers: `Accept`, `Accept-Language`,
 * `Content-Language`, a `Content-Type` from a short list, and `Range`. Adding
 * any other header makes the request non-simple, so a **cross-origin** request
 * that previously went straight out now sends an `OPTIONS` preflight first. If
 * the backend does not name our header in `Access-Control-Allow-Headers`, the
 * browser **fails the request**, and the page's own `fetch` rejects.
 *
 * That is not a degraded recording. That is a working application broken by
 * DevFlow being installed — Invariant 1, and the same class of failure that got
 * `v3.2.0` reverted in a different subsystem.
 *
 * **That paragraph is measured, not reasoned.** It had been checked from the
 * specification and from the server side with `curl`, and neither of those
 * watches a browser decide — so it was run against real Chromium (Playwright
 * 1.62.1, Chromium build 1234). The setup is two origins and reproduces in ten
 * minutes: a page on `http://localhost:4311` fetching an API on
 * `http://localhost:4312`, where the API answers the preflight and allows the
 * origin and the method on **both** paths, and the only difference is that
 * `/allowed` names the header in `Access-Control-Allow-Headers` and
 * `/notallowed` does not. What the page saw: cross-origin with no custom header
 * → no `OPTIONS` at all, resolved. With `X-DevFlow-Trace-Id` against `/allowed`
 * → `OPTIONS` first, then the real request, and the API received the header.
 * Against `/notallowed` → `TypeError: Failed to fetch`, Chromium reporting
 * *"Request header field x-devflow-trace-id is not allowed by
 * Access-Control-Allow-Headers in preflight response"*. `traceparent` against
 * `/notallowed` failed identically, with the identical message — being a W3C
 * standard buys no exemption from the mechanism. And the same-origin control is
 * the other half of the asymmetry below: a page on `http://localhost:4313`
 * fetching its own origin carrying both headers, against a server that sends no
 * `Access-Control-*` headers at all and answers no `OPTIONS`, resolved — no
 * preflight, both headers arrived.
 *
 * **Same-origin requests are not subject to CORS at all**, so they cannot
 * preflight and cannot fail this way. That asymmetry is the whole design:
 *
 *   1. **Off by default.** A user who upgrades and reads no release notes must
 *      not have their traffic changed.
 *   2. **Same-origin freely, once it is on.** No preflight is reachable.
 *   3. **Cross-origin only for an origin the user has named.** An SPA on :3000
 *      calling an API on :8000 is the ordinary case and is *not* covered by
 *      rule 2 — so the allow-list exists, and putting an origin on it is the
 *      user saying "my backend accepts this". It is informed consent per
 *      backend, which is the only honest form it can take: DevFlow cannot
 *      discover whether a server allows a header without sending the request
 *      that might fail.
 *
 * The rule is deliberately not "try it and fall back". There is no falling back
 * from a failed preflight — by the time the browser reports it, the request the
 * page was waiting on has already rejected. The measurement adds a second
 * reason: the API process logged the `OPTIONS` and never a `GET`, so a failed
 * preflight leaves **no server-side evidence at all**. Somebody whose app breaks
 * this way sees a failed fetch in their browser and nothing whatsoever in their
 * backend's logs, which is close to the worst debugging position DevFlow could
 * put a person in.
 *
 * ## The limit: DevFlow cannot observe the preflight
 *
 * Measured with the same setup: page-level instrumentation saw an outbound `GET`
 * and then `net::ERR_FAILED`, and the `OPTIONS` never appeared at that layer,
 * because Chromium makes the preflight in the network service and does not
 * surface it as a page request. DevFlow patches `fetch` and `XMLHttpRequest`
 * *in the page*, so it can see the rejection and never the preflight that caused
 * it. Any future "did our header break this?" diagnostic has to be built on the
 * rejection alone — there is no layer here that can be asked what the preflight
 * said.
 *
 * ## `traceparent` and `X-DevFlow-Trace-Id` are two decisions, not one switch
 *
 * They carry different risk in both directions and are therefore separate:
 *
 *   - `traceparent` is **W3C Trace Context**, a standard a backend may already
 *     accept and already list in `Access-Control-Allow-Headers` — so it is more
 *     likely to work. That is a claim about what backends typically *allow*, not
 *     about the mechanism: measured, an unlisted `traceparent` preflight-fails
 *     exactly as the bespoke header does, with the same message. It is also more
 *     likely to *matter*: a page that already
 *     sends one has its own tracing, and overwriting it would corrupt somebody's
 *     production trace tree. So an existing `traceparent` is never replaced.
 *   - `X-DevFlow-Trace-Id` is bespoke. No backend accepts it by accident, which
 *     makes it strictly more likely to preflight-fail — and strictly easier to
 *     grep for in a log, which is the whole of its Tier 1 value.
 *
 * ## The sampled flag is a decision about somebody else's bill
 *
 * `traceparent`'s trace-flags byte is `01` here, meaning *sampled*. An unsampled
 * trace header is a header with no purpose: a backend running OpenTelemetry
 * honours the incoming flag, so `00` would ask it to record nothing and Tier 2
 * would have nothing to ingest. But it is worth saying out loud rather than
 * leaving in a constant: **turning this on causes the user's backend to record
 * traces it would otherwise have sampled away.** That is a real cost on
 * somebody's observability bill, and it is a reason the switch is off by
 * default that has nothing to do with CORS.
 *
 * ## One id per request, because that is what a trace id means
 *
 * Not per flow and not per step. A W3C trace identifies one distributed
 * operation — one request and the work it causes — so a per-flow id would tell
 * a backend that forty unrelated operations were one, which is a false
 * statement in somebody else's tracing system. The recording is what ties a
 * request back to its step; it already does that, and it does not need the
 * header's help.
 */

/** What the user has switched on. Every field is off or empty by default. */
export interface TracePolicy {
  /** `X-DevFlow-Trace-Id` — bespoke, greppable, never accepted by accident. */
  devflow: boolean;
  /** `traceparent` — W3C Trace Context, and never written over one the page set. */
  traceparent: boolean;
  /**
   * Cross-origin destinations the user has explicitly opted in, as origins
   * (`https://api.example.com`). Same-origin needs no entry and never consults
   * this list.
   */
  allowedOrigins: readonly string[];
}

export const NO_TRACING: TracePolicy = { devflow: false, traceparent: false, allowedOrigins: [] };

/**
 * Why a request was left alone. Each is a different thing to tell somebody who
 * asks why their header did not appear, which is why they are five words and
 * not one `false`.
 */
export type TraceRefusal =
  | 'off'
  | 'cross-origin'
  | 'already-traced'
  | 'unsafe-request'
  | 'bad-url'
  /**
   * Switched on, allowed, and nothing left to add — the page already sent our
   * own header and `traceparent` is off.
   *
   * A sixth reason rather than reusing `off`, because `off` says *the user has
   * this switched off* and would point whoever read it at the wrong fix. The
   * list exists to be five different things to tell somebody; one of them
   * meaning two things is the failure it was written against.
   */
  | 'nothing-to-add';

export type TraceDecision =
  | { inject: true; headers: Record<string, string>; traceId: string }
  | { inject: false; reason: TraceRefusal };

export const TRACE_HEADER = 'X-DevFlow-Trace-Id';
export const TRACEPARENT = 'traceparent';

/** 32 lowercase hex, and not all zeros — W3C forbids the zero trace-id. */
const TRACE_ID = /^[0-9a-f]{32}$/;
const SPAN_ID = /^[0-9a-f]{16}$/;

export const isTraceId = (value: unknown): value is string =>
  typeof value === 'string' && TRACE_ID.test(value) && !/^0+$/.test(value);

export const isSpanId = (value: unknown): value is string =>
  typeof value === 'string' && SPAN_ID.test(value) && !/^0+$/.test(value);

/**
 * The `traceparent` field value for one request.
 *
 * `00` is the only version defined, and `01` is the sampled flag — see the
 * header. Built here rather than interpolated at the call site because a
 * malformed `traceparent` is worse than none: a backend parsing it will either
 * reject the request or start a broken trace, and neither failure points
 * anywhere near DevFlow.
 */
export function traceparentValue(traceId: string, spanId: string): string | null {
  if (!isTraceId(traceId) || !isSpanId(spanId)) return null;
  return `00-${traceId}-${spanId}-01`;
}

/** The origin of a URL, or null when it has none this can compare. */
export function originOf(url: string, base?: string): string | null {
  try {
    const parsed = new URL(url, base);
    /*
     * `data:` and `file:` produce the opaque origin `"null"`, and an opaque
     * origin is never same-origin with anything — including itself.
     *
     * `blob:` does **not**, and this comment said it did until a test measured
     * it: a blob minted by a page is `blob:http://localhost:3000/<uuid>` and
     * its origin is `http://localhost:3000`, the page's own. That is the right
     * answer — a blob fetch is same-origin and cannot preflight — but the
     * sentence claiming otherwise was load-bearing and false, which is worse
     * than either behaviour.
     */
    return parsed.origin === 'null' ? null : parsed.origin;
  } catch {
    return null;
  }
}

/**
 * Whether this request may carry a header, and which headers those are.
 *
 * `canRebuild` is the caller's answer to a question only it can answer: whether
 * the request object can be reissued with an extra header without disturbing
 * what the page built. A `Request` carrying a streaming body is the case that
 * says no — and measurement is why the flag exists rather than an assumption:
 * `new Request(req, { headers })` marks the **original** as `bodyUsed`, so the
 * rebuild is not free and the recorder's own body clone has to happen first.
 * The safe failure is to send exactly what the page asked for.
 */
export function decideTrace(input: {
  /** The origin of the page making the request. */
  pageOrigin: string | null;
  /** The request's URL, as the page wrote it — relative is resolved against the page. */
  requestUrl: string;
  /** Header names the request already carries, in any case. */
  existingHeaders: readonly string[];
  policy: TracePolicy;
  canRebuild: boolean;
  /** 32 hex. Minted by the caller, which owns the randomness. */
  traceId: string;
  /** 16 hex. */
  spanId: string;
}): TraceDecision {
  const { policy } = input;
  if (!policy.devflow && !policy.traceparent) return { inject: false, reason: 'off' };
  if (!input.canRebuild) return { inject: false, reason: 'unsafe-request' };

  const target = originOf(input.requestUrl, input.pageOrigin ?? undefined);
  if (!target) return { inject: false, reason: 'bad-url' };

  /*
   * Same-origin is exempt from CORS entirely, so it cannot preflight and cannot
   * fail this way. Everything else needs the user to have named it — see the
   * header for why "try it and fall back" is not available.
   */
  if (target !== input.pageOrigin && !policy.allowedOrigins.includes(target)) {
    return { inject: false, reason: 'cross-origin' };
  }

  const present = new Set(input.existingHeaders.map((name) => name.toLowerCase()));

  /*
   * A page that already sends `traceparent` has its own tracing, and replacing
   * it would splice DevFlow into the middle of somebody's production trace tree
   * — reparenting spans under an id their backend has never seen. Refused
   * outright rather than skipping just that one header, because a request that
   * is already traced does not need a second id: the one it carries is the one
   * their backend will file the span under, and it is already in the recording.
   */
  if (present.has(TRACEPARENT)) return { inject: false, reason: 'already-traced' };

  const headers: Record<string, string> = {};
  if (policy.devflow && !present.has(TRACE_HEADER.toLowerCase())) {
    headers[TRACE_HEADER] = input.traceId;
  }
  if (policy.traceparent) {
    const value = traceparentValue(input.traceId, input.spanId);
    if (value) headers[TRACEPARENT] = value;
  }

  // Nothing is rebuilt for an empty change — and it is not reported as `off`;
  // see `nothing-to-add`.
  if (!Object.keys(headers).length) return { inject: false, reason: 'nothing-to-add' };

  return { inject: true, headers, traceId: input.traceId };
}

/**
 * The allow-list setting, as origins.
 *
 * Split on whitespace and commas, and every entry put through `URL` so that
 * what the user typed and what `decideTrace` compares are the same string. That
 * normalisation is the whole reason this is a function rather than a `.split()`
 * at the call site: `allowedOrigins.includes(target)` is an exact string
 * comparison, so `http://localhost:8000/` — which is what pasting from the
 * address bar gives you — would silently match nothing, and the user would see
 * no header, no error, and no way to tell which of the two they got wrong.
 * `http://localhost:8000/api` normalises to the same origin for the same
 * reason: naming a path is a reasonable thing to type and a meaningless thing
 * to compare.
 *
 * An entry that is not a URL at all is dropped rather than kept as a string
 * that can never match. Duplicates collapse.
 */
export function parseOrigins(raw: string | null | undefined): string[] {
  if (!raw) return [];

  const seen = new Set<string>();
  for (const piece of raw.split(/[\s,]+/)) {
    if (!piece) continue;
    const origin = originOf(piece);
    if (origin) seen.add(origin);
  }
  return [...seen];
}

/**
 * What a reader is told about a trace id on a recorded call.
 *
 * Tier 1 is the tier that needs no backend work at all, and its entire payoff is
 * this sentence: the id DevFlow put on the request is the id in the backend's
 * own logs, so a person or a model can go and grep for it. A header nobody can
 * see is a change to somebody's traffic in exchange for nothing, so this exists
 * before the injector does.
 */
export const describeTrace = (traceId: string): string =>
  `trace ${traceId} — search your backend logs for this id to find the server side of this request`;
