/**
 * What the MCP server needs from `core/`, in one entry point.
 *
 * The server is published to npm as its own package and cannot import TypeScript
 * out of `src/`, so it used to carry a second markdown renderer written by hand
 * — 65 lines that had to agree with the 375 in `core/export/markdown.ts` and
 * did not. The good renderer omitted brittle selectors, printed a URL only when
 * the page changed, and escaped page text so a response body could not forge a
 * step heading; the server's printed the full URL and absolute screenshot path
 * on every step and escaped nothing. The careful one rendered the file a human
 * downloads. The weak one rendered what the model read.
 *
 * So `core/` is bundled into the server package instead (`npm run build:mcp`),
 * which is what `core/` being pure — no Chrome, no DOM, no clock — has always
 * been for. One renderer, one set of rules, one place to fix them.
 *
 * Nothing but re-exports belongs here. Anything this file pulls in is shipped to
 * npm, so it is deliberately narrow.
 */

export { exportToMarkdown, renderComponents, renderStep, flowHost, urlPath } from './export/markdown.js';
export { compactBody } from './schema/index.js';
export { callFailed, statusClass, stepFailed, worstLevel } from './flow/index.js';
export { stepEnclosing, stepOwner, formatSource, sourceProvenance } from './react/attribution.js';
export { snippet } from './source/snippet.js';

/*
 * The causal graph, derived on this side rather than shipped with the flow.
 *
 * It is computed from facts a recording already carries — which step a call was
 * attributed to, what a log line says, what a patch wrote — so storing it would
 * be a second copy to keep in sync with the first. Deriving it here has the
 * property that matters more: every recording already on somebody's disk gets
 * the analysis, and a rule improved in a later release reaches all of them
 * rather than only the ones recorded afterwards.
 *
 * `arkg.js` imports it from the built `core.js` too, which is why it is here and
 * not reached for through `src/`: the server package has no TypeScript.
 */
export {
  buildCausalGraph,
  causesOf,
  effectsOf,
  eventRef,
  parseEventRef,
} from './causal/index.js';

/*
 * Where one value in a recording came from, searched on this side for the
 * causal graph's reason: it is derived from what a flow already carries, so
 * every recording on disk gets it and a rule sharpened later reaches all of
 * them.
 *
 * Its header is the important part of this export. The mechanism is a search
 * for the same value across four independent observations, not a data-flow
 * trace, and the tool that prints it has to keep saying so.
 */
export { traceValue, valueOfStep } from './provenance/index.js';

/*
 * The lexical half of `explain_feature`, on this side for `traceValue`'s reason
 * and for one of its own: what it does is easy to overstate, and a pure module
 * with a header saying so is harder to overstate than a hundred lines of
 * matching inlined into a tool handler.
 *
 * The graph half stays in `mcp-server/arkg.js`, which is where the database is.
 */
export type { EntityKind, NavigatorEntity, NavigatorMatch, NavigatorQuery } from './navigator/index.js';
export { findFeature, readQuery } from './navigator/index.js';

/*
 * What people have actually done on a page, folded across recordings.
 *
 * Here rather than in the server for the reason the navigator is: what this
 * does is easy to overstate — the roadmap calls it a *synthetic* action
 * generator and it synthesises nothing — and a pure module whose header says so
 * is harder to overstate than a fold inlined into a tool handler.
 */
export type { ActionPlan, ActionTarget, CandidateAction, ObservedFlow } from './actions/index.js';
export { planActions } from './actions/index.js';

/*
 * The compiler, so a replay runs the same spec a person downloads.
 *
 * `replay_flow` could have built its own smaller generator and that is exactly
 * the mistake this file was made to stop: the server carried a second markdown
 * renderer once, and the two disagreed about which of them was right. A replay
 * that passes has to be evidence about the spec the user was handed, which
 * means it has to *be* that spec.
 */
export { generatePlaywrightTest } from './export/playwright.js';

/*
 * Reading a runner's output into a verdict, and deciding where a spec goes.
 *
 * Pure because the dangerous half is: a harness that reports a crashed runner
 * as a passing replay tells a repair loop its patch worked. Spawning belongs to
 * `mcp-server/replay.js`, which has a filesystem to ask.
 */
export type { ReplayFailure, ReplayPlan, ReplayRun, ReplayStatus, ReplayVerdict } from './replay/index.js';
export { planReplay, readReport, readRun } from './replay/index.js';

/*
 * What a recording's failures amount to, assembled but never concluded.
 *
 * `get_causal_chain` says what evidence links two events; this says what broke,
 * where it was written, and — the part only the accumulated graph can supply —
 * whether the thing that failed has failed before. It names no cause. See the
 * module header for the line it does not cross.
 */
export type { Diagnosis, DiagnoseInputs, DiagnosisEvidence, HistoryFact, Standing } from './diagnose/index.js';
export { MIN_HISTORY, diagnose } from './diagnose/index.js';

/*
 * The one exception to "core only", and it earns it.
 *
 * `describeStamp` turns a flow's `settings` into the sentences the walkthrough
 * header prints. The wording has to be identical on both sides of the wire —
 * the extension writes `flow.md` through the same renderer the server does, and
 * a reader who sees one description in the file and another in the tool
 * response has to work out which is true. Duplicating it here in JavaScript is
 * exactly the mistake this file was created to undo, and the module it comes
 * from is pure: a field table and two string functions, no Chrome, no DOM.
 */
