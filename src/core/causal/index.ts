/**
 * What in a recording plausibly caused what — and, on every edge, what was
 * actually seen.
 *
 * ## The graph is derived, never stored
 *
 * Every fact this file reads is already in the flow: the recorder's attribution
 * of a call to a step, the text of a log line, the body of a response, the
 * values a patch wrote. A stored graph would be a second copy of those facts,
 * kept in sync by hand and wrong the first time a step is deleted — and it would
 * not exist at all on the flows already sitting on people's disks, which are the
 * flows anybody actually wants to ask about. Derived, a rule sharpened here next
 * month reaches every recording ever made the moment the server updates.
 *
 * ## The bases are named, not scored
 *
 * A link carries a `basis` and a `confidence` word rather than a number, because
 * a number implies a precision this evidence does not have. `0.8` cannot be
 * argued with; *the log line contains the request's path* can — a reader who
 * knows the app can look at that sentence and say "that logger prints every URL,
 * that means nothing here", and no float ever invited that. Which is the whole
 * point: a guessed edge presented as a known one is worse than no edge, so
 * `detail` states what was observed and never what it implies.
 *
 * The four bases, weakest claim to strongest:
 *
 *   - `attributed` — the recorder filed this event under this step, because the
 *     step's buffer was open. That is temporal containment and nothing more; a
 *     poll on a timer lands in exactly the same place.
 *   - `followed`   — a failure was logged after a request failed. Ordering.
 *   - `named`      — the log line contains the request's own path.
 *   - `echoed`     — a value the store took appears in the response body.
 *
 * ## Order, and the tie-break
 *
 * A link may only point forwards, and `timestamp` alone cannot decide that: two
 * events routinely share a millisecond, and a state delta has no clock of its
 * own at all — it is measured from the interaction through to the app settling,
 * so it *ends* after everything else in its step. So the events are put in one
 * total order first, and "forwards" means forwards in that order:
 *
 *   1. the step they belong to, in flow order;
 *   2. within a step, the step itself, then its calls and logs, then its state
 *      deltas — the step heads its own step because the attribution is what put
 *      the rest there, and state comes last because that is when it was read;
 *   3. calls and logs against each other by `timestamp`;
 *   4. on an identical millisecond, the request before the log — a log *about* a
 *      request cannot precede it, and the reverse ordering invents an effect
 *      that came first;
 *   5. and finally recorded order, so two runs over one flow agree.
 *
 * `events` is emitted in that order, so its index *is* the order, and every
 * candidate link is dropped unless its `from` sits before its `to`.
 *
 * ## What is deliberately not linked
 *
 * **A step never causes the next step.** The user did that. Chaining them would
 * put every event in the recording downstream of step 1, which is a graph that
 * answers no question.
 *
 * **Nothing is paired across a step boundary.** A response that lands after the
 * user's next interaction gets no `named` or `echoed` edge to the request that
 * asked for it. The alternative is pairing on text alone across an unbounded
 * window, where the only evidence is that one endpoint was mentioned twice in a
 * session — a confident edge built on a coincidence. Both events are still
 * `attributed` to their own steps, and a reader can see them side by side.
 *
 * Pure — no DOM, no Chrome, no clock, no randomness.
 */

import { statusClass, urlPath } from '../flow/index.js';
import { fromPointer } from '../state/patch.js';

/**
 * One event inside a recording, named so a tool can be handed one back.
 *
 * `step:3` | `net:3.1` | `log:3.2` | `state:3/redux:0`
 *
 * A numeric index joins with `.` and a named one with `/`, which is what makes a
 * state ref — whose index is a store id *and* the delta's position, since a
 * malformed flow may carry two deltas for one store — unambiguous to read back.
 */
export type EventRef = string;

export type CausalBasis = 'attributed' | 'named' | 'echoed' | 'followed';
export type CausalConfidence = 'high' | 'medium' | 'low';

export interface CausalLink {
  from: EventRef;
  to: EventRef;
  basis: CausalBasis;
  confidence: CausalConfidence;
  /** One sentence naming what was actually seen, not what it implies. */
  detail: string;
}

