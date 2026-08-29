/**
 * What the review screen should show, derived from the flow.
 *
 * This is the hardest screen in the product and the one the whole redesign is
 * for, so every decision it makes is here, pure, and tested — the rail, the
 * filters, which steps count as failures, when a URL is worth showing, what a
 * card leads with. tests/review-view.test.ts is the specification; the controller
 * below it only knows how to put this on screen.
 */

import { flowHost, formatDelta, stepFailed, worstLevel, worstStatus } from '../../core/flow/index.js';
import type { StatusClass } from '../../core/flow/index.js';
import {
  formatSource,
  stepEnclosing,
  stepOwner,
  summarizeComponents,
} from '../../core/react/attribution.js';
import { componentEditorUrl, type EditorLink } from '../../core/react/editor.js';
import type {
  ComponentSource,
  ConsoleLevel,
  FlowReact,
  RecordingState,
  Overrides,
  Step,
  StepType,
} from '../../shared/types.js';
import { formatDateTime, formatRelative } from '../format.js';
import type { IconName } from '../icons.js';

/** Which steps the rail and list are showing. */
export type StepFilter = 'all' | 'click' | 'input' | 'navigate' | 'errors';

export interface ReviewFlow {
  /** `null` is the recording in progress, which has no id until it is saved. */
  id: string | null;
  name: string;
  steps: Step[];
  createdAt: number | null;
  /** The component table, or `null` when the page was not React. For the live
   *  recording this is a snapshot: the resolver is still filling it in. */
  react: FlowReact | null;
  /**
   * The settings this flow was recorded under — the stamp, sparse.
   *
   * `null` for the recording in progress, whose stamp is still in
   * `chrome.storage.local` and is read at send time by whichever path needs it,
   * for the same reason `react` is re-read there: the recording may still be
   * running, and a copy taken when the viewer opened would describe a moment
   * that has passed.
   */
  settings: Overrides | null;
}

export interface ReviewInput {
  /** `null` while the flow is still being read. */
  flow: ReviewFlow | null;
  /** True when the route named a flow that is no longer in storage. */
  missing: boolean;
  filter: StepFilter;
  /** Index into the full step list, not into the filtered one. */
  activeIndex: number | null;
  recording: RecordingState;
  now: number;
  /**
   * How to turn a source path into an editor link. `null` while settings are
   * still being read, and whenever no project root has been set — in both cases
   * the path is still shown, just without a button beside it.
   */
  editor: EditorLink | null;
}

/** The one icon per step type, used by the rail and the card header alike. */
export const STEP_ICON: Record<StepType, IconName> = {
  navigate: 'globe',
  click: 'mouse-pointer-click',
  input: 'keyboard',
  note: 'sticky-note',
};

export interface RailRow {
  /** Index into the full step list. */
  index: number;
  number: number;
  type: StepType;
  icon: IconName;
  label: string;
  /** Time since the previous step. `null` for the first step in the flow. */
  delta: string | null;
  failed: boolean;
  active: boolean;
}

/**
 * A collapsed disclosure's summary: how many, and the most severe one inside —
 * so a 500 is visible without expanding anything.
 */
export interface DetailSummary<W> {
  count: number;
  worst: W;
}

export interface StepCardView {
  index: number;
  number: number;
  type: StepType;
  icon: IconName;
  action: string;
  delta: string | null;
  failed: boolean;
  /**
   * Why the URL is on the card, or `null` to leave it off. A URL repeated on
   * every one of thirty cards is noise; a URL that changed is the story.
   */
  urlReason: 'started' | 'changed' | null;
  url: string;
  title: string | null;
  value: string | null;
  screenshot: string | null;
  /**
   * The screenshot was supplied by the user, not captured. Shown on the card
   * because the rest of it reads as a record of what happened, and this one
   * frame is a record of what the user says happened.
   */
  screenshotImported: boolean;
  /**
   * Why there is no screenshot, when the recorder knows. Nothing may make
   * a recording silently worse.
   *
   * A card that says only "No screenshot for this step" over a flow recorded
   * with screenshots switched off reads as thirty failures. The recorder wrote
   * down which it was; this is where the person who made the recording sees it,
   * and the exports say the same thing to whoever reads the flow afterwards.
   */
  screenshotOmitted: string | null;
  /** `null` for a step with no element — a navigation, or a synthesised note. */
  selectors: { css: string; xpath: string } | null;
  /** The React component this step happened in, or `null`. */
  component: StepComponentView | null;
  network: DetailSummary<StatusClass | null> | null;
  console: DetailSummary<ConsoleLevel | null> | null;
  notes: string;
  active: boolean;
}