export { describeStamp, showValue } from '../features/settings/stamp.js';

/*
 * The rest of the exception, and Phase 4's reason for widening it.
 *
 * The server has a precedence rule — **environment variable >
 * `config.json` > per-flow > default** — and that is a chain of sparse override
 * objects resolved against the field table. `resolve()` is already exactly
 * that, and the plan's second standing rule is that it is the *only* validator:
 * a JavaScript reimplementation here would clamp a hand-edited `config.json` by
 * rules that drift from the ones the Settings screen enforces, and neither copy
 * would be wrong on its own.
 *
 * It costs the package nothing new. `describeStamp` already pulls in the field
 * table, and `features/settings/resolve.ts` exists so that the clamp can be
 * imported without `chrome.storage` coming with it.
 *
 * `flowRendering` is the other half: the six values the server decides per flow,
 * named once in typed code rather than as dotted key strings in `server.js`,
 * where a typo resolves to `undefined` and reads as the default.
 */
export { DEFAULTS, fieldFor } from '../features/settings/fields.js';

/*
 * The endpoint's allow-list, and Phase 5's reason for widening this again.
 *
 * `POST /config` writes only the settings the field table marks `machine: true`
 * — the port and the two retention caps. The server could hold that list as
 * three strings of its own, and then a key renamed in `fields.ts` would leave
 * an endpoint quietly accepting a name nothing reads and refusing the one that
 * matters. It is the same argument that put `resolve` here: one description of
 * a setting, on both sides of the wire.
 */
export { MACHINE_KEYS } from '../features/settings/fields.js';
export { resolve } from '../features/settings/resolve.js';
export { flowRendering, renderLimits } from '../features/settings/render.js';

/*
 * What commit a recording was made at, and what that claim is worth.
 *
 * Here rather than in `mcp-server/git.js` because the spawning is the small
 * half. The decisions are which of four repository states a reading is, whether
 * a SHA may be written to a join key, what a stamp means when the recorded page
 * was not served by this machine, and which arguments may reach an argv — none
 * of which should need a repository built on disk to exercise, and one of which
 * is the whole security argument for running `git` at all.
 */
export type {
  Checkout,
  CheckoutState,
  Commit,
  CommitChange,
  FlowCommit,
  NoCommitReason,
} from './git/index.js';
export {
  COMMIT_FORMAT,
  commitCaveats,
  describeCommit,
  flowCommit,
  isSha,
  isShaPrefix,
  joinableSha,
  matchSourceFile,
  normaliseSourcePath,
  parseCommitRecord,
  parseLog,
  parseStatusBranch,
  projectRelative,
  readCheckout,
  recordedLocally,
  shaMatches,
  shortSha,
  unquotePath,
} from './git/index.js';

/*
 * The commit join, which is the whole of what Work Stream 3.4 adds.
 *
 * `compare_flows` already does the comparison; this decides which two
 * recordings are the two builds, crosses what shipped against what DevFlow has
 * seen running, and — the part that most wants to be pure — keeps the four
 * sections of the answer from being read as one kind of claim. Three of them
 * are observations and the fourth is a shortlist, and a renderer that blurs
 * that is a renderer that names a cause.
 */
export type { DeployPair, DeployRecording, PairChoice, Suspect } from './deploy/index.js';
export { choosePair, renderDeployDiff, suspectFiles } from './deploy/index.js';

/*
 * What a trace id is *for*, in one sentence, on the side of the wire that most
 * needs it.
 *
 * The id itself is printed per call, and a sentence per call would be the same
 * forty tokens repeated down the response. But a model reading a failed call
 * and seeing an opaque hex string has been handed the whole Tier 1 payoff and
 * not told what to do with it — the id DevFlow put on the request is the id in
 * the user's own backend logs, and "go and search for it there" is the entire
 * point of having changed anybody's traffic. So the sentence is exported and
 * said once per response, and the wording lives in `core/trace` beside the rule
 * rather than being written a second time here.
 */
export { describeTrace } from './trace/index.js';

/*
 * OpenTelemetry spans, and which of them may say anything about a recording.
 *
 * Here for `core/git`'s reason: the receiving is the small half. The decisions
 * are what a span is allowed to become in a graph that outlives the recording,
 * how a tree is assembled from spans that arrive leaf-first, and what to do
 * with a trace that projects onto one node — none of which should need an HTTP
 * server on a port to exercise, and the last of which is the admission rule the
 * whole graph is built on.
 */
export type {
  JoinResult,
  OperationObservation,
  OperationRef,
  OtelEdge,
  OtelProjection,
  OtelSpan,
  OtlpReading,
  OtlpRejection,
  ServiceObservation,
  SpanKind,
  SpanNode,
  SpanSkip,
  TraceJoin,
  TracedCall,
} from './otel/index.js';
export {
  UNNAMED_SERVICE,
  buildSpanTree,
  compareNano,
  durationMs,
  flattenTree,
  joinTrace,
  operationName,
  projectTrace,
  readOtlpTraces,
  readSpanId,
  readTraceId,
} from './otel/index.js';
