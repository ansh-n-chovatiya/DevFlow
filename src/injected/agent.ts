/**
 * MAIN-world agent, injected at `document_start`.
 *
 * Runs in the page's own JS context — the only place `console`, `fetch` and
 * `XMLHttpRequest` can be observed — and relays what it sees to the isolated
 * world with `postMessage`. `CustomEvent.detail` reads as null across the
 * MAIN/ISOLATED boundary, which is why this uses messages rather than events.
 */

import {
  AGENT_MESSAGE_SOURCE,
  BODY_CAP,
  CAPTURE_BODIES,
  CAPTURE_UNCAUGHT,
  CONSOLE_LEVELS,
  LOG_ARG_CAP,
  MAX_COMPONENT_CHAIN,
  MAX_FIBER_WALK,
  REACT_PREWARM_TTL_MS,
  STACK_FRAMES,
} from '../shared/constants.js';
import type { AgentConfig } from '../shared/messages.js';
import { redactUrl } from '../core/redact/index.js';

/**
 * What this agent has been told to do, and what it does until it is told.
 *
 * Mutable, and initialised to the compiled-in defaults. The MAIN world cannot
 * read `chrome.storage`, so the content script pushes settings down the control
 * channel — but this file runs at `document_start`, and a page can log, fetch
 * and throw in the window between injection and the first message arriving.
 * Starting from the defaults means that window behaves exactly as the extension
 * did before settings existed, rather than capturing nothing or capturing with
 * a zeroed cap.
 *
 * Every field is read at the point of use. Nothing in this file may copy one
 * into a module-level `const` — that value would be the default forever, and a
 * setting that appears to work while silently using the compiled-in value is
 * precisely the failure this arrangement exists to avoid.
 */
const config: AgentConfig = {
  captureBodies: CAPTURE_BODIES,
  bodyCap: BODY_CAP,
  consoleLevels: CONSOLE_LEVELS,
  logArgCap: LOG_ARG_CAP,
  stackFrames: STACK_FRAMES,
  captureUncaught: CAPTURE_UNCAUGHT,
  maxComponentChain: MAX_COMPONENT_CHAIN,
  maxFiberWalk: MAX_FIBER_WALK,
  prewarmTtlMs: REACT_PREWARM_TTL_MS,
};

/**
 * Take what the content script sent, field by field, ignoring anything else.
 *
 * The channel is `window.postMessage`, which any script on the page can post to,
 * so this treats the payload as untrusted input rather than as a config object:
 * a field of the wrong type leaves the current value alone. The values were
 * already clamped by `resolve()` on the other side; this is the second half of
 * the same rule, applied where the first half cannot be trusted to have run.
 */
function applyConfig(next: Partial<AgentConfig> | undefined): void {
  if (!next || typeof next !== 'object') return;

  if (typeof next.captureBodies === 'boolean') config.captureBodies = next.captureBodies;
  if (typeof next.bodyCap === 'number' && Number.isFinite(next.bodyCap)) {
    config.bodyCap = Math.max(0, next.bodyCap);
  }
  if (Array.isArray(next.consoleLevels)) {
    config.consoleLevels = CONSOLE_LEVELS.filter((level) => next.consoleLevels?.includes(level));
  }
  if (typeof next.logArgCap === 'number' && Number.isFinite(next.logArgCap)) {
    config.logArgCap = Math.max(1, next.logArgCap);
  }
  if (typeof next.stackFrames === 'number' && Number.isFinite(next.stackFrames)) {
    config.stackFrames = Math.max(0, next.stackFrames);
  }
  if (typeof next.captureUncaught === 'boolean') config.captureUncaught = next.captureUncaught;
  if (typeof next.maxComponentChain === 'number' && Number.isFinite(next.maxComponentChain)) {
    config.maxComponentChain = Math.max(1, next.maxComponentChain);
  }
  if (typeof next.prewarmTtlMs === 'number' && Number.isFinite(next.prewarmTtlMs)) {
    config.prewarmTtlMs = Math.max(0, next.prewarmTtlMs);
  }
  if (typeof next.maxFiberWalk === 'number' && Number.isFinite(next.maxFiberWalk)) {
    // Floored at one, not at the shipped default: a page can post here, and a
    // walk ceiling of zero would end React capture for the session while
    // looking exactly like a page with no React on it.
    config.maxFiberWalk = Math.max(1, next.maxFiberWalk);
  }
}