export interface CausalEvent {
  ref: EventRef;
  kind: 'step' | 'network' | 'console' | 'state';
  /** One line a reader can identify it by, e.g. `GET /api/cart → 500`. */
  label: string;
  /** The step number this belongs to. */
  step: number;
  timestamp: number;
}

export interface CausalGraph {
  events: CausalEvent[];
  links: CausalLink[];
}

// ── The input ────────────────────────────────────────────────────────────────
//
// Structural, and as narrow as the rules allow, so that a `FlowPayload`, a step
// list held in the extension and a `flow.json` someone parsed off disk are all
// the same argument. Widened where this file does not care: `type` and `level`
// are strings rather than the unions, and a patch operation is a path and a
// value, because the `op` name answers nothing here — a `remove` wrote no value
// and so has nothing that could be echoed.

export interface CausalNetworkCall {
  method: string;
  url: string;
  /** `null` when the request failed before a response. */
  status: number | null;
  responseBody?: string | null;
  timestamp: number;
}

export interface CausalConsoleEntry {
  level: string;
  args: string[];
  timestamp: number;
}

export interface CausalStateDelta {
  store: string;
  patch: readonly { path: string; value?: unknown }[];
}

export interface CausalStep {
  timestamp: number;
  stepNumber?: number;
  type: string;
  action: string;
  url?: string;
  consoleLogs?: readonly CausalConsoleEntry[];
  networkCalls?: readonly CausalNetworkCall[];
  state?: readonly CausalStateDelta[];
}

export interface CausalFlow {
  steps: readonly CausalStep[];
}

// ── Thresholds ───────────────────────────────────────────────────────────────

/**
 * How short a path may be and still name a request.
 *
 * `/` is in every URL ever logged and `/a` is inside most sentences. Four
 * characters is the first width at which a real endpoint segment — `/api`,
 * `/cart` — clears the bar while the punctuation does not.
 */
const NAME_MIN_CHARS = 4;

/**
 * How long a value must be to count as evidence that a store took it from a
 * response.
 *
 * This is the number that decides whether `echoed` — the only basis claiming to
 * have watched a value move — is worth anything. `true`, `0`, `1`, `null` and
 * `""` are in every JSON body ever written, and so is every short status word an
 * app puts in an enum. Eight characters sits above all of them: above every
 * plausible enum member (`pending`, `active`, `error`), above every integer
 * below ten million, and above the English words a body is likely to contain by
 * accident — while still admitting what actually identifies a response: an order
 * id, an email, a slug, a UUID fragment, an ISO timestamp. Lower and the
 * false-positive rate is dominated by ordinary words; much higher and genuine
 * short identifiers start being rejected.
 *
 * Booleans, `null` and `undefined` are rejected outright rather than by length,
 * since their serialised forms would otherwise be a length question with an
 * obvious wrong answer at four and five characters.
 */
const ECHO_MIN_CHARS = 8;

/** Values pulled out of one delta before the search gives up. */
const ECHO_MAX_CANDIDATES = 64;

/** How deep into a written value the search looks for a scalar leaf. */
const ECHO_MAX_DEPTH = 6;

/** Characters a `label`, and a quoted value inside a `detail`, may run to. */
const LABEL_CAP = 120;
const DETAIL_VALUE_CAP = 48;

/**
 * Hops `causesOf` and `effectsOf` walk when the caller does not say.
 *
 * The honest chains this file builds are two or three long — step, request,
 * log. Eight leaves room for a flow that chains further without letting a
 * pathological one walk a recording end to end.
 */
const DEFAULT_MAX_DEPTH = 8;

const CONFIDENCE_RANK: Record<CausalConfidence, number> = { low: 0, medium: 1, high: 2 };

const KIND_TOKEN: Record<CausalEvent['kind'], string> = {
  step: 'step',
  network: 'net',
  console: 'log',
  state: 'state',
};

