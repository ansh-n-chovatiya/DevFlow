/**
 * Where one value in a recording came from — and what that claim is worth.
 *
 * ## This finds; it does not trace
 *
 * The name of the feature is "provenance", and the honest description of the
 * mechanism is narrower than the name: **DevFlow did not watch the value move.**
 * It has four independent observations of one recording — the bodies the server
 * sent, the operations the stores took, the values components were handed, and
 * the text the page showed — and this looks for the same value in all four and
 * reports where it turned up, in the order data flows through an application.
 *
 * That is worth a great deal and it is not a data-flow trace, and the difference
 * has to survive contact with a reader. `£42.00` appearing in a response body,
 * in a store write and in a cell is overwhelmingly one value moving through an
 * app. `2` appearing in all four is a coincidence four times over. So every hit
 * says what was actually seen, a value short enough to collide says so, and a
 * layer the recording never captured is named as *unsearched* rather than
 * quietly contributing an absence — the same rule `FlowState` and `FlowRenders`
 * follow, because a missing layer and an empty layer read identically and a
 * reader who cannot tell them apart takes the wrong one.
 *
 * The v3.2.0 attempt at this item was unreachable dead code: a module nothing
 * called, behind a tool that was never wired. What is here is reached by
 * `get_value_provenance` and returns what it found, including nothing.
 *
 * ## Why the layers are ordered the way they are
 *
 * Backend, then response, then store, then render, then DOM — the direction a
 * value travels in a React application, so reading the answer top to bottom
 * reads as the journey. It is a presentation order and nothing more: nothing
 * here concludes that the response *caused* the render, and two hits in
 * adjacent layers are two sightings rather than a link. `get_causal_chain` is
 * the tool that makes causal claims, and it makes them out of evidence about
 * events rather than about the equality of two strings.
 *
 * ## The backend layer, which is not like the other four
 *
 * Work Stream 3.2 asks for the chain to reach a controller and a query, and
 * Tier 2 is what supplies it. The roadmap's `get_full_lineage(domNodeId)` is
 * **not** built as a sixth tool beside this one and `get_backend_trace`: three
 * tools over one question is the mistake this repository has already made once
 * with its two markdown renderers, so the backend becomes a fifth layer here.
 * (`domNodeId` also does not survive contact — a recording *describes* an
 * element and addresses none, which is what `valueOfStep` is for.)
 *
 * Two things make this layer different from the four above it, and both have to
 * survive a reader.
 *
 * **It is not an observation the browser made.** The other four are four ways of
 * looking at one recording. These spans were exported by the user's own backend,
 * arrived separately, and are attached to the recording by the trace id DevFlow
 * minted and the backend echoed — 128 bits, not a string comparison. So *which
 * call* a span belongs to is known rather than inferred, and that is a stronger
 * link than anything else in this module.
 *
 * **The value search over it is exactly as weak as the other four.** A span
 * carries no response body — that is measured, not assumed, and `spanTexts`
 * carries the measurement. What it can carry is a query's text, a query string,
 * a request path, its own name and what an error said — so `£42.00` found in a
 * `db.query.text` and `£42.00` found in a response body are still two sightings
 * and not a lineage.
 * The strong link and the weak search live side by side here and the reply has
 * to keep them apart, which is why `backend.paths` is a separate thing from
 * `hits`: a path says "this is the server-side work behind that call", which is
 * known; a hit says "this text appeared in it", which is a sighting.
 *
 * One span is therefore **one** hit however many of its fields carried the
 * value, and that is the response layer's rule rather than a new one. A span
 * named `GET /api/v1/invoices` with `url.path` `/api/v1/invoices` matches twice
 * on one search and is one fact about one operation; printed as two sightings
 * it inflates the only thing this module asks a reader to weigh. So the fields
 * are named together in one `detail` — nothing is lost — and the count of
 * sightings stays a count of places rather than a count of attributes.
 *
 * Pure — no DOM, no Chrome, no clock, no randomness. The spans arrive as an
 * argument for `core/otel`'s reason: which spans are admissible is a decision,
 * and reading them off a socket is not.
 */

import type { FlowPayload, PatchOp, RenderChange, Step } from '../../shared/types.js';
import { flattenTree, type OtelSpan, type SpanKind, type SpanNode, type TraceJoin } from '../otel/index.js';
import type { Pos1 } from '../locate/positions.js';

/**
 * The five places one value is looked for.
 *
 * Four of them are independent observations of one recording. `backend` is the
 * fifth and is not one of those — see the header.
 */
export type ProvenanceLayer = 'backend' | 'response' | 'store' | 'render' | 'dom';

/** How much of what was found the value accounted for. */
export type ProvenanceMatch = 'exact' | 'within';

