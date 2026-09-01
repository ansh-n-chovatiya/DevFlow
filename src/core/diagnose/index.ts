/**
 * What a recording can say about one failure — and the one thing only the
 * accumulated graph can add.
 *
 * ## This assembles; it does not name a cause
 *
 * `get_causal_chain` already answers *what plausibly led to this*, and it is
 * careful about the answer: four named bases, no scores, and a `detail` that
 * states what was seen rather than what it implies, because a guessed edge
 * presented as a known one is worse than no edge. A diagnosis is a strictly
 * stronger claim than any of those bases carries — *these events are linked by
 * this evidence* is not *this link is the fault* — and nothing in this file
 * makes it. Evidence arrives ordered from the caller and leaves in that order:
 * not re-judged, not re-ranked, not scored, and never reduced to a culprit.
 *
 * What is added is assembly. Per failure in one recording: what broke, the
 * component it happened in and where that was written, the evidence the causal
 * walk found, and the history.
 *
 * The v3.2.0 attempt at this item was a hardcoded fake diff in a file that did
 * not parse — a cause, invented, and presented as read off the recording. The
 * rule that came out of it is the one above.
 *
 * ## `standing` is the part that is genuinely new
 *
 * Everything else here is already in the flow. Whether the thing that failed
 * has failed *before* is not, and no single recording can supply it. "This
 * endpoint has failed on 2 of the last 140 observations, and failed here" and
 * "this endpoint fails 60% of the time" send a reader to two completely
 * different places, and the recording in front of them looks identical either
 * way. So the graph is asked, and its answer is *named* rather than scored, for
 * the reason `core/causal` names its bases: `chronic` is a word a reader who
 * knows the app can disagree with, and `0.6` is not.
 *
 * ## Two kinds of not-knowing, and both of them are answers
 *
 * `unknown` is the default and it is load-bearing. Below `MIN_HISTORY`
 * observations a failure rate is a fraction of a handful, and a graph that has
 * seen an endpoint three times knows nothing about it — saying so is the
 * answer, not a gap in one. That has to stay distinguishable from `new`, which
 * is the far stronger statement *the graph has watched this work and it has now
 * stopped working*. The two collapse into one the moment the detail sentence
 * stops saying which, so every sentence carries the observation count and the
 * floor it is being measured against.
 *
 * The band between the two thresholds is `unknown` as well, and gets no third
 * label. A name invented to fill that gap would be a conclusion the numbers do
 * not support, dressed as a reading of them.
 *
 * ## The refs have to be `core/causal`'s refs
 *
 * `evidenceFor` is a lookup into a graph that file minted, so a ref built to a
 * different spelling — or off a different step number — returns nothing, and
 * "no evidence was found" and "the key was wrong" are the same empty array. So
 * refs are built with that module's own `eventRef`, and the step numbers are
 * derived by its rule; see `stepNumbers` below for why that rule is not simply
 * `stepNumber ?? position`.
 *
 * Pure — no DOM, no Chrome, no clock, no randomness.
 */

import { eventRef } from '../causal/index.js';
import { callFailed, urlPath, worstLevel } from '../flow/index.js';
import type { ConsoleEntry, FlowPayload, NetworkCall, Step } from '../../shared/types.js';

/** One link the causal walk found, as the caller hands it over. */
export interface DiagnosisEvidence {
  /** The event ref — `step:3`, `net:3.1`, `log:3.2`. */
  ref: string;
  /** What that event is, in a few words. */
  label: string;
  /** One of `core/causal`'s four bases. Passed through, never re-judged. */
  basis: string;
  /** The sentence the causal engine wrote for it. */
  detail: string;
}

/** What the accumulated graph knows about something that failed. */
export interface HistoryFact {
  kind: 'component' | 'endpoint';
  /** How the graph keys it. */
  id: string;
  /** What it is called — a display name, or `METHOD url`. */
  label: string;
  /** Observations behind the rate. Below `MIN_HISTORY` the rate says nothing. */
  observations: number;
  /** 0..1. */
  failureRate: number;
}

/** Whether the graph makes this failure new, usual, or unjudgeable. */
export type Standing = 'new' | 'chronic' | 'unknown';

export interface Diagnosis {
  /** The step it was recorded on, as the recording numbers steps. */
  step: number;
  kind: 'console' | 'network';
  /** What broke, in the recording's own words. */
  what: string;
  /** The component the step was attributed to, resolved through the flow's table. */
  component?: { id: string; name: string; source?: string; line?: number };
  /** Nearest first. Empty when the walk found nothing, which is ordinary. */
  evidence: DiagnosisEvidence[];
  history?: HistoryFact;
  standing: Standing;
  /** Why `standing` is what it is, in one sentence a reader can disagree with. */
  standingDetail: string;
}

export interface DiagnoseInputs {
  /** Causal evidence for one event ref, nearest first. */
  evidenceFor: (ref: string) => readonly DiagnosisEvidence[];
  /** What the graph knows, or null when it has never seen this. */
  historyFor: (kind: 'component' | 'endpoint', key: string) => HistoryFact | null;
}