const TOKEN_KIND: Record<string, CausalEvent['kind']> = {
  step: 'step',
  net: 'network',
  log: 'console',
  state: 'state',
};

// ── Refs ─────────────────────────────────────────────────────────────────────

/**
 * Format a ref. The one place the syntax lives — see `EventRef`.
 *
 * **The numeric index is 1-based**, and the callers below pass it that way,
 * because a ref is read by a person and by a model and every other number
 * either of them sees in this project counts from one: the step numbers, the
 * `from`/`to` a range takes, the line a component was written on. `net:3.0`
 * beside "step 3" is the same one-character misreading `Pos0`/`Pos1` exists to
 * make impossible, and here there is no type to catch it — a ref is a string.
 * So the rule is carried by this function, and nothing else builds one.
 */
export function eventRef(
  kind: CausalEvent['kind'],
  step: number,
  index?: number | string,
): EventRef {
  const head = `${KIND_TOKEN[kind]}:${step}`;
  if (index === undefined) return head;
  return typeof index === 'number' ? `${head}.${index}` : `${head}/${index}`;
}

const REF_PATTERN = /^(step|net|log|state):(0|[1-9][0-9]*)(?:\.(0|[1-9][0-9]*)|\/(.+))?$/;

/**
 * Read a ref back, or `null` when it is not one.
 *
 * Exists so that a tool handed `log:3.2` by a model can jump to step 3 without
 * splitting the string itself: a ref parsed in two places is a syntax that has
 * already forked.
 */
export function parseEventRef(
  ref: EventRef,
): { kind: CausalEvent['kind']; step: number; index?: number | string } | null {
  const match = REF_PATTERN.exec(ref);
  if (!match) return null;
  const kind = TOKEN_KIND[match[1]];
  const step = Number(match[2]);
  if (match[3] !== undefined) return { kind, step, index: Number(match[3]) };
  if (match[4] !== undefined) return { kind, step, index: match[4] };
  return { kind, step };
}

// ── Reading the evidence ─────────────────────────────────────────────────────

/** Collapse whitespace and cut, so a label is one line of known width. */
function cap(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function statusText(status: number | null): string {
  return status === null ? 'no response' : String(status);
}

/**
 * `core/flow`'s `callFailed`, reached through the one function of that rule
 * which takes a status rather than a whole `NetworkCall` — this module's call
 * shape is deliberately a subset of it, so a second copy of the rule is the
 * thing to avoid, not the import.
 */
function requestFailed(status: number | null): boolean {
  const band = statusClass(status);
  return band === '4xx' || band === '5xx';
}

/**
 * The strings that would count as this request being named in a log line.
 *
 * The path first, because a logger prints `/api/cart` far more often than it
 * prints the origin, and the query-less URL as well, for the app that prints the
 * whole thing and for the request whose path is too short to mean anything on
 * its own. The query string is never matched on: it carries what differs between
 * two calls to one endpoint, so including it would make the match stricter in a
 * way that looks safer and simply misses.
 */
function requestNames(raw: string): string[] {
  let path = raw;
  let absolute = '';

  try {
    const parsed = new URL(raw);
    path = parsed.pathname;
    if (parsed.origin && parsed.origin !== 'null') absolute = parsed.origin + parsed.pathname;
  } catch {
    // A relative or malformed URL is still what the recorder wrote down, and the
    // part before the query is still the part a logger would print.
    const query = raw.indexOf('?');
    path = query === -1 ? raw : raw.slice(0, query);
  }

  const names: string[] = [];
  if (path.length >= NAME_MIN_CHARS) names.push(path);
  if (absolute.length >= NAME_MIN_CHARS && absolute !== path) names.push(absolute);
  return names;
}

/**
 * Scalar leaves of a written value that are long enough to identify something.
 *
 * Values only, never keys: `orderId` appears in every body about orders and
 * would make every patch that touched one look echoed. Booleans, `null` and
 * `undefined` are never collected at all — see `ECHO_MIN_CHARS`.
 */
function collectDiscriminating(value: unknown, out: string[], depth: number): void {
  if (out.length >= ECHO_MAX_CANDIDATES || depth > ECHO_MAX_DEPTH) return;

  if (typeof value === 'string') {
    if (value.length >= ECHO_MIN_CHARS) out.push(value);
    return;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const text = String(value);
    if (text.length >= ECHO_MIN_CHARS) out.push(text);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectDiscriminating(item, out, depth + 1);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) collectDiscriminating(item, out, depth + 1);
  }
}

