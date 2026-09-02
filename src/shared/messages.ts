/**
 * Message contracts between the popup, panel, viewer, content script and worker.
 *
 * Frozen in Wave 0 alongside `shared/constants.ts`, because four packages write
 * against it — C sends these from the agent, B and F handle them in the worker,
 * G and H send them from the two locate surfaces. It is the one file the plan's
 * ownership table did not separate out, and two packages editing a union is
 * exactly the collision the wave structure exists to prevent.
 *
 * Every `chrome.runtime` / `chrome.tabs` message in the extension is one of the
 * unions below, and every response is looked up from a type map — so a handler
 * that returns the wrong shape is a compile error rather than an undefined at
 * runtime. `sendMessage` also reads `lastError`, which unread would log
 * "Unchecked runtime.lastError" on every closed tab.
 */

import type {
  BoundingBox,
  ComponentNeedle,
  DomChange,
  DraftStep,
  FlowReact,
  PickResult,
  RenderChange,
  StateStoreKind,
  StateStoreRef,
  Step,
  StepRender,
  StepStateDelta,
  TreeGroup,
} from './types.js';
import type { Pos1 } from '../core/react/positions.js';
import type { ComponentStamp } from '../core/react/stamp.js';

/**
 * One component the agent found above an interaction.
 *
 * The `needle` is stripped from this before anything is stored on a step — it
 * travels to the worker's resolver and stops there. See `LocalStorageShape.reactNeedles`.
 */
export interface CapturedComponent {
  id: string;
  name: string;
  /** Absent when the source could not be read: an unsettled lazy, or a native fn. */
  needle?: Omit<ComponentNeedle, 'pageUrl'> | null;
  /** Why there is no needle, so the component's status can say so. */
  needleRejection?: 'native' | 'too-short';
  /**
   * `_debugSource`, on React 18 and earlier development builds.
   *
   * Kept apart from the needle because they are different facts: a needle finds
   * where the component was *defined*, while `_debugSource` records where the
   * JSX element was *written* — which is a position in the parent's file. Useful,
   * but not the same answer, and not interchangeable with a bundle-search hit.
   */
  debugSource?: { source: string; line: Pos1; column: Pos1 } | null;
  /**
   * `@devflow/compiler-plugin`'s stamp, read straight off the component
   * function. Absent on every build that does not use the plugin, which is
   * every build by default.
   *
   * Beside `debugSource` rather than replacing it, because they are different
   * facts and the difference decides which wins: `debugSource` is where the
   * JSX element was *written* — a position in the parent's file — and a stamp
   * is where the component was *defined*, which is what `ComponentSource` has
   * always claimed to be. So the stamp goes first in `table.ts`, and
   * `debug-source` is the compromise it beats.
   */
  stamp?: ComponentStamp | null;
}

// ── Page → worker ────────────────────────────────────────────────────────────

/**
 * What the region around a step's element said, once the page had responded.
 *
 * Sent separately from the step, and later, because it is a fact about what the
 * interaction *did* — which is not known at the moment the step is written. The
 * step goes as soon as it happens so the screenshot is not delayed; this arrives
 * a few hundred milliseconds behind it and is merged in by key.
 */
export interface StepDomDelta {
  type: 'STEP_DOM_DELTA';
  /** `timestamp:type`, exactly as `stepKey` builds it. */
  key: string;
  before: string;
  after: string;
}

/**
 * What the document did across one step, structurally.
 *
 * Sent separately from the step and merged in by key, exactly as
 * `StepDomDelta` is — and beside it rather than inside it because the two are
 * separate observations that happen to share a window. The text delta reads one
 * region twice; this watches the whole document over the same window. Either
 * can be switched off without the other, so either can be the only one that
 * arrives.
 *
 * `capped` travels even when `changes` is empty, for `StepRendersMessage`'s
 * reason: a step that saw nothing after its observer stopped is reporting on
 * the stop, and a message withheld because it looked empty is where that fact
 * would be lost.
 */