const SENSITIVE_HEADERS = /^(authorization|cookie|set-cookie|x-api-key)$/i;

function emit(detail: Record<string, unknown>): void {
  window.postMessage({ __flowsnap_source__: AGENT_MESSAGE_SOURCE, ...detail }, '*');
}

function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.test(key) ? '[redacted]' : value;
  }
  return out;
}

/**
 * A captured body, plus whether the cap bit — which is deliberately not part of
 * the body itself.
 *
 * The marker used to be appended inside the string. That made a truncated JSON
 * body unparseable, and everything downstream reads a body by parsing it: at
 * export `compactBody` saw a leading `{`, `JSON.parse` threw on the marker, and
 * a 300KB JSON response was written out as `[non-JSON · 50.0KB · truncated]`
 * with 300 characters of it — mislabelled, its size understated sixfold, and
 * never handed to the schema inference that exists for exactly that body.
 */
interface CappedBody {
  body: string | null;
  /** Only present when the cap bit; see `NetworkCall` in shared/types.ts. */
  truncated?: boolean;
  /** Length of the whole body, in characters, before the cut. */
  bytes?: number;
}

/** A body we are describing rather than quoting — never truncated, never cut. */
function stated(body: string | null): CappedBody {
  return { body };
}

/**
 * What stands in for a body when the user has switched body capture off.
 *
 * Nothing here may make a recording silently worse. A `null` body reads as
 * *this POST sent nothing*, which is a claim about the page rather than about
 * the recorder — and it is the claim a reader debugging a failed request acts
 * on first. Saying so costs one short string per call and cannot be mistaken
 * for data.
 */
const BODY_NOT_CAPTURED = '[body not captured — request/response bodies are switched off]';

function capBody(body: string | null): CappedBody {
  if (typeof body !== 'string') return stated(body);
  // Read here, never hoisted: see `config`. The switch is checked before the
  // cap because a body that is not being captured has no size worth reporting.
  if (!config.captureBodies) return stated(BODY_NOT_CAPTURED);
  const cap = config.bodyCap;
  return body.length > cap
    ? { body: body.slice(0, cap), truncated: true, bytes: body.length }
    : { body };
}

/** The out-of-band truncation fields for one body, under the given prefix. */
function truncation(prefix: 'request' | 'response', capped: CappedBody): Record<string, unknown> {
  if (!capped.truncated) return {};
  return { [`${prefix}BodyTruncated`]: true, [`${prefix}BodyBytes`]: capped.bytes };
}

/**
 * One console argument, as a string a reader can act on.
 *
 * `JSON.stringify(new Error('boom'))` is `"{}"` — `message` and `stack` are not
 * enumerable — so `console.error(err)`, the single most common way a page
 * reports a failure, was recorded as an empty object and the one line that
 * explained the bug was gone by the time anyone read the flow.
 */
function serializeArg(arg: unknown): string {
  if (arg instanceof Error) {
    const frame = arg.stack?.split('\n')[1]?.trim();
    return `${arg.name}: ${arg.message}${frame ? ` (${frame})` : ''}`;
  }
  try {
    return typeof arg === 'object' && arg !== null ? JSON.stringify(arg) : String(arg);
  } catch {
    return String(arg);
  }
}

function serializeArgs(args: unknown[]): string[] {
  // `config.logArgCap` — the per-argument ceiling, read per call. A page that
  // logs its whole store on every action was attaching hundreds of kilobytes to
  // each step, and every capture rewrites the entire step array, so the cost is
  // paid again on every step that follows.
  const cap = config.logArgCap;
  return args.map((arg) => {
    const text = serializeArg(arg);
    return text.length > cap ? `${text.slice(0, cap)}… [${text.length} chars total]` : text;
  });
}