/** One place in one recording where the value was found. */
export interface ProvenanceHit {
  layer: ProvenanceLayer;
  /** The step this sighting belongs to, as the recording numbers steps. */
  step: number;
  /** Where in that layer: an endpoint and a pointer, a store, a component, a selector. */
  where: string;
  /** What was seen, in the words a reader can disagree with. */
  detail: string;
  match: ProvenanceMatch;
}

/** A layer the recording does not carry, and why it does not. */
export interface UnsearchedLayer {
  layer: ProvenanceLayer;
  reason: string;
}

/**
 * One step of the server-side work behind a call.
 *
 * A span flattened to what a reader can act on. `statement` is the query text
 * exactly as the user's own tracer recorded it, parameterised or not as their
 * instrumentation left it — never rewritten, because showing somebody a tidied
 * query their database never saw would be the wrong kind of helpful.
 */
export interface BackendHop {
  /** Depth from the root of the trace, so the shape survives a flat list. */
  depth: number;
  service: string;
  name: string;
  kind: SpanKind;
  durationMs: number;
  failed: boolean;
  /** `code.filepath` and `code.lineno`, when the instrumentation records them. */
  file: string | null;
  line: Pos1 | null;
  /** `db.query.text`, when the span describes a query. */
  statement: string | null;
  /**
   * `http.response.status_code`, so a 404 hop and a 500 hop do not read alike.
   *
   * `failed` alone collapses them: both render as the same bold word, and "the
   * handler could not find it" and "the handler fell over" are the two answers
   * somebody opening this tool is trying to choose between.
   */
  status: number | null;
  /**
   * The query string, which is where a value most often travels in plain sight.
   *
   * Measured: it is one of only three places in a trace a value a person can
   * read off the screen was ever observed. `spanTexts` searches it; without it
   * here the chain cannot show the reader the thing the search just found.
   */
  query: string | null;
  /**
   * Why the hop failed, in the two words a tracer records it in.
   *
   * `failed` and `status` say *that* it broke and with what code; these say
   * what broke. They are here because the renderer they feed already printed
   * them for `get_backend_trace` and could not for this — the same span showed
   * its reason in one tool and a bare **FAILED** in the other, which is the
   * asymmetry a shared renderer exists to make impossible. A chain is opened
   * when a value is wrong, so the failure in it is rarely incidental.
   */
  exceptionType: string | null;
  exceptionMessage: string | null;
  /** `status.message`, which is what a span that failed without throwing has. */
  statusMessage: string | null;
  /** This hop's own text carried the value — a sighting, on the terms above. */
  carried: boolean;
}

/*
 * There is no `stacktrace` here, and its absence is a decision rather than an
 * oversight. **Search and display are different budgets.** `spanTexts` reads
 * `exception.stacktrace` because it is the one field measured to survive
 * parameterisation — the very span whose `db.query.text` said `where id = ?`
 * had a stack trace saying `where id = '8814'` — so a search that skipped it
 * would miss the literal on exactly the failure path somebody asking "why is
 * this value wrong" is already on. A *hop* is a line in a printed chain, and a
 * stack trace is kilobytes of frame paths and byte offsets; printing one per
 * hop would bury the chain it is part of. The `detail` of the hit carries a
 * window around the match, which is the part of it worth reading.
 *
 * Said out loud because the asymmetry looks like an inconsistency, and the
 * obvious "fix" in either direction — dropping the field from the search, or
 * adding it to the hop — undoes one of the two decisions.
 */

/**
 * The server-side work behind one call the value was seen at.
 *
 * "Seen at" is either end: the call's response body carried the value, or a
 * span under its trace did. Both are reasons to want the chain, and requiring
 * the first would lose the case the roadmap actually names — a value that
 * reaches the screen through a body DevFlow did not capture, whose query the
 * backend did record.
 *
 * A path is a *known* attachment and its hops are *sightings*. The call and its
 * spans are joined by a trace id DevFlow minted; that the value is in one of
 * them is string equality and nothing more.
 */
export interface BackendPath {
  /** The step the call belongs to, as the recording numbers steps. */
  step: number;
  /** The call, worded as the response layer words it. */
  where: string;
  traceId: string;
  /** Distinct services the trace touched, in first-seen order. */
  services: string[];
  /** The operations under that trace, parents before children. */
  hops: BackendHop[];
  /** Hops beyond the cap. */
  more: number;
}

/**
 * What the caller was able to ask the span store, and why it might be nothing.
 *
 * Three states rather than a nullable list, because they are three different
 * things to tell somebody whose backend is not appearing and each sends them
 * somewhere different — the same distinction `get_backend_trace` keeps, and for
 * the same reason: telling a reader "no backend data" when the truth is "your
 * exporter has not sent it yet" sends them to change a setting that was already
 * correct.
 */
export type BackendInput =
  | { available: false; reason: 'ingest-off' }
  | {
      available: true;
      /** Traced calls spans have arrived for, already joined by `joinTrace`. */
      joined: readonly TraceJoin[];
      /** Trace ids the recording carries that no span has arrived for. */
      awaiting: readonly string[];
      /** Traced calls the recording carries at all. Zero means no header went out. */
      tracedCalls: number;
    };