export interface StepDomChangesMessage {
  type: 'STEP_DOM_CHANGES';
  /** `timestamp:type`, exactly as `stepKey` builds it. */
  key: string;
  /** Folded and ranked already — see `core/dom/changes.ts`. May be empty. */
  changes: DomChange[];
  /** The observer stopped at `recording.domMutationCap` — see `StepDomChanges.capped`. */
  capped?: true;
  /** Distinct changes that did not fit `recording.domMaxChanges`. */
  more?: number;
}

/**
 * What the app's stores did across one step, once the app had settled.
 *
 * Sent separately from the step, later, and merged in by key — the same
 * arrangement as `StepDomDelta` and for the same reason. What an interaction
 * *did* to the state is not knowable at the moment the step is written, and
 * holding the step back until it is would delay the screenshot by the settle
 * delay on every click.
 */
export interface StepStateDeltaMessage {
  type: 'STEP_STATE_DELTA';
  /** `timestamp:type`, exactly as `stepKey` builds it. */
  key: string;
  /** Only stores that actually moved. Never empty — nothing is sent when nothing changed. */
  deltas: StepStateDelta[];
  /** Stores seen for the first time in this recording, to be named on the flow. */
  stores?: StateStoreRef[];
}

/**
 * Which components re-rendered across one step, once the app had settled.
 *
 * Sent separately from the step and merged in by key, exactly as
 * `StepStateDeltaMessage` is and for its reason — the two ride the same pair of
 * samples and arrive together.
 *
 * `capped` and `note` are facts about the *recording* rather than about this
 * step, and travel here because this is the only message that knows them. A
 * recording whose walk hit its fiber cap and reported no re-renders is
 * reporting on the cap, so the flag is sent even when `renders` is empty —
 * which is the one case where an otherwise silent message still has to be sent.
 */
export interface StepRendersMessage {
  type: 'STEP_RENDERS';
  /** `timestamp:type`, exactly as `stepKey` builds it. */
  key: string;
  /** Only components that re-rendered. May be empty when only `capped` is news. */
  renders: StepRender[];
  /** The walk stopped at `recording.renderNodeCap` — see `FlowRenders.capped`. */
  capped?: boolean;
  /** Why there is less here than expected, in the reader's words. */
  note?: string;
}

export interface CaptureAndSaveStep {
  type: 'CAPTURE_AND_SAVE_STEP';
  step: DraftStep;
  elementBox: BoundingBox | null;
  dpr: number;
  /**
   * The components this step's element sits inside, if any.
   *
   * Sent with the step so the worker is the single writer of the component
   * table — the content script never touches storage, and the table cannot race
   * the capture queue's rewrite of `recordedSteps`.
   */
  components?: CapturedComponent[];
  /** The page the components were seen on; its bundles are what gets searched. */
  componentsPageUrl?: string;
  /**
   * Where the page was scrolled when `elementBox` was measured.
   *
   * The box is viewport-relative and the capture happens at least
   * `SETTLE_DELAY_MS` later, so the worker needs both ends to know whether the
   * element is still where it was. See `GetScroll`.
   */
  scroll?: { x: number; y: number };
}

/** Where the page is scrolled right now, asked of the tab about to be captured. */
export interface GetScrollResponse {
  x: number;
  y: number;
}

/**
 * Script URLs the page has loaded, so the resolver knows what to search.
 *
 * Sent as deltas rather than a snapshot: a code-split app fetches chunks all
 * through a recording, and a component captured on step 3 may live in a chunk
 * that only arrives at step 20.
 */
export interface ReactScripts {
  type: 'REACT_SCRIPTS';
  urls: string[];
  /** The page that loaded them. The worker prefers `sender.url` when it has one. */
  pageUrl: string;
}

