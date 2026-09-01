/**
 * Actions somebody already performed, offered as actions to perform again.
 *
 * ## This recombines; it does not invent
 *
 * The feature is called a synthetic action generator and the honest description
 * of the mechanism is narrower than the name: **every action this returns was
 * performed by a person and written down by the recorder.** It reads recorded
 * steps, folds the repeats, filters to what the caller asked about and orders
 * what is left. Nothing in it produces an interaction the recording does not
 * contain.
 *
 * That restraint is the design and not a limitation to be worked around later.
 * Proposing an action nobody performed means predicting what *this* application
 * would do with a click on an element DevFlow has never seen — a model of the
 * app that DevFlow does not have and cannot get from a recording. The reverted
 * v3.2.0 attempt is what faking it looks like: it emitted `click("Submit")` on
 * the reasoning that most applications have a submit button, and a caller
 * replaying that got a selector that resolved to nothing on a page nobody had
 * ever recorded.
 *
 * What is left after the restraint is worth having, and it is worth having for
 * a specific job. To reproduce a bug on a page, the interactions somebody has
 * actually performed on that page are a better starting set than anything
 * invented — they exist, they resolved once, and they arrive with the selector
 * `core/export/selectors.ts` already chose for them and the value that was
 * actually typed into the field. A caller gets a replayable list rather than a
 * plausible one.
 *
 * ## There is no knowledge-graph parameter, and that is deliberate
 *
 * The ARKG holds components, endpoints, files, flows and state keys. It holds
 * **no selectors and no element text**, so there is nothing in it an action can
 * be read out of; a graph handed to this function could not change a single
 * field of a single result. Recorded flows can, so recorded flows are what the
 * signature takes.
 *
 * The previous generator did take an ARKG argument, read nothing from it, and
 * returned the same hardcoded buttons whatever was passed. A parameter the code
 * does not read is not a harmless placeholder — it is the function claiming to
 * be graph-aware in the one place a caller looks to find out. So the rule here
 * is structural: if the generator cannot use the graph, it does not take the
 * graph. When something in the graph can genuinely contribute an action, the
 * signature changes and the change is visible.
 *
 * ## Folding, and why the query string is dropped
 *
 * The same button clicked in four recordings is one action worth replaying,
 * seen four times, not four actions. Candidates fold on kind, selector and
 * page, and the fold carries the count and the flows it came from, so a caller
 * can prefer the interaction several people performed over the one somebody did
 * once.
 *
 * "Page" for that purpose is origin plus pathname. `/orders?page=2` and
 * `/orders?page=3` are the same page with a different query, and a click on
 * *Next* recorded on both is one action; keeping the query would split it in
 * two and make each look half as common as it is. The same normalisation is
 * what `ActionTarget.url` is matched on, so a caller asking about a page does
 * not have to guess the query string that was on it when it was recorded. A URL
 * the recorder wrote down that will not parse is still the page it was on, so
 * it is trimmed as a string rather than dropped.
 *
 * ## Nothing is skipped silently
 *
 * *This page has no recorded actions* and *your filter removed all of them* are
 * the same empty list and opposite answers, and a caller that cannot separate
 * them reports the wrong one confidently. So every step that did not become a
 * candidate is counted under a reason a person can read, and the reasons are
 * separate where the conclusions differ: a component filter that removed
 * everything because nothing carried an attribution at all is a recording with
 * no React resolution, not a component that sat idle.
 *
 * Ordering is most-seen first, then label, then selector, with no clock and no
 * locale-sensitive comparison, so two runs over one set of flows agree.
 *
 * Pure — no DOM, no Chrome, no clock, no randomness.
 */

import type { Step } from '../../shared/types.js';
import { resilientSelector } from '../export/selectors.js';

/** One recording, reduced to what an action can be read out of. */
export interface ObservedFlow {
  id: string;
  name: string;
  steps: readonly Step[];
}

/** What the caller is asking about. Both are optional; both may be given. */
export interface ActionTarget {
  /** Only steps performed on this URL. Compared on origin + pathname. */
  url?: string;
  /** Only steps attributed to this component id. */
  component?: string;
}

/** One interaction somebody performed, offered as a thing to perform again. */
export interface CandidateAction {
  kind: 'click' | 'input' | 'navigate';
  /** The selector `resilientSelector` chose, or the URL for a navigate. */
  selector: string;
  /** What a person would call it — the element's label, or its text. */
  label: string;
  /** For an input, a value that was actually typed. Absent for a click. */
  value?: string;
  /** The page it was performed on. */
  url: string;
  /** Recorded steps this candidate stands for. At least one. */
  seen: number;
  /** Ids of the flows it was seen in, first-seen order, deduplicated. */
  flows: string[];
  /** The recorder flagged its selector as fragile — see `core/export/selectors.ts`. */
  fragile?: true;
}

/** Recorded steps that did not become candidates, counted by reason. */
export interface SkippedSteps {
  reason: string;
  count: number;
}

export interface ActionPlan {
  actions: CandidateAction[];
  skipped: SkippedSteps[];
  /** Candidates beyond `limit`. Absent when none. */
  more?: number;
}

/**
 * The reasons a recorded step is not a candidate, in the order they are
 * reported.
 *
 * Sentences rather than codes, because the reader of a plan is the one deciding
 * whether an empty list is the app's doing or the filter's, and `no-element`
 * does not tell them. The two component reasons are separate for the same
 * decision: see the header.
 */