/**
 * What the card says about the component a step happened in.
 *
 * The name is always shown; `source` and `detail` are two halves of the same
 * answer and exactly one of them is worth reading. A step whose component is
 * still `pending` says so rather than showing an empty row, because a blank
 * where a path should be reads as "this component has no source file".
 */
export interface StepComponentView {
  name: string;
  /**
   * The feature component this one was rendered inside, or `null`.
   *
   * Set only when the name above is a shared primitive — `Button` is where the
   * click landed and `CheckoutButton` is what makes that mean something.
   */
  within: string | null;
  /** `src/components/Cart.tsx:34`, or `null` when it has nowhere to point. */
  source: string | null;
  /** The one sentence for anything that is not a resolved original file. */
  detail: string | null;
  /** The path is inside `node_modules`, so this is not the user's own code. */
  dependency: boolean;
  /** A link that opens the file, or `null` when nothing can be built. */
  editorUrl: string | null;
}

export interface FilterChip {
  id: StepFilter;
  label: string;
  count: number;
  active: boolean;
  /** A filter that would empty the list is offered but not pressable. */
  disabled: boolean;
}

export interface ReviewHeader {
  name: string;
  /** The live recording has no stored name to rename. */
  renameable: boolean;
  stepCount: number;
  host: string;
  when: string;
  /** `8 components · 6 resolved`, or '' when the page was not React. */
  components: string;
}

/** Which block fills the workspace. Exactly one, always. */
export type ReviewBody = 'loading' | 'missing' | 'empty' | 'no-matches' | 'steps';

export interface ReviewView {
  body: ReviewBody;
  header: ReviewHeader | null;
  /** The flow being reviewed is still being recorded, and will keep changing. */
  live: boolean;
  rail: RailRow[];
  steps: StepCardView[];
  filters: FilterChip[];
  failures: number;
  /** Nothing to export, send or archive when there are no steps. */
  canExport: boolean;
  canSave: boolean;
  canDelete: boolean;
}

const FILTER_LABEL: Record<StepFilter, string> = {
  all: 'All',
  click: 'Clicks',
  input: 'Inputs',
  navigate: 'Navigation',
  errors: 'Errors',
};

/**
 * The first step the filter shows, or `null` when it shows nothing.
 *
 * Exported so the review screen can re-seat its selection when the filter
 * changes: the active index addresses the whole list, and leaving it on a step
 * the filter now hides pointed Delete at something that was not on screen.
 */
export function firstVisibleIndex(steps: Step[], filter: StepFilter): number | null {
  const at = steps.findIndex((step) => passes(step, filter));
  return at === -1 ? null : at;
}

function passes(step: Step, filter: StepFilter): boolean {
  switch (filter) {
    case 'all':
      return true;
    case 'errors':
      return stepFailed(step);
    default:
      return step.type === filter;
  }
}

/**
 * Time since the previous step **in the flow**, never in the filtered list.
 *
 * Filtering to errors and reading `+0.4s` off a step that actually happened
 * ninety seconds after the one above it would be a lie the user has no way to
 * catch, so the delta is computed once, against the real neighbour.
 */
function deltaFor(steps: Step[], index: number): string | null {
  if (index === 0) return null;

  const previous = steps[index - 1];
  if (!previous?.timestamp || !steps[index]?.timestamp) return null;

  return formatDelta(steps[index].timestamp - previous.timestamp) || null;
}

function urlReason(steps: Step[], index: number): 'started' | 'changed' | null {
  const url = steps[index]?.url;
  if (!url) return null;
  if (index === 0) return 'started';
  return url === steps[index - 1]?.url ? null : 'changed';
}

function detail<T, W>(items: T[] | undefined, worst: W): DetailSummary<W> | null {
  if (!items?.length) return null;
  return { count: items.length, worst };
}

function componentView(
  step: Step,
  components: Record<string, ComponentSource>,
  editor: EditorLink | null,
): StepComponentView | null {
  const owner = stepOwner(step, components);
  if (!owner) return null;

  const { component } = owner;

  return {
    name: component.name,
    within: stepEnclosing(step, components)?.component.name ?? null,
    source: formatSource(component),
    // A resolved component's path speaks for itself; everything else owes the
    // reader a reason, and `detail` is where the resolver wrote one.
    detail: component.status === 'resolved' ? null : (component.detail ?? null),
    dependency: component.dependency === true,
    editorUrl: componentEditorUrl(component, editor),
  };
}