/**
 * Resolve whatever is still pending, now.
 *
 * The worker resolves on its own while recording, on idle. This is the
 * last-chance sweep for the moments where nothing else will follow: the
 * recording has stopped, or the flow is about to be sent.
 */
export interface ResolveComponents {
  type: 'RESOLVE_COMPONENTS';
  /** After this there is no next trigger, so anything left is reported skipped. */
  final: boolean;
}

/**
 * Forget every React fact this recording has collected.
 *
 * Sent when capture is switched off. Stopping *new* attribution is only half of
 * what that switch promises: a recording that has been running for ten steps
 * already holds component ids on those steps, needles waiting to be searched
 * and a table of resolved paths, and leaving them behind would mean the flow
 * still ships the React data the user has just asked it not to keep.
 *
 * Handled in the worker rather than the content script because `recordedSteps`
 * has exactly one writer, and this has to be one of its writes rather than a
 * read-modify-write racing it. Archived flows are untouched: they are finished
 * records, and deleting from them is what `Settings → Delete all` is for.
 */
export interface ReactPurge {
  type: 'REACT_PURGE';
}

/** React facts about the page, recorded once when the agent first detects it. */
export interface ReactMeta {
  type: 'REACT_META';
  meta: Omit<FlowReact, 'components'>;
}

export interface AnnotateScreenshot {
  type: 'ANNOTATE_SCREENSHOT';
  screenshot: string;
  box: BoundingBox;
  dpr: number;
}

/**
 * Screenshot now and hold it for the click that is about to happen. Sent on
 * pointerdown for interactions that may navigate.
 */
export interface Precapture {
  type: 'PRECAPTURE';
}

export interface GetSteps {
  type: 'GET_STEPS';
}

export interface ClearSteps {
  type: 'CLEAR_STEPS';
}

/**
 * Hands an editor deep link (`vscode://…`) to the browser.
 *
 * The viewer cannot do this itself: navigating an extension page to a custom
 * scheme is blocked, and the launch has to happen in a tab the worker can then
 * dispose of.
 */
export interface OpenEditor {
  type: 'OPEN_EDITOR';
  url: string;
}

/**
 * End the recording, once everything already captured has been written.
 *
 * Stopping is a storage write like every other recording state change, but it
 * cannot be *only* that: a step spends a few hundred milliseconds in the
 * worker's capture queue between the click and the write, and `captureAndSave`
 * drops anything that finds the recording already over. Pressing Stop straight
 * after the thing you wanted to record therefore lost exactly that step — and
 * the MCP auto-export, which fires on the same storage change, shipped the flow
 * without it. The worker owns the order instead: drain, then flip.
 */
export interface FinishRecording {
  type: 'FINISH_RECORDING';
}

/**
 * Fetch a URL with the extension's host permission and hand back the text.
 *
 * From react-source-locator: a DevTools panel cannot read a cross-origin CDN
 * bundle, and the worker can. `WorkerProvider` does not need this — it runs *in*
 * the worker — so this exists for `DevtoolsProvider` alone, which is why it is a
 * message rather than a shared function.
 */
export interface FetchContent {
  type: 'FETCH_CONTENT';
  url: string;
}

/**
 * The DevTools panel announcing which tab it is inspecting.
 *
 * The panel and the worker have no other way to agree on a tab: a panel is not a
 * tab, so `sender.tab` is undefined for everything it sends.
 */
export interface DevtoolsOpened {
  type: 'DEVTOOLS_OPENED';
  tabId: number;
}

/**
 * Arm the picker on a tab, from a surface that is not the page.
 *
 * The panel sends this; the worker relays it to the tab's content script, which
 * pushes a control message to the agent. That relay is what lets the panel keep
 * no scripting relationship with the page at all, now that the `eval` injection
 * path is deleted. `tabId` rather than the sender's own tab because a DevTools
 * page has none — it is about the window it inspects, never the one it is in.
 *
 * The popup used to send it too, from a detached window; that surface is gone.
 */
