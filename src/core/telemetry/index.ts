/**
 * A production crash, reduced to the part the graph may keep.
 *
 * ## The reachability finding, stated first because it decides what this is
 *
 * A webhook receiver on loopback **cannot be reached by Sentry**. Their servers
 * cannot POST to `localhost:8787` any more than they can reach any other
 * machine behind a router, and no amount of code here changes that. So this is
 * not a direct integration and does not pretend to be one: it accepts a
 * delivery that somebody *relayed* (`smee.io`, an `ngrok` tunnel, a small
 * forwarder) or *replayed* (an exported event, `curl`ed in). The README says
 * so in those words.
 *
 * That is the same class of mistake `get_full_lineage`, `compare_flows_across_
 * deploys` and `get_living_architecture` each made — assuming a caller could
 * address something it cannot — and it is the fourth time, so it is written
 * down as a habit rather than as an incident.
 *
 * **This is the one piece of Phase 4 built against a documented shape rather
 * than a measured one.** The OTel work was settled by running a real
 * `@opentelemetry/sdk-trace-node` service and printing what arrived, and three
 * of the four wire facts it established would have been got wrong by reasoning.
 * No equivalent was possible here: there is no Sentry instance to point at this
 * machine. Everything below is therefore defensive about shape — every field is
 * checked before it is read, an unrecognised payload is refused rather than
 * partly understood — and the roadmap names the gap rather than implying a
 * verified integration.
 *
 * ## What is kept, and the much longer list of what is dropped
 *
 * A crash payload is **somebody else's user's data**. A Sentry event carries
 * `user` (id, email, ip_address), `request` (URL, headers, cookies, body),
 * `contexts`, `breadcrumbs` and `extra`, and the exception's own `value` is
 * routinely an interpolated string holding an order number, an email or a
 * token. None of that is what makes this useful, so none of it is read.
 *
 * What is kept is the *shape* of the failure and *where* it happened:
 *
 *   - the provider's own issue id, which is the only identifier here that is
 *     stable across deliveries — the ARKG's whole requirement for a node;
 *   - the exception **type** (`TypeError`), never its `value`;
 *   - the `culprit`, which names a function and a module;
 *   - the level, the event count, and when it was first and last seen;
 *   - the stack frames' **filenames and line numbers**, and nothing else from
 *     a frame — not `vars`, not `context_line`, not `pre_context`, each of
 *     which is a verbatim slice of the application's own memory or source.
 *
 * A field this does not name cannot reach the database, because the payload is
 * never handed on as it arrived: every value is read out by key, one at a time,
 * the way `POST /arkg/ingest-component` reads a pick.
 */

/** A frame reduced to what a source-file join needs. */
export interface ErrorFrame {
  /** The path as the provider reported it. Matched, never opened. */
  filename: string;
  /** One-based, as every stack trace and every editor counts. */
  lineno: number | null;
  /** Whether the provider marked this frame as the application's own code. */
  inApp: boolean;
}

/** One production issue, as the graph will hold it. */
export interface ProductionError {
  /** `<provider>:<issue id>` — stable across deliveries, which is why it is the key. */
  id: string;
  provider: 'sentry';
  /** The exception type, never its interpolated message. */
  type: string;
  /** The function and module the provider blames. */
  culprit: string | null;
  level: string | null;
  /** How many times the provider has seen this issue. */
  count: number;
  firstSeenMs: number | null;
  lastSeenMs: number | null;
  /** The provider's own page for the issue, when it gave one. */
  url: string | null;
  frames: ErrorFrame[];
}

/** Why a delivery was refused. Each is a different thing to do about it. */
export type RejectReason =
  | 'not-json'
  | 'not-an-object'
  | 'no-issue-id'
  | 'no-exception'
  | 'unsupported-action';

export type ParseResult =
  | { ok: true; error: ProductionError }
  | { ok: false; reason: RejectReason; detail: string };

/** Frames kept per issue. A stack is deep and only its top is a location. */
const MAX_FRAMES = 20;

/** Strings kept, because a title is read and not stored for its own sake. */
const MAX_TEXT = 200;

const text = (value: unknown, cap = MAX_TEXT): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.replace(/\s+/g, ' ').trim();
  return trimmed ? trimmed.slice(0, cap) : null;
};

/** A timestamp in whichever of the three shapes a provider used, or null. */
function millis(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Seconds or milliseconds. A ten-digit number is seconds until roughly the
    // year 2286, and a thirteen-digit one is milliseconds since 2001.
    return value > 1e11 ? value : value * 1000;
  }
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * The frames worth keeping, top of the stack first.
 *
 * Sentry lists frames oldest-first, so the *last* entries are where the error
 * actually happened — reversing here means the cap keeps the useful end. A
 * frame with no filename is dropped, since a filename is the only thing this
 * whole record joins on.
 *
 * `in_app` is carried rather than filtered on. A minified production build
 * frequently marks nothing as in-app, and dropping everything else would leave
 * a real crash with no frames at all; the flag is a hint the reader can weigh,
 * and `matchSourceFile` is what decides whether a path is really the
 * application's.
 */