// ── Thresholds ───────────────────────────────────────────────────────────────

/**
 * Observations below which the graph's failure rate is not evidence of
 * anything.
 *
 * A rate over a handful of observations is arithmetic, not knowledge: one
 * failure in three is 33%, which would read as `chronic` and mean nothing at
 * all. Ten is the first count at which a single observation stops moving the
 * rate across both thresholds at once — one failure in ten is 10%, which lands
 * in the band this file refuses to name, and that is the correct answer for a
 * graph that has barely met the thing.
 *
 * Exported because the caller has to be able to say the same number: a reader
 * told "not enough observations" and not told how many would be enough has been
 * given a gap rather than an answer.
 */
export const MIN_HISTORY = 10;

/**
 * At or above this share of observations, failing here is the usual outcome
 * rather than an event. A fifth is deliberately low: an endpoint that fails one
 * request in five is not a working endpoint that had a bad day, and a reader
 * chasing this recording's failure would be chasing the wrong thing.
 */
const CHRONIC_AT = 0.2;

/**
 * At or below this share, the graph has watched the thing work, so failing here
 * is a departure. One in twenty leaves room for the flake, the expired token
 * and the one bad deploy that every long-lived endpoint carries, without them
 * costing it the reading that it normally works.
 */
const NEW_AT = 0.05;

/** How wide `what` may run. One line a reader scans, not a stack trace. */
const WHAT_CAP = 200;

// ── Reading the recording ────────────────────────────────────────────────────