export interface StartPick {
  type: 'START_PICK';
  tabId: number;
}

export interface CancelPick {
  type: 'CANCEL_PICK';
  tabId: number;
}

/**
 * The compiled source text of one component from the last pick, by tree position.
 *
 * `fn.toString()` has to happen in the page's own world, where the function
 * lives, and the needle built from it is what the bundle search looks for. The
 * locator read this out of a page global it polled; here it is a request with an
 * answer.
 */
export interface ReadComponentSource {
  type: 'READ_COMPONENT_SOURCE';
  tabId: number;
  group: TreeGroup;
  index: number;
}

/**
 * Draw (or clear) the page overlay for one component in the last pick.
 *
 * Sent as the user moves over a row in the tree. `index: null` clears.
 */
export interface HighlightComponent {
  type: 'HIGHLIGHT_COMPONENT';
  tabId: number;
  group: TreeGroup;
  index: number | null;
}

export type WorkerRequest =
  | CaptureAndSaveStep
  | FetchContent
  | DevtoolsOpened
  | StartPick
  | CancelPick
  | ReadComponentSource
  | HighlightComponent
  | StepDomDelta
  | StepDomChangesMessage
  | StepStateDeltaMessage
  | StepRendersMessage
  | FinishRecording
  | Precapture
  | AnnotateScreenshot
  | ReactMeta
  | ReactPurge
  | ReactScripts
  | ResolveComponents
  | GetSteps
  | ClearSteps
  | OpenEditor;

export interface AnnotateScreenshotResponse {
  screenshot: string | null;
}

export interface GetStepsResponse {
  steps: Step[];
}

export interface OkResponse {
  ok: boolean;
}

/** Carries the reason, because a launch that quietly did nothing is a bug report. */
export interface OpenEditorResponse {
  ok: boolean;
  error?: string;
}

export interface FetchContentResponse {
  ok: boolean;
  content: string;
  /** Present when `ok` is false. */
  error?: string;
}

/** Null when the component's function source could not be read in the page. */
export interface ComponentSourceResponse {
  source: string | null;
}

export interface ResponseByType {
  FETCH_CONTENT: FetchContentResponse;
  DEVTOOLS_OPENED: OkResponse;
  /**
   * The pick itself, not an acknowledgement.
   *
   * The freeze had this as `OkResponse`, which said the request landed and
   * nothing about what the user picked — so the answer had nowhere to go and
   * both locate surfaces were blocked. The response is deferred: the content
   * script holds `sendResponse` until the agent reports, which is however long
   * the user takes, bounded by `PICK_TIMEOUT_MS`.
   *
   * A relay failure is a `PickFailure`, not a separate channel. A tab that has
   * navigated to `chrome://` and a user who pressed Escape are the same thing to
   * the caller — no component was picked — and the difference is a sentence,
   * which `PickFailure.error` already carries.
   */
  START_PICK: PickResult;
  CANCEL_PICK: OkResponse;
  READ_COMPONENT_SOURCE: ComponentSourceResponse;
  HIGHLIGHT_COMPONENT: OkResponse;
  /** Resolves once the capture is done, so the page can restore its indicator. */
  CAPTURE_AND_SAVE_STEP: OkResponse;
  STEP_DOM_DELTA: OkResponse;
  STEP_DOM_CHANGES: OkResponse;
  STEP_STATE_DELTA: OkResponse;
  STEP_RENDERS: OkResponse;
  PRECAPTURE: OkResponse;
  ANNOTATE_SCREENSHOT: AnnotateScreenshotResponse;
  REACT_META: OkResponse;
  REACT_PURGE: OkResponse;
  REACT_SCRIPTS: OkResponse;
  RESOLVE_COMPONENTS: OkResponse;
  GET_STEPS: GetStepsResponse;
  CLEAR_STEPS: OkResponse;
  FINISH_RECORDING: OkResponse;
  OPEN_EDITOR: OpenEditorResponse;
}