// ── console ──────────────────────────────────────────────────────────────────
// Patching console is this file's entire purpose, so the no-console rule has
// nothing useful to say about it.
/* eslint-disable no-console */

/*
 * All five levels are patched, always; only the emit is filtered.
 *
 * Patching is a one-shot side effect at `document_start` — it has to happen
 * before the page logs anything, and it cannot be undone once another script has
 * taken a reference to `console.log`. So `console.levels` cannot gate the patch
 * without either missing the first lines of a page or leaving a level
 * permanently uncapturable after the setting is turned back on. It gates the
 * `emit` instead, which is read per call and can change mid-page.
 */
for (const level of CONSOLE_LEVELS) {
  const original = console[level].bind(console) as (...args: unknown[]) => void;
  console[level] = (...args: unknown[]) => {
    original(...args);
    try {
      if (!config.consoleLevels.includes(level)) return;
      emit({ kind: 'log', level, args: serializeArgs(args), timestamp: Date.now() });
    } catch {
      // Never let instrumentation break the page's own logging.
    }
  };
}

/* eslint-enable no-console */

// ── uncaught failures ────────────────────────────────────────────────────────

/**
 * Errors that never pass through `console`.
 *
 * An uncaught exception and a rejected promise nobody handled are printed to
 * devtools by Chrome itself, not by the page calling `console.error` — so the
 * interception above, which is the whole of this file's console capture, never
 * saw either of them. A recording made *because* the page threw came back with
 * an empty console, and the flow said nothing had gone wrong on the one step
 * where everything had.
 *
 * That is the highest-information artifact a bug report can carry — a stack
 * trace naming the file and line — and it was the one thing FlowSnap could not
 * record. The README documented the gap rather than closing it.
 *
 * Recorded as `error`, because that is what they are: everything downstream
 * that asks "did this step fail" reads the console level, and a genuine crash
 * that registered as a warning would be a step that failed silently in the
 * viewer, the export, the error tool and the failure summary alike.
 *
 * Listeners are passive and never call `preventDefault`, so the page's own
 * handlers, and Chrome's own reporting, see exactly what they saw before.
 */

function describeThrown(value: unknown): string {
  if (value instanceof Error) {
    // `config.stackFrames` — deeper frames are framework. Read per call.
    const frames = (value.stack ?? '').split('\n').slice(1, config.stackFrames + 1);
    const trace = frames.map((frame) => frame.trim()).filter(Boolean).join('\n');
    // The name and message first, on their own line, so a reader that keeps only
    // the first line of an entry still gets the part that says what happened.
    return `${value.name}: ${value.message}${trace ? `\n${trace}` : ''}`;
  }
  // A page can throw anything. `throw "nope"` and `Promise.reject(undefined)`
  // are both real, and both used to be invisible.
  return serializeArg(value);
}

function reportUncaught(prefix: string, value: unknown, fallback?: string): void {
  // The listeners are attached unconditionally, for the same reason the console
  // patch is: they are passive, and attaching them later would miss the crash
  // that happened while the setting was being read.
  if (!config.captureUncaught) return;

  try {
    /*
     * `null` and `undefined` take the fallback rather than being described.
     * `describeThrown(undefined)` returns the string `"undefined"`, which is
     * truthy — so a cross-origin `Script error.` with no error object attached
     * was reported as the word "undefined" and the filename and line that were
     * the only things it had were dropped.
     */
    const described = value == null ? '' : describeThrown(value);
    emit({
      kind: 'log',
      level: 'error',
      // Prefixed so a reader can tell a crash from a message the app chose to
      // print. `[uncaught]` in a flow means nobody handled this.
      args: serializeArgs([`${prefix} ${described || fallback || 'unknown error'}`]),
      timestamp: Date.now(),
    });
  } catch {
    // Never let instrumentation break the page's own error handling.
  }
}