function collapse(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * The number each step is addressed by.
 *
 * Copied deliberately from `core/causal`'s rule, which is private to that file:
 * `stepNumber` is stamped at capture time and goes stale after a deletion, so
 * the stamped numbers are used only while they are all distinct, and position
 * is used for the whole flow when they are not. The rule matters here for a
 * reason of its own — a ref built off a number that module would not have used
 * looks up nothing, and an empty evidence list is indistinguishable from a wrong
 * key. Diverging is silent in exactly the way this module exists to avoid.
 */
function stepNumbers(steps: readonly Step[]): number[] {
  const stamped = steps.map((step, i) => step.stepNumber ?? i + 1);
  return new Set(stamped).size === stamped.length ? stamped : steps.map((_, i) => i + 1);
}

/**
 * One line naming the failed request.
 *
 * The method as the recording wrote it, because this is displayed rather than
 * matched; contrast `endpointKey`. A request that never landed says so instead
 * of carrying a status, since folding it into a number is what makes a call
 * that never happened look like one that answered.
 */
function networkWhat(call: NetworkCall): string {
  const where = urlPath(call.url) || call.url;
  const outcome = call.status === null ? 'failed before a response' : `failed with ${call.status}`;
  return cap(collapse(`${call.method} ${where} ${outcome}`), WHAT_CAP);
}

/**
 * The first line of the logged text.
 *
 * An error's remaining lines are its stack, which is the same forty lines on
 * every occurrence and is already in the step. The first line is the part that
 * differs between two failures.
 */
function consoleWhat(entry: ConsoleEntry): string {
  const joined = (entry.args ?? []).join(' ');
  const [first = ''] = joined.split(/\r?\n/, 1);
  return cap(collapse(first), WHAT_CAP);
}

/**
 * How the graph is asked about an endpoint.
 *
 * Uppercased, because this is a key rather than a display: a recorder that
 * wrote `get` and one that wrote `GET` must ask about the same endpoint, and
 * the normalisation the graph does beyond this — the query string, the id-shaped
 * path segments — belongs to the side that owns the keying.
 */
function endpointKey(call: NetworkCall): string {
  return `${call.method.toUpperCase()} ${call.url}`;
}

/**
 * The component the step was attributed to, or nothing.
 *
 * Never a bare id. `owner` is a hash of compiled source and is unreadable on
 * its own, so an id the flow's table cannot resolve — a flow with no React
 * data, a component whose resolution never completed — is reported as no
 * component rather than as a component nobody can look up. A resolved entry
 * with no name is the same failure wearing a table row, and is dropped too.
 */
function componentFor(
  flow: FlowPayload,
  step: Step,
): { id: string; name: string; source?: string; line?: number } | undefined {
  const id = step.element?.react?.owner;
  if (id === undefined) return undefined;

  const resolved = flow.react?.components?.[id];
  if (!resolved) return undefined;

  const name = resolved.name?.trim();
  if (!name) return undefined;

  return {
    id,
    name,
    ...(resolved.source !== undefined ? { source: resolved.source } : {}),
    ...(resolved.line !== undefined ? { line: resolved.line } : {}),
  };
}

// ── Standing ─────────────────────────────────────────────────────────────────

function observations(count: number): string {
  return `${count} observation${count === 1 ? '' : 's'}`;
}

/**
 * A rate to a tenth of a percent, not to the nearest whole one.
 *
 * 19.9% rounded to 20% and then described as "not high enough to call this
 * usual" is a sentence arguing with its own number, and a reader who spots that
 * stops trusting the rest of it.
 */
function percent(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}

/**
 * Name what the graph's answer is worth, and say why in a sentence.
 *
 * The two `unknown`s are the whole point — see the header. A caller that has
 * never seen the thing and a caller that has seen it four times both get
 * `unknown`, and the sentence carries the count so a reader can tell which of
 * the two they are looking at.
 */
function judge(history: HistoryFact | undefined): { standing: Standing; standingDetail: string } {
  if (history === undefined || history.observations < MIN_HISTORY) {
    const seen = history === undefined ? 0 : history.observations;
    return {
      standing: 'unknown',
      standingDetail:
        `The graph holds ${observations(seen)} of this and ${MIN_HISTORY} are needed before ` +
        `a failure rate is evidence of anything, so whether failing here is unusual is not ` +
        `something this recording or the graph can say.`,
    };
  }

  const rate = percent(history.failureRate);
  const seen = observations(history.observations);

  if (history.failureRate >= CHRONIC_AT) {
    return {
      standing: 'chronic',
      standingDetail:
        `This has failed on ${rate} of ${seen}, so failing here is the usual outcome rather ` +
        `than something this recording provoked.`,
    };
  }

  if (history.failureRate <= NEW_AT) {
    return {
      standing: 'new',
      standingDetail:
        `This has failed on ${rate} of ${seen}, so the graph has watched it work and failing ` +
        `here is a departure from that.`,
    };
  }

  return {
    standing: 'unknown',
    standingDetail:
      `This has failed on ${rate} of ${seen} — neither low enough to call failing here new ` +
      `nor high enough to call it usual, so the graph does not settle it.`,
  };
}

// ── Assembling ───────────────────────────────────────────────────────────────

/** A failure located in the recording, before the caller has been asked about it. */
interface Located {
  step: number;
  kind: 'console' | 'network';
  ref: string;
  what: string;
  component?: { id: string; name: string; source?: string; line?: number };
  /** What to ask the graph, or nothing when there is nothing to ask about. */
  ask?: { kind: 'component' | 'endpoint'; key: string };
}

/**
 * Every failure in the recording, in reading order.
 *
 * What counts as one is `core/flow`'s rule and only that rule: `callFailed` for
 * a request, and the error level as `worstLevel` ranks it for a log line. A
 * second definition of "failed" living here is how the rail's red tick and this
 * module come to disagree about the same step.
 *
 * Network before console within a step, because a request that failed usually
 * precedes the log line about it, and a reader scanning the list wants the
 * cause-shaped thing above the complaint.
 */
function locate(flow: FlowPayload): Located[] {
  const steps = flow.steps ?? [];
  const numbers = stepNumbers(steps);
  const found: Located[] = [];

  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    const n = numbers[i];
    const component = componentFor(flow, step);

    const calls = step.networkCalls ?? [];
    for (let c = 0; c < calls.length; c += 1) {
      const call = calls[c];
      if (!callFailed(call)) continue;
      found.push({
        step: n,
        kind: 'network',
        // Indexed over every call of the step, not over the failing ones: the
        // ref names a position in the recording, and `core/causal` numbers it
        // that way.
        ref: eventRef('network', n, c + 1),
        what: networkWhat(call),
        ...(component !== undefined ? { component } : {}),
        ask: { kind: 'endpoint', key: endpointKey(call) },
      });
    }

    const logs = step.consoleLogs ?? [];
    for (let l = 0; l < logs.length; l += 1) {
      const entry = logs[l];
      if (worstLevel([entry]) !== 'error') continue;
      found.push({
        step: n,
        kind: 'console',
        ref: eventRef('console', n, l + 1),
        what: consoleWhat(entry),
        ...(component !== undefined ? { component } : {}),
        // Only when the component resolved. An unresolvable id is not a thing
        // the graph can have a history of, and asking with it would come back
        // empty in a way that reads as "never failed before".
        ...(component !== undefined
          ? { ask: { kind: 'component' as const, key: component.id } }
          : {}),
      });
    }
  }

  return found;
}

/**
 * One `Diagnosis` per failure, capped at `limit`.
 *
 * The cap is applied before the caller is asked anything, so a flow with two
 * hundred failures does not cost two hundred graph lookups to return ten. There
 * is no `more` field: the caller knows what it asked for and can count it
 * against what the flow holds, and a count derived here would be a second
 * answer to a question the caller can already answer exactly.
 */
export function diagnose(flow: FlowPayload, inputs: DiagnoseInputs, limit: number): Diagnosis[] {
  return locate(flow)
    .slice(0, Math.max(0, limit))
    .map((found) => {
      const history = found.ask ? (inputs.historyFor(found.ask.kind, found.ask.key) ?? undefined) : undefined;
      const { standing, standingDetail } = judge(history);

      return {
        step: found.step,
        kind: found.kind,
        what: found.what,
        ...(found.component !== undefined ? { component: found.component } : {}),
        // Copied, not aliased, and in the order it arrived — see the header.
        evidence: [...inputs.evidenceFor(found.ref)],
        ...(history !== undefined ? { history } : {}),
        standing,
        standingDetail,
      };
    });
}