// ── UI → content script ──────────────────────────────────────────────────────

export type ContentRequest =
  | { type: 'PING' }
  | { type: 'GET_SCROLL' }
  /**
   * Hand over whatever console and network activity has not been attached to a
   * step yet, and forget it.
   *
   * Console and network are attached to the *next* step, because a step is what
   * they are written onto — so anything a page produced after the last
   * interaction had nowhere to land and was dropped when recording stopped.
   * That is precisely the moment a bug report is made of: the user clicks the
   * thing, it breaks, and they stop recording. See `FLUSH_PENDING` in
   * `content/index.ts` and `finishRecording` in the worker.
   */
  | { type: 'FLUSH_PENDING' }
  | { type: 'START_RECORDING' }
  | { type: 'STOP_RECORDING' }
  | { type: 'PAUSE_RECORDING' }
  | { type: 'RESUME_RECORDING' }
  | { type: 'CLEAR_STEPS' }
  /** Arm the picker in this tab's page. Relayed to the agent as a control message. */
  | { type: 'START_PICK' }
  | { type: 'CANCEL_PICK' }
  | { type: 'READ_COMPONENT_SOURCE'; group: TreeGroup; index: number }
  | { type: 'HIGHLIGHT_COMPONENT'; group: TreeGroup; index: number | null };

// ── Injected agent → content script ──────────────────────────────────────────

export interface AgentLogMessage {
  __devflow_source__: string;
  kind: 'log';
  level: string;
  args: string[];
  timestamp: number;
}

export interface AgentNetworkMessage {
  __devflow_source__: string;
  kind: 'network';
  method: string;
  url: string;
  /**
   * The trace id DevFlow put on this request, when it put one on.
   *
   * Absent on every call that was not given a header — which is all of them by
   * default, every cross-origin call to an origin the user has not named, and
   * every call made outside a recording. Absent rather than null, so "was not
   * traced" and "was traced with nothing" cannot be confused.
   */
  traceId?: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  status: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  durationMs: number;
  timestamp: number;
  /**
   * Truncation, carried beside the body rather than inside it.
   *
   * The agent caps bodies and used to append `[truncated — Nb total]` to the
   * string, which made a cut-off JSON body unparseable — so the export called a
   * JSON API "non-JSON", reported the kept length as the real one, and never ran
   * the schema inference that exists precisely for large bodies. The body is now
   * a clean prefix and these say what happened to it.
   */
  requestBodyTruncated?: boolean;
  requestBodyBytes?: number;
  responseBodyTruncated?: boolean;
  responseBodyBytes?: number;
}

/**
 * A component chain, keyed by the `timeStamp` of the event it describes.
 *
 * The key is what makes this safe. The agent and the recorder are two listeners
 * in two JS worlds watching the same event; `postMessage` is asynchronous, so
 * the chain can arrive after the step has been built. Buffering it and attaching
 * it to whatever comes next would silently put a chain on the *wrong step* — a
 * click on a `<select>` is dropped by the recorder entirely, and the `input`
 * handler fires 800 ms late. `event.timeStamp` is identical in both worlds for
 * one dispatch, needs nothing shared, and makes a mismatch impossible.
 */
export interface AgentReactMessage {
  __devflow_source__: string;
  kind: 'react';
  eventTime: number;
  chain: CapturedComponent[];
  truncated: boolean;
}

/**
 * What the app's stores held before an interaction and after it settled, keyed
 * by the `timeStamp` of the event — exactly as `AgentReactMessage` is, and for
 * exactly the same reason.
 *
 * The two snapshots travel rather than the patch between them, because the
 * differ is pure `core/` code and the agent runs in the page: doing the diff
 * here would put a bounded-budget decision inside the one context DevFlow does
 * not control and cannot test without a browser.
 */