/** What the backend layer found, beside its hits. */
export interface BackendReading {
  /** The server-side work behind the calls the value was seen at. */
  paths: BackendPath[];
  /** Paths beyond the cap. */
  more: number;
  /**
   * Traced calls whose spans have not arrived, counted even when others joined.
   *
   * A partial answer that reads as a whole one is the failure this exists to
   * prevent: three of a recording's four traced calls rendering as the whole
   * backend story is worse than none of them rendering at all.
   */
  awaiting: number;
}

export interface ProvenanceResult {
  /** The needle, exactly as it was searched for. */
  value: string;
  /** Hits, in layer order — see the header for why that order is not a claim. */
  hits: ProvenanceHit[];
  /** Hits found beyond the per-layer cap, by layer. */
  more: Partial<Record<ProvenanceLayer, number>>;
  unsearched: UnsearchedLayer[];
  /**
   * The value is short enough that an equal string is as likely to be a
   * coincidence as a sighting.
   */
  collides: boolean;
  backend: BackendReading;
}

/**
 * Hits listed for one layer.
 *
 * Tier 3. A value that turns up in nine places in one layer has told the reader
 * what it is going to tell them by the third; the rest is the count.
 *
 * "Place" means the same thing in all five layers, which is what makes one cap
 * and one `more` count legible across them: one call's body, one store write,
 * one component's prop, one element — and one **span**, not one span attribute.
 */
const HITS_PER_LAYER = 8;

/**
 * Hops printed for one backend path, and paths printed at all.
 *
 * A trace is not bounded by anything on this machine — an N+1 query in
 * somebody's handler is four hundred spans of one recorded click — so the cap
 * is what stops one call's chain being the whole answer. The count beside it is
 * the fact a reader needs: "and 380 more" is itself the finding.
 */
const HOPS_PER_PATH = 12;
const PATHS_SHOWN = 4;

/** Nodes walked in one parsed body, and how deep. A response is not a database. */
const WALK_NODES = 20_000;
const WALK_DEPTH = 12;

/**
 * Below this, an equal string is not evidence.
 *
 * `"1"`, `"ok"` and `"12"` occur in an ordinary recording by the dozen, in
 * every layer, with no relationship between the sightings at all. The search
 * still runs — refusing it outright would be deciding for the reader — and the
 * result says the value collides, so the listing is read as what it is.
 */
const COLLIDING_LENGTH = 4;

/**
 * Every field read out of a flow is untrusted.
 *
 * A `flow.json` arrives over loopback from anything on this machine that can
 * reach the port, and `POST /flows` validates its id and that `steps` is an
 * array and nothing else. Not from any page the browser visits, which is what
 * this said and is not true: `extensionOrigin` admits a request with no
 * `Origin` header or an extension's, and a browser attaches one to every
 * cross-origin POST. A local process is the reachable writer, which leaves
 * every field below exactly as untrusted as before. `mcp-server/server.js` already treats a step this way where it
 * *prints* one; this is reached by the same object through a different door,
 * and a `text` that is a number turns an answer into a protocol error rather
 * than into a smaller answer.
 */
function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** An array, or an empty one — a `networkCalls: 5` is not iterable. */
function list<T>(value: unknown): readonly T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function collapse(text: string): string {
  return str(text).replace(/\s+/g, ' ').trim();
}