function cardView(
  steps: Step[],
  index: number,
  activeIndex: number | null,
  components: Record<string, ComponentSource>,
  editor: EditorLink | null,
): StepCardView {
  const step = steps[index];

  return {
    index,
    number: index + 1,
    type: step.type,
    icon: STEP_ICON[step.type],
    action: step.action || step.type,
    delta: deltaFor(steps, index),
    failed: stepFailed(step),
    urlReason: urlReason(steps, index),
    url: step.url ?? '',
    title: step.title ?? null,
    value: step.value ?? null,
    screenshot: step.screenshot ?? null,
    screenshotImported: step.screenshotImported === true,
    screenshotOmitted: step.screenshotOmitted ?? null,
    selectors: step.element
      ? { css: step.element.cssSelector, xpath: step.element.xpath }
      : null,
    component: componentView(step, components, editor),
    network: detail(step.networkCalls, worstStatus(step.networkCalls)),
    console: detail(step.consoleLogs, worstLevel(step.consoleLogs)),
    notes: step.notes ?? '',
    active: index === activeIndex,
  };
}

function railRow(steps: Step[], index: number, activeIndex: number | null): RailRow {
  const step = steps[index];

  return {
    index,
    number: index + 1,
    type: step.type,
    icon: STEP_ICON[step.type],
    label: step.action || step.type,
    delta: deltaFor(steps, index),
    failed: stepFailed(step),
    active: index === activeIndex,
  };
}

function filterChips(steps: Step[], active: StepFilter): FilterChip[] {
  const ids: StepFilter[] = ['all', 'click', 'input', 'navigate', 'errors'];

  return ids.map((id) => {
    const count = steps.filter((step) => passes(step, id)).length;
    return {
      id,
      label: FILTER_LABEL[id],
      count,
      active: id === active,
      // `all` stays pressable even at zero: it is the way back from a filter
      // that emptied the list.
      disabled: count === 0 && id !== 'all',
    };
  });
}

function headerView(flow: ReviewFlow, now: number): ReviewHeader {
  const at = flow.createdAt ?? flow.steps[0]?.timestamp ?? null;

  return {
    name: flow.name,
    renameable: flow.id !== null,
    stepCount: flow.steps.length,
    host: flowHost(flow.steps),
    when: at === null ? '' : (formatRelative(now - at) ?? formatDateTime(at, now)),
    components: flow.react ? summarizeComponents(flow.react.components) : '',
  };
}

const NOTHING: Omit<ReviewView, 'body'> = {
  header: null,
  live: false,
  rail: [],
  steps: [],
  filters: [],
  failures: 0,
  canExport: false,
  canSave: false,
  canDelete: false,
};

export function deriveReviewView(input: ReviewInput): ReviewView {
  const { flow, missing, filter, activeIndex, recording, now } = input;

  // Missing outranks loading: a flow that was deleted in another tab never
  // finishes arriving, and a skeleton that spins forever is the worse lie.
  if (missing) return { body: 'missing', ...NOTHING };
  if (flow === null) return { body: 'loading', ...NOTHING };

  const { steps } = flow;
  const live = flow.id === null && recording !== 'idle';
  const header = headerView(flow, now);
  const filters = filterChips(steps, filter);
  const failures = steps.filter(stepFailed).length;

  if (steps.length === 0) {
    return {
      ...NOTHING,
      body: 'empty',
      header,
      live,
      filters,
    };
  }

  const shown = steps
    .map((_, index) => index)
    .filter((index) => passes(steps[index], filter));

  const components = flow.react?.components ?? {};

  return {
    body: shown.length === 0 ? 'no-matches' : 'steps',
    header,
    live,
    rail: shown.map((index) => railRow(steps, index, activeIndex)),
    steps: shown.map((index) => cardView(steps, index, activeIndex, components, input.editor)),
    filters,
    failures,
    canExport: true,
    // Only the live recording can be archived; a flow already in the library has
    // nowhere to be saved to — and only once it has stopped. Archiving a
    // recording that is still running froze a partial prefix into the library,
    // with a partial component table behind it (the final resolve pass is
    // refused while recording), and left the user with two flows for one task
    // once they pressed Stop and saved again.
    canSave: flow.id === null && input.recording === 'idle',
    canDelete: flow.id !== null,
  };
}