export interface AgentStateMessage {
  __devflow_source__: string;
  kind: 'state';
  eventTime: number;
  /** One entry per store read, in the order the stores were discovered. */
  stores: AgentStateStore[];
  /**
   * Why there is less here than the reader expected — no store found on the
   * page, or one held somewhere DevFlow cannot see. Absent when there is
   * nothing to explain.
   */
  note?: string;
}

/** One store, as the page agent read it. */
export interface AgentStateStore {
  id: string;
  kind: StateStoreKind;
  label?: string;
  /** Component ids observed reading this store on this sample. */
  subscribers?: string[];
  /** Bounded snapshots — see `core/state/snapshot.ts`. `null` when the read threw. */
  before: unknown;
  after: unknown;
  /** Either snapshot hit a depth, width or string cap. */
  bounded?: true;
}

/**
 * Which components re-rendered between the same two samples the state message
 * is built from, keyed by the `timeStamp` of the event like every other agent
 * message about one interaction.
 *
 * The *observations* travel rather than the finished `StepRender[]`, for
 * `AgentStateMessage`'s reason: choosing which components survive the budget is
 * a bounded-budget decision, `core/render/blame.ts` is pure and tested, and the
 * MAIN world is the one context DevFlow does not control and cannot test
 * without a browser. The page says what it saw; the isolated side says what it
 * means.
 */
export interface AgentRenderMessage {
  __devflow_source__: string;
  kind: 'renders';
  eventTime: number;
  /** One entry per component whose props object was replaced between samples. */
  observed: AgentRenderObservation[];
  /** The walk stopped at `recording.renderNodeCap` — see `FlowRenders.capped`. */
  capped?: boolean;
  /** No React root was found, or another reason there is less here than expected. */
  note?: string;
}

/**
 * What the page saw of one component that re-rendered.
 *
 * Structurally `RenderObservation` from `core/render`, and deliberately not an
 * import of it: `shared/` is frozen and depends on nothing, and the two shapes
 * meeting structurally is what lets the content script hand this straight to
 * `blame()` without a field-by-field copy — the copy being exactly how a
 * captured field goes missing on the way to disk.
 */
export interface AgentRenderObservation {
  /** Component id, minted by the recorder's own function. */
  component: string;
  props: RenderChange[];
  hooks: RenderChange[];
  contexts: RenderChange[];
  /** A value was cut at a snapshot cap, or withheld — so `wasted` is refused. */
  bounded: boolean;
}

/**
 * Script URLs seen in the page, as a delta.
 *
 * react-source-locator asks DevTools for the page's resources. DevFlow has no
 * DevTools page, so the page reports them itself — a `PerformanceObserver` with
 * `buffered: true`, which replays what loaded before recording started, plus
 * `document.scripts` for the tags the observer's buffer may have dropped.
 */
export interface AgentScriptsMessage {
  __devflow_source__: string;
  kind: 'scripts';
  urls: string[];
}

/** Sent once per document, the first time the agent works out what it is on. */
export interface AgentReactMetaMessage {
  __devflow_source__: string;
  kind: 'react-meta';
  detected: boolean;
  version?: string;
  build?: 'development' | 'production' | 'unknown';
}

/**
 * The outcome of a pick, pushed the moment it happens.
 *
 * Pushed rather than polled, and that difference is one of the two
 * simplifications the merge buys. react-source-locator injected its agent on
 * demand by `eval`-ing the built file into the page, so it had no message
 * channel and read the result out of a page global on a 150 ms timer. DevFlow's
 * agent is a manifest content script that is already there — so the result comes
 * back the way every other fact about the page does.
 */
export interface AgentPickMessage {
  __devflow_source__: string;
  kind: 'pick';
  result: PickResult;
}