window.addEventListener(
  'error',
  (event) => {
    /*
     * `error` fires for failed resource loads too — a broken <img>, a script
     * that 404ed — and those bubble to the window with the element as the
     * target. They are already visible as failed network calls, and reporting
     * them here would file a crash for a missing favicon.
     *
     * Tested by `nodeType` rather than `event.target !== window`, because that
     * comparison is a lie in any realm where the global is a proxy — under jsdom
     * a genuine window error has a target that prints as `[object Window]` and
     * is not `===` the `window` this file closed over, so the guard dropped the
     * exact events it was written to keep. A DOM node has a `nodeType`; a window
     * does not, in any realm.
     */
    const target = event.target as { nodeType?: number } | null;
    if (target && typeof target.nodeType === 'number') return;

    const where = event.filename ? ` (${event.filename}:${event.lineno}:${event.colno})` : '';
    reportUncaught('[uncaught]', event.error, `${event.message}${where}`);
  },
  true,
);

window.addEventListener(
  'unhandledrejection',
  (event) => {
    reportUncaught('[unhandled rejection]', event.reason);
  },
  true,
);

// ── fetch ────────────────────────────────────────────────────────────────────

const originalFetch = window.fetch.bind(window);

window.fetch = async function patchedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const method = init?.method ?? (input instanceof Request ? input.method : 'GET');
  const url = redactUrl(
    typeof input === 'string' ? input : input instanceof Request ? input.url : String(input),
  );

  // Normalised through `Headers` rather than read as a plain object. The array
  // form — `[['Authorization', 'Bearer …']]`, which generated API clients emit —
  // came back from `Object.entries` as `{ '0': [...] }`, so the key never
  // matched `SENSITIVE_HEADERS` and the name *and* its secret were both stored
  // verbatim. A polyfilled or cross-realm `Headers` failed `instanceof` the same
  // way.
  const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
  let headers: Record<string, string> = {};
  if (source) {
    try {
      headers = redactHeaders(Object.fromEntries(new Headers(source).entries()));
    } catch {
      // An exotic shape `Headers` will not take. Recording no headers is the
      // safe failure: recording them unredacted is not.
      headers = {};
    }
  }

  /*
   * The request body, from wherever `fetch` itself would take it.
   *
   * `init.body` wins when it is there, exactly as the platform resolves it.
   * Otherwise a fully-formed `Request` carries it — `fetch(new Request(url,
   * { method: 'POST', body }))` is the standard interceptor pattern — and that
   * body is a stream, so reading it means cloning.
   *
   * The clone is taken *now*, synchronously, because `originalFetch` consumes
   * the request and a clone taken afterwards throws "body already used". The
   * clone is *read* later, and nothing waits on the read: that is the whole
   * point of the shape below. `await`ing a body read before handing the page
   * its response is the bug this file already carries a comment about for
   * responses, and a streamed upload would hang a page the same way.
   *
   * The price is that a request body which never ends is a network entry that
   * is never emitted. That is the same trade made for responses, in the same
   * direction: the recording loses a line, the page keeps working.
   */
  let requestBody: CappedBody = stated(null);
  let pendingRequestBody: Promise<CappedBody> | null = null;

  if (init?.body != null) {
    requestBody = capBody(typeof init.body === 'string' ? init.body : '[non-string body]');
  } else if (input instanceof Request && input.body !== null && !config.captureBodies) {
    // Said, not read. Cloning a `Request` to describe a body we have been told
    // not to keep is work the switch exists to avoid — and on a streamed upload
    // the clone is the expensive half.
    requestBody = stated(BODY_NOT_CAPTURED);
  } else if (input instanceof Request && input.body !== null) {
    try {
      const clone = input.clone();
      pendingRequestBody = clone.text().then(
        (text) => capBody(text),
        () => stated('[unreadable request body]'),
      );
    } catch {
      // Already used, or a Request implementation that will not clone. Saying
      // so is still better than recording the POST as having sent nothing.
      requestBody = stated('[Request body]');
    }
  }

  /** Runs `send` once the request body is known, never blocking the caller. */
  const withRequestBody = (send: (body: CappedBody) => void): void => {
    if (pendingRequestBody) void pendingRequestBody.then(send);
    else send(requestBody);
  };

  const startedAt = Date.now();

  let response: Response;
  try {
    response = await originalFetch(input, init);
  } catch (err) {
    // Emitted from the body read's continuation rather than awaited here — the
    // page's `fetch` rejection must not queue behind our bookkeeping.
    withRequestBody((body) => {
      emit({
        kind: 'network',
        method,
        url,
        requestHeaders: headers,
        requestBody: body.body,
        ...truncation('request', body),
        status: null,
        responseHeaders: {},
        responseBody: `[network error: ${(err as Error).message}]`,
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      });
    });
    throw err;
  }

  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = SENSITIVE_HEADERS.test(key) ? '[redacted]' : value;
  });

  const report = (responseBody: CappedBody): void => {
    withRequestBody((body) => {
      emit({
        kind: 'network',
        method,
        url,
        requestHeaders: headers,
        requestBody: body.body,
        ...truncation('request', body),
        status: response.status,
        responseHeaders,
        responseBody: responseBody.body,
        ...truncation('response', responseBody),
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      });
    });
  };

  /*
   * The body is read *after* the response is handed back, never before.
   *
   * `await response.clone().text()` sat between the page's request and its
   * `fetch` resolving, so the page could not proceed until the entire body had
   * arrived — and for a stream that stays open, it never resolved at all. This
   * agent is injected into every page at `document_start` whether or not a
   * recording is running, so an SSE endpoint, a token stream or a long poll was
   * broken on every site the user visited with the extension installed.
   *
   * The cost of reading late is that a body which arrives after the next step
   * has been built is attached to that step instead. A slightly late network
   * entry is a far smaller wrong than a page that does not work.
   */
  const contentType = response.headers.get('content-type') ?? '';
  const declared = Number(response.headers.get('content-length') ?? '');
  if (!config.captureBodies) {
    // Before the clone, for the same reason as the request above: not reading
    // the body is most of what switching bodies off is worth.
    report(stated(BODY_NOT_CAPTURED));
  } else if (/text\/event-stream/i.test(contentType)) {
    // Cloning tees the stream: every chunk the page reads would also be buffered
    // here, for a body that by definition never ends.
    report(stated('[streaming response — not captured]'));
  } else if (Number.isFinite(declared) && declared > config.bodyCap * 4) {
    report(stated(`[body not captured — ${declared}b, over the capture limit]`));
  } else {
    void response
      .clone()
      .text()
      .then(
        (text) => report(capBody(text)),
        () => report(stated('[unreadable]')),
      );
  }

  return response;
};