/**
 * A value this patch wrote that is also in this response body, or `null`.
 *
 * A plain substring search, against the raw body rather than a re-serialisation
 * of it: the body is text as the server sent it, and matching `JSON.stringify`
 * of an object against it would turn key order and whitespace into the test. A
 * body cut at the capture cap can only cost an edge, never invent one.
 */
function echoedValue(delta: CausalStateDelta, body: string): string | null {
  const candidates: string[] = [];
  for (const op of delta.patch) {
    collectDiscriminating(op.value, candidates, 0);
    if (candidates.length >= ECHO_MAX_CANDIDATES) break;
  }
  for (const candidate of candidates) if (body.includes(candidate)) return candidate;
  return null;
}

// ── Labels ───────────────────────────────────────────────────────────────────

function stepLabel(step: CausalStep): string {
  const action = typeof step.action === 'string' ? step.action.trim() : '';
  return cap(action !== '' ? action : `${step.type} step`, LABEL_CAP);
}

function callLabel(call: CausalNetworkCall): string {
  const where = urlPath(call.url) || call.url;
  return cap(`${call.method} ${where} → ${statusText(call.status)}`, LABEL_CAP);
}

function logText(entry: CausalConsoleEntry): string {
  return (entry.args ?? []).join(' ');
}

function logLabel(entry: CausalConsoleEntry): string {
  return cap(`${entry.level}: ${logText(entry)}`, LABEL_CAP);
}

/**
 * `redux: cart, session`.
 *
 * The slice names are what a reader recognises, where the pointers themselves
 * are forty lines they will not read. Derived here through `fromPointer` rather
 * than through `core/state/keys`'s `touchedKeys`, whose argument is the exact
 * `PatchOp` union this module's looser input shape does not satisfy; the
 * escaping rule, which is the part worth sharing, is the same function.
 */
function stateLabel(delta: CausalStateDelta): string {
  const slices = new Set<string>();
  for (const op of delta.patch) {
    const [first] = fromPointer(op.path);
    if (first !== undefined) slices.add(first);
  }
  const names = [...slices].sort();
  const what = names.length > 0 ? names.join(', ') : `${delta.patch.length} operations`;
  return cap(`${delta.store}: ${what}`, LABEL_CAP);
}

// ── Building ─────────────────────────────────────────────────────────────────

/**
 * The number each step is addressed by.
 *
 * `stepNumber` is stamped at capture time and goes stale after a deletion — see
 * `renumber()` — and two events under one ref is a graph that cannot be walked.
 * So the stamped numbers are used while they are all distinct, and position is
 * used for the whole flow when they are not: a ref naming two things is a worse
 * failure than a ref disagreeing with a stale label.
 */
function stepNumbers(steps: readonly CausalStep[]): number[] {
  const stamped = steps.map((step, i) => step.stepNumber ?? i + 1);
  return new Set(stamped).size === stamped.length ? stamped : steps.map((_, i) => i + 1);
}

interface CallSlot {
  ref: EventRef;
  call: CausalNetworkCall;
  timestamp: number;
  arrival: number;
}

interface LogSlot {
  ref: EventRef;
  entry: CausalConsoleEntry;
  timestamp: number;
  arrival: number;
}