const SKIP_REASONS = [
  'Performed on a different page.',
  'Attributed to a different component.',
  'Carries no component attribution to match against.',
  'A note records what happened; there is nothing to perform.',
  'No element was recorded, so there is nothing to point at.',
] as const;

type SkipReason = (typeof SKIP_REASONS)[number];

const OFF_PAGE: SkipReason = 'Performed on a different page.';
const OTHER_COMPONENT: SkipReason = 'Attributed to a different component.';
const NO_COMPONENT: SkipReason = 'Carries no component attribution to match against.';
const NOTHING_TO_PERFORM: SkipReason = 'A note records what happened; there is nothing to perform.';
const NO_ELEMENT: SkipReason = 'No element was recorded, so there is nothing to point at.';

/**
 * Origin plus pathname, with an unparseable URL trimmed as a string.
 *
 * The fallback is not defensive padding. A recording made on `about:blank` or on
 * a `file://` page has an opaque origin, and the URL's own text is the only name
 * that page has; folding on a parse failure alone would put every such step onto
 * one candidate.
 */
function normaliseUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    if (parsed.origin && parsed.origin !== 'null') return parsed.origin + parsed.pathname;
  } catch {
    // Not a URL the parser accepts, which does not stop it being the page.
  }
  const cut = raw.search(/[?#]/);
  return cut === -1 ? raw : raw.slice(0, cut);
}

/**
 * Ordering that does not depend on where it runs.
 *
 * `localeCompare` sorts two identical plans differently under two ICU builds,
 * and this answer is produced in a browser and in a Node MCP server.
 */
function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Whether the step's React attribution names the component the caller asked for. */
function attributedTo(step: Step, component: string): boolean {
  const react = step.element?.react;
  if (!react) return false;
  return react.owner === component || react.chain.includes(component);
}

/**
 * One interaction read out of one step, or the reason it is not one.
 *
 * A navigate carries no element, so its handle is the page it went to. That is
 * the one candidate whose `selector` is not a selector, which the field's
 * contract says and this is where it happens.
 */
function readStep(step: Step, url: string): CandidateAction | SkipReason {
  if (step.type === 'note') return NOTHING_TO_PERFORM;

  if (step.type === 'navigate') {
    return { kind: 'navigate', selector: url, label: step.title || url, url, seen: 1, flows: [] };
  }

  // Required by `ClickStep` and `InputStep`, and absent anyway on a flow written
  // by an older DevFlow and read back off disk.
  const element = step.element;
  if (!element) return NO_ELEMENT;

  const chosen = resilientSelector(element);
  const label =
    element.label?.trim() || element.text?.trim() || element.ariaLabel?.trim() || element.cssSelector;

  const action: CandidateAction = {
    kind: step.type,
    /*
     * `resilientSelector` returns one choice in two spellings; the Playwright
     * one stands for that choice, so the same element folds onto one candidate
     * instead of one per dialect.
     */
    selector: chosen.playwright,
    label,
    url,
    seen: 1,
    flows: [],
  };
  if (step.type === 'input') action.value = step.value;
  if (chosen.fragile) action.fragile = true;
  return action;
}

export function planActions(
  flows: readonly ObservedFlow[],
  target: ActionTarget,
  limit: number,
): ActionPlan {
  const wantUrl = target.url === undefined ? undefined : normaliseUrl(target.url);
  const wantComponent = target.component;

  const folded = new Map<string, CandidateAction>();
  const skips = new Map<SkipReason, number>();
  const skip = (reason: SkipReason): void => {
    skips.set(reason, (skips.get(reason) ?? 0) + 1);
  };

  for (const flow of flows) {
    for (const step of flow.steps) {
      const url = normaliseUrl(step.url);

      if (wantUrl !== undefined && url !== wantUrl) {
        skip(OFF_PAGE);
        continue;
      }
      if (wantComponent !== undefined && !attributedTo(step, wantComponent)) {
        skip(step.element?.react ? OTHER_COMPONENT : NO_COMPONENT);
        continue;
      }

      const read = readStep(step, url);
      if (typeof read === 'string') {
        skip(read);
        continue;
      }

      const key = `${read.kind} ${read.selector} ${read.url}`;
      const existing = folded.get(key);
      if (!existing) {
        read.flows.push(flow.id);
        folded.set(key, read);
        continue;
      }
      /*
       * The first value typed is kept, not the last: two values typed into one
       * field are one action performed twice, and either of them replays it.
       */
      existing.seen += 1;
      if (!existing.flows.includes(flow.id)) existing.flows.push(flow.id);
    }
  }

  const sorted = [...folded.values()].sort(
    (a, b) => b.seen - a.seen || byCodeUnit(a.label, b.label) || byCodeUnit(a.selector, b.selector),
  );

  const actions = limit > 0 ? sorted.slice(0, limit) : [];
  const more = sorted.length - actions.length;

  const plan: ActionPlan = {
    actions,
    skipped: SKIP_REASONS.filter((reason) => skips.has(reason)).map((reason) => ({
      reason,
      count: skips.get(reason) ?? 0,
    })),
  };
  if (more > 0) plan.more = more;
  return plan;
}