// ── XMLHttpRequest ───────────────────────────────────────────────────────────

const OriginalXHR = window.XMLHttpRequest;

function PatchedXHR(this: unknown): XMLHttpRequest {
  const xhr = new OriginalXHR();

  let method = 'GET';
  let url = '';
  let requestBody: CappedBody = stated(null);
  let startedAt = 0;
  const requestHeaders: Record<string, string> = {};

  const originalOpen = xhr.open.bind(xhr);
  xhr.open = function open(m: string, u: string | URL, ...rest: unknown[]) {
    method = m || 'GET';
    url = redactUrl(String(u ?? ''));
    return (originalOpen as (...args: unknown[]) => void)(m, u, ...rest);
  };

  const originalSetHeader = xhr.setRequestHeader.bind(xhr);
  xhr.setRequestHeader = function setRequestHeader(key: string, value: string) {
    requestHeaders[key] = SENSITIVE_HEADERS.test(key) ? '[redacted]' : value;
    return originalSetHeader(key, value);
  };

  /*
   * Registered once, on the instance, rather than once per `send`.
   *
   * An XHR object may be reused — `open`/`send` again on the same instance is
   * how most long-poll and retry loops are written — and adding a listener
   * inside `send` meant the second send reported the response three times and
   * the third six, each copy carrying the *latest* method and url. The listener
   * count and the recorded payload both grew quadratically.
   */
  xhr.addEventListener('loadend', () => {
    try {
      const responseHeaders: Record<string, string> = {};
      for (const line of (xhr.getAllResponseHeaders() || '').split('\r\n')) {
        const idx = line.indexOf(': ');
        if (idx < 0) continue;
        const key = line.slice(0, idx);
        responseHeaders[key] = SENSITIVE_HEADERS.test(key) ? '[redacted]' : line.slice(idx + 2);
      }

      // In its own guard, and never inside the `emit` argument list. Reading
      // `responseText` throws `InvalidStateError` for any `responseType` other
      // than '' or 'text' — `xhr.responseType = 'json'` is the ordinary modern
      // idiom — and the throw took the whole entry with it, so the step recorded
      // no method, no url, no status: the flow simply claimed the click made no
      // request at all.
      let responseBody: CappedBody;
      try {
        responseBody = !config.captureBodies
          ? stated(BODY_NOT_CAPTURED)
          : xhr.responseType === '' || xhr.responseType === 'text'
            ? capBody(xhr.responseText || '')
            : stated(`[${xhr.responseType} response — not captured as text]`);
      } catch {
        responseBody = stated('[unreadable]');
      }

      emit({
        kind: 'network',
        method,
        url,
        requestHeaders,
        requestBody: requestBody.body,
        ...truncation('request', requestBody),
        status: xhr.status,
        responseHeaders,
        responseBody: responseBody.body,
        ...truncation('response', responseBody),
        durationMs: Date.now() - startedAt,
        timestamp: startedAt,
      });
    } catch {
      // Anything else the instrumentation cannot read; the page is unaffected.
    }
  });

  const originalSend = xhr.send.bind(xhr);
  xhr.send = function send(body?: Document | XMLHttpRequestBodyInit | null) {
    startedAt = Date.now();
    requestBody =
      body != null
        ? capBody(typeof body === 'string' ? body : '[non-string body]')
        : stated(null);

    return originalSend(body);
  };

  return xhr;
}