/**
 * A question about the last pick, answered from the page.
 *
 * These are the two facts about a picked component that cannot cross
 * `postMessage` and therefore cannot be part of `PickResult`: the component's
 * compiled source, which is a function, and where it sits on screen, which is a
 * set of DOM nodes. react-source-locator read both by `eval`-ing into the page
 * and reaching into the globals its own injection had left there; here the
 * extension asks and the agent answers, over the channel that already exists.
 *
 * Added in the Wave 0 amendment. The freeze declared `READ_COMPONENT_SOURCE` and
 * `HIGHLIGHT_COMPONENT` on `ContentRequest` and then gave the content script no
 * way to reach the agent with either — the round trip stopped one hop short.
 * Package C found it, declared the shapes locally rather than editing a contract
 * six sibling sessions were compiling against, and reported. This is where they
 * belong.
 */
export type PickQuery = { id: number } & (
  | { kind: 'source'; group: TreeGroup; index: number }
  | { kind: 'highlight'; group: TreeGroup; index: number | null }
);

/**
 * A query, in the same envelope as `ControlMessage`.
 *
 * Same marker, because it comes from the same sender over the same channel and a
 * second marker would be a second thing for a page to forge. Discriminated by
 * the presence of `query`: a control message never carries one, and this is
 * answered and returned from before `recording` is read — a query that fell
 * through to the control path would be a message with no `recording` field,
 * which reads as `false` and would stop a live recording's capture.
 */
export interface AgentQueryMessage {
  __devflow_control__: string;
  query: PickQuery;
}

/** What a query is answered with. `id` pairs it with the question. */
export interface AgentQueryReply {
  __devflow_source__: string;
  kind: 'reply';
  id: number;
  /** `source` queries: the component's compiled source, or null. */
  source?: string | null;
  /** `highlight` queries: whether the component was still on the page to draw. */
  ok?: boolean;
}

export type AgentMessage =
  | AgentLogMessage
  | AgentPickMessage
  | AgentNetworkMessage
  | AgentReactMessage
  | AgentReactMetaMessage
  | AgentStateMessage
  | AgentRenderMessage
  | AgentScriptsMessage;

// ── Content script → injected agent ──────────────────────────────────────────

/**
 * Tells the agent whether to watch for interactions at all.
 *
 * The agent is a manifest content script, so it loads on every page whether or
 * not anything is recording. Without this it would walk fibers on every click a
 * user ever makes. A page can forge this message; the worst it achieves is
 * making the agent post chains the content script drops.
 */
export interface ControlMessage {
  __devflow_control__: string;
  recording: boolean;
  /**
   * Whether the picker is armed.
   *
   * Separate from `recording` because they are independent: a user can pick a
   * component with nothing recording, and record for an hour without picking.
   * The picker's listeners are attached only while this is true, so an idle
   * agent costs nothing — which is what lets one agent serve both halves without
   * the recorder paying for the locator's hover tracking on every page.
   */
  picking?: boolean;
  /**
   * The settings the agent needs, pushed rather than read.
   *
   * The MAIN world has no `chrome.*` at all, so this channel is the only path a
   * user's choice can take to reach the code that observes `console` and
   * `fetch`. Optional because a page can forge this message and an older content
   * script would not send it; the agent keeps its compiled-in defaults when it
   * is absent, which is also what it uses between injection at `document_start`
   * and the first message arriving.
   */
  config?: Partial<AgentConfig>;
}

/**
 * The settings the MAIN-world agent reads.
 *
 * A deliberately small subset. Everything here is read *per call* — on each
 * `console` line, each request, each thrown error — never at module scope,
 * because a value read at import time would be the compiled-in default forever
 * and would look exactly like a setting that works. `tests/settings-module-
 * scope.test.ts` is what holds that line.
 *
 * Kept in this file rather than in `features/settings` so the agent bundle can
 * name the type without importing the field table: the table carries every
 * description and every default in the product, and none of it belongs in a
 * script injected into someone else's page.
 */