/** Derived from a flow, never stored — see the header. */
export function buildCausalGraph(flow: CausalFlow): CausalGraph {
  const steps = flow.steps ?? [];
  const numbers = stepNumbers(steps);

  const events: CausalEvent[] = [];
  const order = new Map<EventRef, number>();
  const candidates: CausalLink[] = [];

  const push = (event: CausalEvent): void => {
    // A ref reached twice would give one name to two events; the first wins, so
    // that a malformed flow costs an event rather than the whole walk.
    if (order.has(event.ref)) return;
    order.set(event.ref, events.length);
    events.push(event);
  };

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const n = numbers[i];
    const stepRef = eventRef('step', n);

    push({
      ref: stepRef,
      kind: 'step',
      label: stepLabel(step),
      step: n,
      timestamp: step.timestamp,
    });

    const calls: CallSlot[] = (step.networkCalls ?? []).map((call, index) => ({
      ref: eventRef('network', n, index + 1),
      call,
      timestamp: call.timestamp,
      arrival: index,
    }));
    const logs: LogSlot[] = (step.consoleLogs ?? []).map((entry, index) => ({
      ref: eventRef('console', n, index + 1),
      entry,
      timestamp: entry.timestamp,
      arrival: index,
    }));

    // Rules 3, 4 and 5 of the header's order: clock, then request-before-log on
    // a shared millisecond, then recorded order.
    const interleaved: (CallSlot | LogSlot)[] = [...calls, ...logs].sort((a, b) => {
      if (a.timestamp !== b.timestamp) return a.timestamp - b.timestamp;
      const rankA = 'call' in a ? 0 : 1;
      const rankB = 'call' in b ? 0 : 1;
      if (rankA !== rankB) return rankA - rankB;
      return a.arrival - b.arrival;
    });

    for (const slot of interleaved) {
      if ('call' in slot) {
        push({
          ref: slot.ref,
          kind: 'network',
          label: callLabel(slot.call),
          step: n,
          timestamp: slot.timestamp,
        });
      } else {
        push({
          ref: slot.ref,
          kind: 'console',
          label: logLabel(slot.entry),
          step: n,
          timestamp: slot.timestamp,
        });
      }
    }

    const deltas = (step.state ?? []).map((delta, index) => ({
      ref: eventRef('state', n, `${delta.store}/${index + 1}`),
      delta,
    }));
    for (const slot of deltas) {
      // A delta has no clock of its own: it spans the interaction through to the
      // app settling, so it wears the step's timestamp and sits last.
      push({
        ref: slot.ref,
        kind: 'state',
        label: stateLabel(slot.delta),
        step: n,
        timestamp: step.timestamp,
      });
    }

    // ── attributed ──
    const containment =
      `Recorded while step ${n} was the open step — containment, not proof; ` +
      `a request on a timer lands in exactly the same place.`;
    for (const slot of [...calls, ...logs, ...deltas]) {
      candidates.push({
        from: stepRef,
        to: slot.ref,
        basis: 'attributed',
        confidence: 'medium',
        detail: containment,
      });
    }

    // ── named ──
    for (const slot of calls) {
      const names = requestNames(slot.call.url);
      if (names.length === 0) continue;
      for (const log of logs) {
        const text = logText(log.entry);
        const hit = names.find((name) => text.includes(name));
        if (hit === undefined) continue;
        candidates.push({
          from: slot.ref,
          to: log.ref,
          basis: 'named',
          confidence: 'high',
          // Two requests to one endpoint before one log line both earn this
          // sentence, and it is true of both: the text names the path, and which
          // of the two it meant is the reader's call, not a tie this file breaks
          // silently by keeping only the nearer one.
          detail: `The log text contains this request's path "${hit}".`,
        });
      }
    }

    // ── echoed ──
    for (const slot of calls) {
      const body = slot.call.responseBody;
      if (typeof body !== 'string' || body === '') continue;
      for (const target of deltas) {
        const hit = echoedValue(target.delta, body);
        if (hit === null) continue;
        candidates.push({
          from: slot.ref,
          to: target.ref,
          basis: 'echoed',
          confidence: 'high',
          detail:
            `The value ${cap(JSON.stringify(hit), DETAIL_VALUE_CAP)} this patch wrote ` +
            `appears verbatim in the response body.`,
        });
      }
    }

    // ── followed ──
    let lastFailing: CallSlot | null = null;
    for (const slot of interleaved) {
      if ('call' in slot) {
        // Only a *failing* call resets this: a successful one in between is not
        // a competing explanation for an error being logged.
        if (requestFailed(slot.call.status)) lastFailing = slot;
        continue;
      }
      if (slot.entry.level !== 'error' || lastFailing === null) continue;
      candidates.push({
        from: lastFailing.ref,
        to: slot.ref,
        basis: 'followed',
        confidence: 'low',
        detail:
          `The error was logged after this failed request ` +
          `(${statusText(lastFailing.call.status)}), with no other failed request ` +
          `between them — ordering alone.`,
      });
    }
  }

  /*
   * One link per pair, and the strongest wins.
   *
   * A `named` edge and a `followed` edge over the same two events are one piece
   * of evidence described twice; keeping both would let a reader count the log
   * line's text and the log line's position as two reasons to believe. The Map
   * keeps a key's insertion position when its value is replaced, so the output
   * order is the order the bases were derived in and two runs agree.
   */
  const kept = new Map<string, CausalLink>();
  for (const link of candidates) {
    const from = order.get(link.from);
    const to = order.get(link.to);
    // Forwards only. See the header — an effect that precedes its cause is a bug,
    // and it is cheaper to lose the edge than to publish it.
    if (from === undefined || to === undefined || from >= to) continue;

    const key = `${link.from} ${link.to}`;
    const standing = kept.get(key);
    if (standing && CONFIDENCE_RANK[standing.confidence] >= CONFIDENCE_RANK[link.confidence]) {
      continue;
    }
    kept.set(key, link);
  }

  return { events, links: [...kept.values()] };
}