// Static members (UNSENT, DONE …) live on the constructor; instance methods live
// on the prototype. Both have to be preserved or feature detection breaks.
Object.setPrototypeOf(PatchedXHR, OriginalXHR);
PatchedXHR.prototype = OriginalXHR.prototype;
window.XMLHttpRequest = PatchedXHR as unknown as typeof XMLHttpRequest;

// ── React component capture ──────────────────────────────────────────────────
/*
 * Fibers are only reachable from here.
 *
 * React stores its fiber as an expando (`__reactFiber$…`) on the DOM node, and
 * expandos set by page scripts are invisible to an isolated-world content
 * script. So the walk has to happen in the page's own context — which is what
 * this file already is — and the result crosses to the recorder as a message,
 * like everything else in here.
 */

import { CONTROL_MESSAGE_SOURCE, REACT_PROBE_ATTEMPTS } from '../shared/constants.js';
import type { CapturedComponent, ControlMessage } from '../shared/messages.js';
import {
  type ChainEntry,
  type ChainResult,
  type ComponentFn,
  collectChain,
  hasReactRoot,
  interactionTarget,
} from '../core/react/fiber.js';
import { componentId, nameOnlyId } from '../core/react/id.js';
import { buildNeedle } from '../core/react/needle.js';

/** Watching only while something is recording — see ControlMessage. */
let reactActive = false;
/** Set once React is known to be on the page at all. */
let reactFound = false;
/** Interactions that found no component while no React root was visible. */
let reactProbes = 0;
/** Nothing here is React; listeners are gone and never come back for this document. */
let reactGaveUp = false;
let reactMetaSent = false;
/** True once any fiber has been seen carrying development-only bookkeeping. */
let sawDevelopmentFiber = false;

/**
 * Component identity by function.
 *
 * This is what makes the feature affordable: a forty-step flow through a real
 * app touches perhaps eight distinct components, so `toString()` and the hash
 * run eight times rather than once per component per click.
 */
const componentCache = new WeakMap<ComponentFn, CapturedComponent>();

/**
 * The chain computed on `pointerdown`, reused by the `click` that follows.
 *
 * One slot rather than a map: it exists to bridge a single gesture, and a cache
 * that outlives that would start answering with a tree the page has since
 * re-rendered.
 */