/** RFC 6901: `~` and `/` are the two characters a pointer segment must escape. */
function pointerSegment(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * The first path inside a parsed value whose leaf is the needle, and how many
 * paths there were.
 *
 * The first rather than all of them, with the count beside it: a response that
 * carries one price in forty rows is one fact about the response, and forty
 * pointers is the same fact spelled at forty times the price. Bounded in nodes
 * and depth because a body is whatever the server sent.
 */
function findInValue(
  value: unknown,
  needle: string,
): { pointer: string; count: number } | null {
  let first: string | null = null;
  let count = 0;
  let nodes = 0;

  const walk = (node: unknown, pointer: string, depth: number): void => {
    if (nodes++ > WALK_NODES || depth > WALK_DEPTH) return;

    if (node !== null && typeof node === 'object') {
      if (Array.isArray(node)) {
        for (let i = 0; i < node.length; i++) walk(node[i], `${pointer}/${i}`, depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        walk(child, `${pointer}/${pointerSegment(key)}`, depth + 1);
      }
      return;
    }

    // Primitives compared as text, so a needle typed by a person finds a number
    // the server sent. `null` is compared too — it is a value an app can show.
    if (String(node) !== needle) return;
    count++;
    if (first === null) first = pointer === '' ? '/' : pointer;
  };

  walk(value, '', 0);
  return first === null ? null : { pointer: first, count };
}

/** Parsed, or null — a body may be a schema summary, HTML, or cut at the cap. */
function parsed(body: string | null | undefined): unknown {
  if (typeof body !== 'string' || !body) return null;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return null;
  }
}

function stepNumber(step: Step, index: number): number {
  return typeof step.stepNumber === 'number' ? step.stepNumber : index + 1;
}

/**
 * A run of the page's own text, cut to length and quoted.
 *
 * Its own function rather than `shown()` with the quotes sliced off, which is
 * what it was and what was wrong with it: `shown` puts its ellipsis *after* the
 * closing quote, so stripping the first and last characters of a truncated
 * string removes the ellipsis and leaves the cut text reading as the whole of
 * what the element said — a claim about the page made out of a formatting
 * mistake. Here the cut is inside the quotes, where a reader sees it.
 */
function quoted(text: string, cap: number): string {
  return text.length > cap ? `"${text.slice(0, cap)}…"` : `"${text}"`;
}

/**
 * A window of a long text *around* the value, quoted, with the cuts inside.
 *
 * `quoted` takes the head, which is right for an element's text: a cell is
 * short and starts where the reader was looking. A span's stack trace is
 * kilobytes and the value can be four frames down, so a head cut quotes text
 * the needle is not in — evidence that reads as an argument against the very
 * hit it is printed beneath. Here the window is centred on the match and both
 * ends say they were cut, on `quoted`'s rule that the cut goes inside the
 * quotation marks where a reader can see it.
 */
function around(text: string, needle: string, cap: number): string {
  if (text.length <= cap) return `"${text}"`;
  const at = text.indexOf(needle);
  const lead = Math.max(0, Math.floor((cap - needle.length) / 2));
  const start = at <= lead ? 0 : at - lead;
  const end = Math.min(text.length, start + cap);
  return `"${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}"`;
}

/** A short, quoted form of a found value, for a `detail` sentence. */
function shown(value: unknown, cap = 60): string {
  let encoded: string;
  try {
    encoded = JSON.stringify(value) ?? String(value);
  } catch {
    return '(unprintable)';
  }
  return encoded.length > cap ? `${encoded.slice(0, cap)}…` : encoded;
}

// ── The four searches ────────────────────────────────────────────────────────

/**
 * One recorded call, keyed the way `tracedCallsOf` keys the same call.
 *
 * The two have to agree exactly or a response hit never finds the trace behind
 * it, so the defaults are applied in both places and nowhere else: a call with
 * no method is a `GET` and a call with no url is the empty string, and both
 * sides read those out of untrusted JSON.
 */
function callKey(step: number, method: unknown, url: unknown): string {
  return `${step}\u0000${methodOf(method)} ${str(url)}`;
}

/**
 * A call's method, defaulted exactly as `tracedCallsOf` defaults it.
 *
 * Named so that the key and the sentence printed beside it cannot disagree.
 * They did: `callKey` read a missing method as `GET` while the response layer's
 * `where` interpolated `call.method` straight, so a call that carried no method
 * — `POST /flows` validates neither method nor url — joined correctly to its
 * trace and was then rendered above it as `undefined https://…`.
 */
function methodOf(method: unknown): string {
  return typeof method === 'string' && method ? method : 'GET';
}

function inResponses(
  steps: readonly Step[],
  needle: string,
  hits: ProvenanceHit[],
  carried: Set<string>,
): void {
  steps.forEach((step, index) => {
    for (const call of list<NonNullable<Step['networkCalls']>[number]>(step.networkCalls)) {
      const body = parsed(call.responseBody);
      const found = body === null ? null : findInValue(body, needle);
      if (found) {
        carried.add(callKey(stepNumber(step, index), call.method, call.url));
        hits.push({
          layer: 'response',
          step: stepNumber(step, index),
          where: `${methodOf(call.method)} ${str(call.url)}  ${found.pointer}`,
          detail:
            `The response carried it at ${found.pointer}` +
            `${found.count > 1 ? `, and at ${found.count - 1} other path${found.count === 2 ? '' : 's'}` : ''}` +
            `${call.status === null ? ' (the request failed before a response)' : ` (${call.status})`}.`,
          match: 'exact',
        });
        continue;
      }

      /*
       * A body that is not JSON, or one cut at the capture cap, still has text
       * in it — and a value found in a truncated body is a weaker sighting
       * rather than no sighting, so it is reported as `within` and the cut is
       * named. Skipped entirely when the body parsed: a JSON body that did not
       * hold the value at any path does not hold it in its punctuation either.
       */
      if (body !== null) continue;
      const raw = call.responseBody;
      if (typeof raw !== 'string' || !raw.includes(needle)) continue;
      carried.add(callKey(stepNumber(step, index), call.method, call.url));
      hits.push({
        layer: 'response',
        step: stepNumber(step, index),
        where: `${methodOf(call.method)} ${str(call.url)}`,
        detail:
          'The response body contains it as text — the body is not JSON' +
          `${call.responseBodyTruncated ? ', and was cut at the capture cap' : ''}, so there is no path to name.`,
        match: 'within',
      });
    }
  });
}

function inStores(steps: readonly Step[], needle: string, hits: ProvenanceHit[]): void {
  steps.forEach((step, index) => {
    for (const delta of list<NonNullable<Step['state']>[number]>(step.state)) {
      for (const op of list<PatchOp>(delta?.patch)) {
        if (op.op === 'remove') continue;
        const found = findInValue(op.value, needle);
        if (!found) continue;
        // The operation's own path, then the path inside its value: together
        // they are the pointer into the store the reader would use.
        const pointer = found.pointer === '/' ? op.path : `${op.path}${found.pointer}`;
        hits.push({
          layer: 'store',
          step: stepNumber(step, index),
          where: `${delta.store}  ${pointer}`,
          detail:
            `The store was written with it: ${op.op} ${op.path} = ${shown(op.value)}` +
            `${delta.bounded ? '. The snapshot was cut at its caps, so this is a bounded view of the store' : ''}.`,
          match: 'exact',
        });
      }
    }
  });
}

function inRenders(steps: readonly Step[], needle: string, hits: ProvenanceHit[]): void {
  steps.forEach((step, index) => {
    for (const render of list<NonNullable<Step['renders']>[number]>(step.renders)) {
      const kinds: [string, readonly RenderChange[]][] = [
        ['prop', list<RenderChange>(render?.props)],
        ['hook', list<RenderChange>(render?.hooks)],
        ['context', list<RenderChange>(render?.contexts)],
      ];

      for (const [kind, changes] of kinds) {
        for (const change of changes) {
          const after = findInValue(change.after, needle);
          const before = after ? null : findInValue(change.before, needle);
          if (!after && !before) continue;
          hits.push({
            layer: 'render',
            step: stepNumber(step, index),
            where: `${render.component}  ${kind} ${change.key}`,
            detail: after
              ? `The component was handed it: ${kind} "${change.key}" became ${shown(change.after)}.`
              : `The component held it before this step: ${kind} "${change.key}" was ${shown(change.before)} and changed.`,
            match: 'exact',
          });
        }
      }
    }
  });
}

function inDom(steps: readonly Step[], needle: string, hits: ProvenanceHit[]): void {
  const flat = collapse(needle);

  steps.forEach((step, index) => {
    const number = stepNumber(step, index);
    const where = str(step.element?.cssSelector) || `step ${number}`;

    const text = collapse(step.element?.text ?? '');
    if (text && text.includes(flat)) {
      hits.push({
        layer: 'dom',
        step: number,
        where,
        detail:
          text === flat
            ? 'The element interacted with said exactly this.'
            : `The element interacted with said ${quoted(text, 80)}.`,
        match: text === flat ? 'exact' : 'within',
      });
    }

    if (typeof step.value === 'string' && collapse(step.value).includes(flat)) {
      hits.push({
        layer: 'dom',
        step: number,
        where,
        // Worth its own line: a value the *user typed* is where a value entered
        // the application, which is the end of the trace rather than a step in it.
        detail: 'The user typed it into this element — this is where it entered the app.',
        match: collapse(step.value) === flat ? 'exact' : 'within',
      });
    }

    const after = collapse(step.domDelta?.after ?? '');
    if (after && after.includes(flat)) {
      hits.push({
        layer: 'dom',
        step: number,
        where,
        detail: 'It was in the text around the element once the interaction had settled.',
        match: 'within',
      });
    }

    for (const change of list<NonNullable<NonNullable<Step['domChanges']>['changes']>[number]>(step.domChanges?.changes)) {
      if (!change?.what || !collapse(change.what).includes(flat)) continue;
      hits.push({
        layer: 'dom',
        step: number,
        where: str(change.where),
        detail: `It appeared in the page: ${str(change.kind) || 'changed'} — ${str(change.what)}.`,
        match: 'within',
      });
    }
  });
}

/**
 * The fields of a span that can carry a value somebody read off the screen.
 *
 * The list is short because a span is short: OTLP carries attributes, not
 * bodies, so there is no server-side equivalent of the response layer's walk
 * through a parsed document. `core/otel`'s second live capture measured what is
 * actually in one — a response body is in **no** span, on any path, and the
 * value a user can see turned up in exactly three places — and two of those
 * were missing from this list:
 *
 * - **the query string**, which is the commonest of all. `?amount=1284.00`
 *   travels in plain sight on a server span's `url.query` and inside a client
 *   span's `url.full`, and reading only `url.path` made the ordinary case of a
 *   value crossing the wire invisible to the layer built to find it.
 * - **the stack trace**, which is the surprising one. On one measured span
 *   `db.query.text` said `where id = ?` while `exception.stacktrace` said
 *   `where id = '8814'`: the driver interpolates when it formats its own error.
 *   The *failure* path is therefore the richest evidence in a trace, which is
 *   backwards from the intuition and is the path somebody asking "why is this
 *   value wrong" is already on.
 *
 * **The order is by what a match is worth**, strongest first, and it is load
 * bearing: `carriedIn` preserves it and the folded `detail` names fields in it,
 * so the first field a hit names is the best reason to believe it. The stack
 * trace is last because it is the weakest — kilobytes of frame paths, line
 * numbers and byte offsets, in which a needle like `8814` can match something
 * that is not the value at all.
 *
 * `db.query.text` is worth naming for the opposite reason: whether it carries a
 * literal or a `?` is the callsite's decision, not the tracer's — real knex and
 * pg emit `= ?` and `= $1`, and the same instrumentation emits `where id = 8814`
 * the moment the application concatenates. So this finds the value in some
 * perfectly ordinary applications and not in others, and `BackendPath` is what
 * answers the question anyway when the search cannot.
 */
function spanTexts(span: OtelSpan): readonly (readonly [string, string | null])[] {
  return [
    ['the query it ran', span.db?.statement ?? null],
    ['the query string it was called with', span.http?.query ?? null],
    ['the path it was asked for', span.http?.path ?? null],
    ['its own name', span.name],
    ['the exception it threw', span.exception?.message ?? null],
    ['its status message', span.statusMessage],
    ['the stack trace of the error it threw', span.exception?.stacktrace ?? null],
  ];
}

/**
 * How much of one span field a `detail` quotes.
 *
 * Sized for the longest thing in `spanTexts` rather than the shortest: a stack
 * trace is measured in kilobytes, and the first line of one is the driver's own
 * message — which is the half that says something — while the rest is frames.
 */
const FIELD_QUOTE = 160;

/** One field of one span that carried the value, ready to be quoted at a reader. */
interface CarriedField {
  what: string;
  text: string;
}

/**
 * The fields of one span that carried the value, in `spanTexts` order.
 *
 * One function and not a predicate beside a loop, because `hopOf`'s `carried`
 * and `inBackend`'s hit are the same decision and two spellings of it drift.
 * The drift is invisible until somebody reads a path whose every hop says
 * `carried: false` directly beneath a hit saying that span carried the value,
 * and then disbelieves both.
 *
 * Whitespace is collapsed on both sides for `inDom`'s reason — a query the
 * tracer wrapped over four lines is the same text as the same query on one, and
 * the page a reader copied the value off does not indent it the way the SQL
 * does. It also keeps the search and the quotation in the `detail` over exactly
 * the same string, so a hit a reader cannot see in the text beside it is not a
 * thing that can happen.
 */
function carriedIn(span: OtelSpan, needle: string): CarriedField[] {
  const flat = collapse(needle);
  // Every field `includes` the empty string. The caller guards it too; this is
  // the guard that stays true when a second caller arrives.
  if (!flat) return [];

  const out: CarriedField[] = [];
  for (const [what, raw] of spanTexts(span)) {
    if (raw === null) continue;
    const text = collapse(raw);
    if (text.includes(flat)) out.push({ what, text });
  }
  return out;
}

function inBackend(
  backend: BackendInput,
  needle: string,
  hits: ProvenanceHit[],
  carried: Set<string>,
): void {
  if (!backend.available) return;
  const flat = collapse(needle);

  for (const join of backend.joined) {
    const key = callKey(join.call.step, join.call.method, join.call.url);
    for (const span of join.spans) {
      const fields = carriedIn(span, needle);
      if (fields.length === 0) continue;
      carried.add(key);

      const phrases = fields.map(
        (field) => `${field.what}: ${around(field.text, flat, FIELD_QUOTE)}`,
      );
      const listed = phrases.reduce(
        (sentence, phrase, index) =>
          index === 0
            ? phrase
            : `${sentence}, ${index === phrases.length - 1 ? 'and ' : ''}in ${phrase}`,
        '',
      );

      hits.push({
        layer: 'backend',
        step: join.call.step,
        where: `${span.service}  ${span.name}`,
        /*
         * Every field that carried it, each with its own text, in `spanTexts`
         * order — which is strongest first, so the reason to believe the hit is
         * the first thing named and a stack-trace-only sighting cannot borrow
         * the authority of a query it was not in. Naming the fields without
         * quoting them would make a reader take the claim on trust; quoting one
         * of several would pick a winner arbitrarily.
         */
        detail: `The server-side work carried it in ${listed}.`,
        /*
         * The *strongest* field decides, not the first. `exact` means the value
         * accounted for the whole of what was found, and a span whose `url.path`
         * is exactly the needle has that property whether or not its name — a
         * longer string containing the same path — happens to sort first. Taking
         * the first field would make the answer depend on the order of a list in
         * this file rather than on the evidence. It also keeps a stack trace out
         * of `exact` by construction: nothing short of searching for the whole
         * trace makes one equal to the needle.
         */
        match: fields.some((field) => field.text === flat) ? 'exact' : 'within',
      });
    }
  }
}

function hopOf(node: SpanNode, needle: string): BackendHop {
  const span = node.span;
  return {
    depth: node.depth,
    service: span.service,
    name: span.name,
    kind: span.kind,
    durationMs: span.durationMs,
    failed: span.failed,
    file: span.code?.file ?? null,
    line: span.code?.line ?? null,
    statement: span.db?.statement ?? null,
    status: span.http?.status ?? null,
    query: span.http?.query ?? null,
    exceptionType: span.exception?.type ?? null,
    exceptionMessage: span.exception?.message ?? null,
    statusMessage: span.statusMessage,
    carried: carriedIn(span, needle).length > 0,
  };
}

/**
 * The chains, for the calls the value was actually seen at.
 *
 * Every joined trace is *not* listed. A recording with the header on carries a
 * trace id on every call it made, and printing the server-side work behind all
 * of them would answer a question nobody asked and bury the one they did —
 * `get_backend_trace` is the tool for the whole recording. What earns a path
 * here is the value turning up at one end of that call or the other.
 */
function backendPaths(
  backend: BackendInput,
  needle: string,
  carried: ReadonlySet<string>,
): BackendReading {
  if (!backend.available) return { paths: [], more: 0, awaiting: 0 };

  /*
   * Selected first, walked second. Flattening every joined trace and then
   * throwing all but four of them away is work proportional to a span store fed
   * by an unauthenticated endpoint — one recording of forty traced calls, each
   * answered by a handler with an N+1 in it, is tens of thousands of nodes
   * built to print forty-eight of them.
   */
  const seen = backend.joined.filter((join) =>
    carried.has(callKey(join.call.step, join.call.method, join.call.url)),
  );

  const paths = seen.slice(0, PATHS_SHOWN).map((join): BackendPath => {
    const nodes = flattenTree(join.roots);
    return {
      step: join.call.step,
      where: `${join.call.method} ${join.call.url}`,
      traceId: join.call.traceId,
      services: [...join.services],
      hops: nodes.slice(0, HOPS_PER_PATH).map((node) => hopOf(node, needle)),
      more: Math.max(0, nodes.length - HOPS_PER_PATH),
    };
  });

  return {
    paths,
    more: Math.max(0, seen.length - PATHS_SHOWN),
    awaiting: backend.awaiting.length,
  };
}

// ── What the recording could not be asked ────────────────────────────────────

/**
 * Layers this recording carries nothing for.
 *
 * Named rather than left to read as "not found there", because those are
 * different answers and only one of them is about the application. A flow sent
 * without its network calls has no response layer at all, and a reader told
 * only that the value was not in a response concludes the server never sent it.
 */
function unsearchedLayers(flow: FlowPayload, backend: BackendInput): UnsearchedLayer[] {
  const steps = list<Step>(flow?.steps);
  const out: UnsearchedLayer[] = [];

  /*
   * The backend's three nothings, kept apart.
   *
   * They are three errands, not three wordings of one. Span ingest being off is
   * a flag on this server; no traced call is a switch in the extension and a
   * recording made again; spans not having arrived is the user's exporter, and
   * is the one that is *already* correct on the DevFlow side. A reader sent to
   * the wrong one of those goes and changes a setting that was not the problem
   * — which is `get_backend_trace`'s argument, and it is the same reader.
   *
   * A partially-joined recording is deliberately not here: it is not an
   * unsearched layer, it is a searched one with a hole, and it is counted in
   * `backend.awaiting` where a renderer can print it beside what it did find.
   */
  if (!backend.available) {
    out.push({
      layer: 'backend',
      reason:
        'Span ingest is off on this server, so no backend spans are held for any recording. Start it with DEVFLOW_OTEL=1 and point the backend’s OTLP exporter at POST /v1/traces.',
    });
  } else if (backend.tracedCalls === 0) {
    out.push({
      layer: 'backend',
      reason:
        'No call in this recording carried a trace id, so there is nothing to join backend spans to. Trace headers are off by default, are added only while recording, and are added cross-origin only for an origin in the allow-list.',
    });
  } else if (backend.joined.length === 0) {
    out.push({
      layer: 'backend',
      reason: `This recording carries ${backend.tracedCalls} traced call${backend.tracedCalls === 1 ? '' : 's'}, and no spans have arrived under ${backend.tracedCalls === 1 ? 'its id' : 'their ids'}. The header went out; the backend has not exported, is not exporting here, or sampled the trace away. Re-send this recording once it has and they will join.`,
    });
  }

  const omitted = new Set(list<string>(flow?.omitted));
  if (omitted.has('network') || !steps.some((step) => list(step.networkCalls).length)) {
    out.push({
      layer: 'response',
      reason: omitted.has('network')
        ? 'This flow was sent without its network calls, so there are no response bodies to search.'
        : 'No step in this recording captured a network call.',
    });
  }

  if (!steps.some((step) => list(step.state).length)) {
    out.push({
      layer: 'store',
      reason:
        flow?.state?.read === false || !flow?.state
          ? 'This recording did not read the app’s state — get_state_patch says whether capture was off or no store was recognised.'
          : 'No store moved during this recording, so there are no writes to search.',
    });
  }

  if (!steps.some((step) => list(step.renders).length)) {
    out.push({
      layer: 'render',
      reason: omitted.has('react')
        ? /*
           * A send option, not a setting, and the two are opposite claims.
           *
           * `buildPayload` drops `renders` along with the React component table
           * whenever React is unchecked in the send dialog — every entry is
           * keyed by a component id the payload would no longer resolve. So a
           * flow that sampled renders perfectly arrives here with none, and
           * saying "this recording did not sample renders" invents a fact about
           * the recording out of a checkbox. Exactly the failure the response
           * layer above avoids by consulting `omitted` first.
           */
          'This flow was sent without its React data, and the render sample goes with it — every entry is keyed by a component id the payload no longer carries. The recording may have sampled renders; this copy of it does not say.'
        : flow?.renders?.read === false || !flow?.renders
          ? 'This recording did not sample renders, so no component’s props, state or contexts were read.'
          : 'No component re-rendered during this recording, so no changed value was captured.',
    });
  }

  /*
   * The DOM layer's own nothing, which was missing.
   *
   * The other three are named when the recording carries nothing for them, and
   * this one was left to read as "looked, found nothing" — which is the exact
   * failure the rest of this function exists to prevent, on the one layer a
   * reader is most likely to trust. It only bites on a recording with no steps
   * or with nothing but navigations, and those are recordings somebody is
   * asking about precisely because they are odd.
   */
  const sawDom = steps.some(
    (step) =>
      step.element ||
      step.domDelta ||
      list(step.domChanges?.changes).length ||
      typeof step.value === 'string',
  );
  if (!sawDom) {
    out.push({
      layer: 'dom',
      reason:
        steps.length === 0
          ? 'This recording has no steps, so there is no page text to search.'
          : 'No step in this recording touched an element or recorded a change on the page.',
    });
  }

  return out;
}

// ── The search ───────────────────────────────────────────────────────────────

/** Layer order is presentation, not causation — see the header. */
const LAYER_ORDER: readonly ProvenanceLayer[] = ['backend', 'response', 'store', 'render', 'dom'];

/**
 * Every place in one recording that carried this value.
 *
 * `value` is compared as text throughout, so a number a server sent and a
 * number a person typed into this tool find each other. Nothing is normalised
 * beyond collapsing runs of whitespace on the DOM side, where the page's own
 * indentation is not part of what it said.
 */
export function traceValue(
  flow: FlowPayload,
  value: string,
  backend: BackendInput,
): ProvenanceResult {
  const needle = value.trim();
  const steps = list<Step>(flow?.steps);

  /*
   * `backend` is required rather than optional, and that is the `Pos1` rule
   * applied to a layer. An optional argument makes forgetting it a five-layer
   * answer silently printed as four — which is the exact failure
   * `unsearchedLayers` exists to prevent, arriving through the one door it
   * cannot watch. Required makes forgetting it a compile error instead.
   */
  const found: ProvenanceHit[] = [];
  const carried = new Set<string>();
  if (needle) {
    inBackend(backend, needle, found, carried);
    inResponses(steps, needle, found, carried);
    inStores(steps, needle, found);
    inRenders(steps, needle, found);
    inDom(steps, needle, found);
  }

  const hits: ProvenanceHit[] = [];
  const more: Partial<Record<ProvenanceLayer, number>> = {};

  for (const layer of LAYER_ORDER) {
    const inLayer = found.filter((hit) => hit.layer === layer);
    hits.push(...inLayer.slice(0, HITS_PER_LAYER));
    if (inLayer.length > HITS_PER_LAYER) more[layer] = inLayer.length - HITS_PER_LAYER;
  }

  return {
    value: needle,
    hits,
    more,
    unsearched: unsearchedLayers(flow, backend),
    collides: needle.length > 0 && needle.length < COLLIDING_LENGTH,
    backend: backendPaths(backend, needle, carried),
  };
}

/**
 * What a step would trace, when the caller names a step rather than a value.
 *
 * The text of the element the step touched, or what the user typed into it —
 * which is the closest a recording comes to the "DOM node" this feature was
 * planned around. A recording has no node ids: an element is described, not
 * addressed, so the value it showed is the handle that exists.
 */
export function valueOfStep(step: Step): string {
  const text = collapse(step?.element?.text ?? '');
  if (text) return text;
  const typed = collapse(step?.value ?? '');
  if (typed) return typed;
  return collapse(step?.element?.label ?? '');
}