function readFrames(exception: Record<string, unknown>): ErrorFrame[] {
  const stacktrace = exception.stacktrace;
  if (!stacktrace || typeof stacktrace !== 'object') return [];
  const raw = (stacktrace as Record<string, unknown>).frames;
  if (!Array.isArray(raw)) return [];

  const frames: ErrorFrame[] = [];
  for (const entry of [...raw].reverse()) {
    if (frames.length >= MAX_FRAMES) break;
    if (!entry || typeof entry !== 'object') continue;
    const frame = entry as Record<string, unknown>;
    const filename = text(frame.filename ?? frame.abs_path, 400);
    if (!filename) continue;
    const lineno = typeof frame.lineno === 'number' && Number.isFinite(frame.lineno) ? frame.lineno : null;
    frames.push({ filename, lineno, inApp: frame.in_app === true });
  }
  return frames;
}

/** The first exception entry that names a type, out of a `values` array. */
function firstException(event: Record<string, unknown>): Record<string, unknown> | null {
  const container = event.exception;
  if (!container || typeof container !== 'object') return null;
  const values = (container as Record<string, unknown>).values;
  if (!Array.isArray(values)) return null;
  for (const entry of values) {
    if (entry && typeof entry === 'object' && text((entry as Record<string, unknown>).type)) {
      return entry as Record<string, unknown>;
    }
  }
  return null;
}

/**
 * One delivery, parsed — or refused with a reason.
 *
 * Refusing is the common path for a webhook, and the reasons are separate
 * because they are separate things to do about them: a payload that is not JSON
 * is a misconfigured relay, one with no issue id is a provider shape this does
 * not know, and one with no exception is very often an ordinary *message* event
 * that simply has no location to file. Collapsing them into `400` would make a
 * working relay indistinguishable from a broken one.
 */
export function parseSentryDelivery(raw: string): ParseResult {
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'not-json', detail: 'the body was not JSON' };
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, reason: 'not-an-object', detail: 'the body was not a JSON object' };
  }

  const envelope = body as Record<string, unknown>;
  /*
   * Sentry wraps the payload in `data.event` for an issue alert and in
   * `data.issue` for an issue lifecycle hook, and a replayed raw event has no
   * wrapper at all. All three are unwrapped here rather than requiring the
   * caller to know which relay it has.
   */
  const data = envelope.data && typeof envelope.data === 'object' ? (envelope.data as Record<string, unknown>) : {};
  const event =
    (data.event && typeof data.event === 'object' ? (data.event as Record<string, unknown>) : null) ??
    (data.issue && typeof data.issue === 'object' ? (data.issue as Record<string, unknown>) : null) ??
    envelope;

  /*
   * Three spellings, because three envelope shapes reach here and each names
   * the issue differently: `issue_id` on an event inside an alert, `groupID`
   * on some older payloads, and `id` on an issue object. Preferring the
   * specific ones means a replayed raw *event* never keys on its own event id,
   * which happens once and would make every delivery a new node.
   */
  const issueId = text(event.issue_id, 64) ?? text(event.groupID, 64) ?? text(event.id, 64);
  if (!issueId) {
    return { ok: false, reason: 'no-issue-id', detail: 'no issue id, so nothing here is stable across deliveries' };
  }

  const exception = firstException(event);
  const metadata =
    event.metadata && typeof event.metadata === 'object' ? (event.metadata as Record<string, unknown>) : {};
  const type = text(exception?.type) ?? text(metadata.type);
  if (!type) {
    return {
      ok: false,
      reason: 'no-exception',
      detail: 'no exception type — a message event has no failure shape to record',
    };
  }

  const count = Number(event.count);

  return {
    ok: true,
    error: {
      id: `sentry:${issueId}`,
      provider: 'sentry',
      type,
      culprit: text(event.culprit),
      level: text(event.level, 32),
      count: Number.isFinite(count) && count > 0 ? Math.trunc(count) : 1,
      firstSeenMs: millis(event.firstSeen ?? event.first_seen),
      lastSeenMs: millis(event.lastSeen ?? event.last_seen ?? event.timestamp),
      url: text(event.web_url ?? event.permalink ?? event.url, 400),
      frames: exception ? readFrames(exception) : [],
    },
  };
}

/**
 * How a production error is described where one is printed.
 *
 * Says the count and the provider on every line, because the whole hazard of
 * mixing this with the runtime graph is a reader taking one number for the
 * other. `frequency` in the ARKG counts *recordings DevFlow made*; this counts
 * *events somebody else's users hit*, and the two must never be added.
 */
export function describeProductionError(error: {
  type: string;
  culprit: string | null;
  count: number;
  level: string | null;
  lastSeenMs: number | null;
}): string {
  const when = error.lastSeenMs ? new Date(error.lastSeenMs).toISOString().slice(0, 10) : 'unknown';
  return (
    `${error.type}${error.culprit ? ` in ${error.culprit}` : ''}  ` +
    `${error.count} event${error.count === 1 ? '' : 's'} in production` +
    `${error.level ? ` (${error.level})` : ''}  last ${when}`
  );
}