let prewarm: { el: Element; result: ChainResult; at: number } | null = null;

function describeEntry(entry: ChainEntry): CapturedComponent {
  const debugSource = entry.debugSource
    ? {
        source: entry.debugSource.fileName ?? '',
        line: Math.max(1, entry.debugSource.lineNumber ?? 1),
        column: Math.max(1, entry.debugSource.columnNumber ?? 1),
      }
    : null;

  if (!entry.fn) {
    // An unsettled lazy component. Its name is all there is, and forcing it to
    // resolve would mean recording the page changed what the page loaded.
    return { id: nameOnlyId(entry.name), name: entry.name, debugSource };
  }

  const cached = componentCache.get(entry.fn);
  // The cache is keyed by function, but `_debugSource` is per JSX call site, so
  // it is filled in from whichever usage first carried one rather than cached.
  if (cached) return debugSource && !cached.debugSource ? { ...cached, debugSource } : cached;

  let source = '';
  try {
    source = entry.fn.toString();
  } catch {
    // Exotic proxies can throw here; the name still tells the reader something.
    const nameOnly: CapturedComponent = { id: nameOnlyId(entry.name), name: entry.name, debugSource };
    componentCache.set(entry.fn, nameOnly);
    return nameOnly;
  }

  const built = buildNeedle(source);
  const captured: CapturedComponent = built.ok
    ? { id: componentId(entry.name, source), name: entry.name, needle: built.needle, debugSource }
    : { id: nameOnlyId(entry.name), name: entry.name, needleRejection: built.reason, debugSource };

  componentCache.set(entry.fn, captured);
  return captured;
}

// ── Script inventory ─────────────────────────────────────────────────────────

/**
 * URLs already reported, so each is sent once per document.
 *
 * Survives a stop/start inside one page: the worker's inventory is keyed by
 * origin and never forgets, so re-sending would be pure noise.
 */
const reportedScripts = new Set<string>();

let scriptsObserver: PerformanceObserver | null = null;

function reportScripts(urls: string[]): void {
  const fresh: string[] = [];
  for (const url of urls) {
    if (!url || reportedScripts.has(url)) continue;
    reportedScripts.add(url);
    fresh.push(url);
  }
  if (fresh.length) emit({ kind: 'scripts', urls: fresh });
}

/**
 * Starts reporting what the page loads.
 *
 * `buffered: true` replays entries from before recording began, which is what
 * makes this work at all — the bundles that matter loaded during page load, long
 * before anyone pressed record. The resource buffer is finite, so the `<script>`
 * tags are also read straight from the DOM: those are the ones a long-lived page
 * is most likely to have evicted.
 */
function startScriptInventory(): void {
  if (scriptsObserver) return;

  try {
    scriptsObserver = new PerformanceObserver((list) => {
      const urls: string[] = [];
      for (const entry of list.getEntries()) {
        if ((entry as PerformanceResourceTiming).initiatorType === 'script') urls.push(entry.name);
      }
      if (urls.length) reportScripts(urls);
    });
    scriptsObserver.observe({ type: 'resource', buffered: true });
  } catch {
    // No PerformanceObserver, or no resource timing. The DOM scan below still
    // finds the bundles the HTML asked for, which is most of them.
    scriptsObserver = null;
  }

  const fromDom: string[] = [];
  for (const script of Array.from(document.querySelectorAll('script[src]'))) {
    const src = (script as HTMLScriptElement).src;
    if (src) fromDom.push(src);
  }
  reportScripts(fromDom);
}

function stopScriptInventory(): void {
  scriptsObserver?.disconnect();
  scriptsObserver = null;
}

/** React's version, but only when the DevTools hook happens to be installed. */
function reactVersion(): string | undefined {
  try {
    const hook = (window as unknown as Record<string, unknown>).__REACT_DEVTOOLS_GLOBAL_HOOK__ as
      | { renderers?: Map<number, { version?: string }> }
      | undefined;
    if (!hook?.renderers) return undefined;
    for (const renderer of hook.renderers.values()) {
      if (renderer?.version) return renderer.version;
    }
  } catch {
    // A hostile or unusual hook object — the version is a nicety, not a need.
  }
  return undefined;
}