// ── Walking ──────────────────────────────────────────────────────────────────

/**
 * Breadth-first from `ref` along `links`, returning them in the order walked.
 *
 * The links rather than the nodes, because a caller rendering a tree needs to
 * know *why* each hop was taken, and re-deriving that from a node list means
 * looking every pair back up.
 *
 * A ref that names no event returns an empty array rather than throwing, and so
 * does a `maxDepth` of zero or less. This runs inside an MCP tool call holding a
 * ref a model typed, and `core/` answers a lookup that finds nothing with the
 * empty answer — `applyPatch` skips an operation whose path is gone, `worstLevel`
 * returns `null` for a step with no logs. A typo should cost a result, not the
 * process.
 */
function walk(
  graph: CausalGraph,
  ref: EventRef,
  maxDepth: number,
  backwards: boolean,
): CausalLink[] {
  if (maxDepth <= 0) return [];
  if (!graph.events.some((event) => event.ref === ref)) return [];

  const adjacent = new Map<EventRef, CausalLink[]>();
  for (const link of graph.links) {
    const near = backwards ? link.to : link.from;
    const bucket = adjacent.get(near);
    if (bucket) bucket.push(link);
    else adjacent.set(near, [link]);
  }

  // The graph is acyclic by construction, but this walks whatever it is handed:
  // a flow that somehow produced a cycle must cost an edge, not the process.
  const seen = new Set<EventRef>([ref]);
  const found: CausalLink[] = [];
  let frontier: EventRef[] = [ref];

  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth += 1) {
    const next: EventRef[] = [];
    for (const node of frontier) {
      for (const link of adjacent.get(node) ?? []) {
        // Each link lives in exactly one bucket and each node is drained once,
        // so no link is reported twice.
        found.push(link);
        const far = backwards ? link.from : link.to;
        if (seen.has(far)) continue;
        seen.add(far);
        next.push(far);
      }
    }
    frontier = next;
  }

  return found;
}

/** The links reachable backwards from `ref`, breadth-first, cycle-guarded. */
export function causesOf(
  graph: CausalGraph,
  ref: EventRef,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): CausalLink[] {
  return walk(graph, ref, maxDepth, true);
}

/** The links reachable forwards from `ref`, breadth-first, cycle-guarded. */
export function effectsOf(
  graph: CausalGraph,
  ref: EventRef,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): CausalLink[] {
  return walk(graph, ref, maxDepth, false);
}