export interface AgentConfig {
  /**
   * `network.trace*` — the one thing in here that changes what the page sends.
   *
   * Every other member of this object narrows what DevFlow *writes down*. This
   * one decides whether an outbound request carries a header it would not
   * otherwise have carried, which is a different kind of act and is why it
   * arrives as a policy object rather than three loose booleans: the rule that
   * reads it is a single pure function (`decideTrace` in `core/trace`), and a
   * shape that matches that function's input is a shape nobody can half-apply.
   *
   * Structurally identical to `TracePolicy`, and deliberately restated rather
   * than imported: this file is named by the agent bundle, which may not pull
   * in `core/` types it does not otherwise need. `tests/trace-config.test.ts`
   * asserts the two shapes agree.
   */
  trace: {
    /** `network.traceHeader` — the bespoke `X-DevFlow-Trace-Id`. */
    devflow: boolean;
    /** `network.traceparent` — W3C Trace Context. A separate decision; see `core/trace`. */
    traceparent: boolean;
    /** `network.traceOrigins`, parsed. Cross-origin destinations the user named. */
    allowedOrigins: readonly string[];
  };
  /** `network.captureBodies` — off means method, URL and status but no payload. */
  captureBodies: boolean;
  /** `network.bodyCap` — characters kept from a request or response body. */
  bodyCap: number;
  /** `console.levels` — the levels that are emitted. Patching is unconditional. */
  consoleLevels: readonly string[];
  /** `console.logArgCap` — characters kept per console argument. */
  logArgCap: number;
  /** `console.stackFrames` — stack frames kept from a thrown error. */
  stackFrames: number;
  /** `console.captureUncaught` — whether crashes become console entries. */
  captureUncaught: boolean;
  /** `react.maxComponentChain` — components kept above the element, nearest first. */
  maxComponentChain: number;
  /** `react.maxFiberWalk` — fibers stepped through before the walk gives up. */
  maxFiberWalk: number;
  /** `react.prewarmTtlMs` — how long a chain walked on pointerdown stays usable. */
  prewarmTtlMs: number;
  /** `recording.state` — whether the app's stores are sampled around interactions. */
  captureState: boolean;
  /** `recording.stateSettleMs` — how long after an interaction the second sample is taken. */
  stateSettleMs: number;
  /** `recording.stateMaxDepth` — how deep into a store a snapshot goes. */
  stateMaxDepth: number;
  /** `recording.stateMaxKeys` — keys kept from one object in a snapshot. */
  stateMaxKeys: number;
  /** `recording.stateMaxEntries` — entries kept from one array in a snapshot. */
  stateMaxEntries: number;
  /** `recording.stateStringCap` — characters kept from one string in a snapshot. */
  stateStringCap: number;
  /** `recording.stateMaxStores` — stores read per recording. */
  stateMaxStores: number;
  /** `recording.renders` — whether the fiber tree is sampled to see what re-rendered. */
  captureRenders: boolean;
  /**
   * `recording.renderNodeCap` — fibers one render walk visits before it stops.
   *
   * The only cap here whose cost lands on the person recording rather than on
   * the recording: the first of each pair of walks runs inside their click.
   *
   * The other two render settings — `renderMaxComponents` and
   * `renderMaxChanges` — deliberately do not cross, for the reason
   * `statePatchOps` does not: they budget the *evaluation*, which happens on
   * the isolated side out of what the agent sends back, and a field that does
   * not need to cross should not.
   */
  renderNodeCap: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Promise wrapper around `chrome.runtime.sendMessage` that resolves with
 * `undefined` when the receiving end is gone rather than rejecting, so callers
 * can treat "worker asleep" and "worker answered" the same way.
 */
export function sendToWorker<T extends WorkerRequest>(
  req: T,
): Promise<ResponseByType[T['type']] | undefined> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(req, (resp: ResponseByType[T['type']] | undefined) => {
      if (chrome.runtime.lastError) {
        resolve(undefined);
        return;
      }
      resolve(resp);
    });
  });
}