function sendReactMeta(detected: boolean): void {
  if (reactMetaSent) return;
  reactMetaSent = true;
  emit({
    kind: 'react-meta',
    detected,
    version: reactVersion(),
    build: !detected ? undefined : sawDevelopmentFiber ? 'development' : 'production',
  });
}

function chainFor(el: Element): ChainResult {
  // Read per call, like every other setting here — see `config` above.
  if (prewarm && prewarm.el === el && Date.now() - prewarm.at <= config.prewarmTtlMs) {
    return prewarm.result;
  }
  // Read per call, like every other setting here — see `config` above.
  const result = collectChain(el, config.maxComponentChain, config.maxFiberWalk);
  prewarm = { el, result, at: Date.now() };
  return result;
}

/**
 * Gives up on this document.
 *
 * Only after several interactions have found nothing *and* no React root is
 * visible: a single-page app can mount React after the first click, and a click
 * can land outside the root on a page that is React everywhere else.
 */
function abandonReact(): void {
  reactGaveUp = true;
  prewarm = null;
  detachReactListeners();
  stopScriptInventory();
  sendReactMeta(false);
}

function onReactInteraction(event: Event): void {
  if (!reactActive || reactGaveUp) return;

  // The composed target, not `event.target`: anything inside a shadow root is
  // retargeted to its host by the time a document listener sees it, and React
  // mounted in there would be invisible.
  const target = interactionTarget(event);
  if (!target) return;

  const result = chainFor(target);

  if (result.entries.length === 0) {
    if (reactFound) return; // React is here, this click simply was not in it
    reactProbes++;
    if (hasReactRoot(document)) {
      reactFound = true;
      return;
    }
    if (reactProbes >= REACT_PROBE_ATTEMPTS) abandonReact();
    return;
  }

  reactFound = true;
  if (result.entries.some((entry) => entry.development)) sawDevelopmentFiber = true;
  sendReactMeta(true);
  // Only once there is something to resolve: on a page with no React, the
  // observer would report bundles nobody will ever search.
  startScriptInventory();

  emit({
    kind: 'react',
    // The recorder claims this by the same number: one dispatch, one timeStamp,
    // identical in both worlds. Nothing else correlates the two safely.
    eventTime: event.timeStamp,
    chain: result.entries.map(describeEntry),
    truncated: result.truncated,
  });
}

/** Warms the chain so the click that follows pays nothing for it. */
function onReactPointerDown(event: Event): void {
  if (!reactActive || reactGaveUp) return;
  // Warmed against the same element the click will ask for, or the cache misses.
  const target = interactionTarget(event);
  if (target) chainFor(target);
}

const REACT_EVENTS = ['click', 'input', 'change'] as const;

function attachReactListeners(): void {
  document.addEventListener('pointerdown', onReactPointerDown, true);
  for (const type of REACT_EVENTS) document.addEventListener(type, onReactInteraction, true);
}

function detachReactListeners(): void {
  document.removeEventListener('pointerdown', onReactPointerDown, true);
  for (const type of REACT_EVENTS) document.removeEventListener(type, onReactInteraction, true);
}

window.addEventListener('message', (event: MessageEvent<ControlMessage>) => {
  // Same window, same origin — the same check the recorder applies to us.
  if (event.source !== window || event.origin !== window.location.origin) return;

  const data = event.data;
  if (!data || data.__flowsnap_control__ !== CONTROL_MESSAGE_SOURCE) return;
  if (reactGaveUp) return;

  // Applied before the recording check below returns early: a settings change
  // during a recording still has to reach the agent, and `recording` has not
  // changed in that case.
  applyConfig(data.config);

  const wanted = Boolean(data.recording);
  if (wanted === reactActive) return;

  reactActive = wanted;
  if (wanted) {
    attachReactListeners();
    // A second recording in the same page already knows this is React.
    if (reactFound) startScriptInventory();
  } else {
    detachReactListeners();
    stopScriptInventory();
    prewarm = null;
  }
});
