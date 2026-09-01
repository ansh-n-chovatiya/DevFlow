/** Tunables shared across the worker, content script, injected agent and UI.
 *
 * Some of these are settings and some never can be. A constant marked
 * **Tier 3 — not configurable** carries the reason on the line after, and the
 * reason is always the same shape: making it a setting would not give the user
 * control, it would give them a way to corrupt data that still looks fine.
 * This file is where the answer lives for anyone who arrives asking "why can't I
 * change this".
 */

/**
 * Runaway guard, not a product limit — stopping a recording mid-task makes the
 * user redo everything.
 *
 * Every capture rewrites the whole `recordedSteps` key, so a step costs more the
 * longer the flow — but the array no longer carries the screenshots, which is
 * what made that slope matter. With the images inline a capture at step 200 cost
 * 136 ms and held 128 MB in the worker, and a 500-step recording did not finish
 * measuring; with them in a key each (`features/flows/shots`) the same capture
 * is 0.4 ms against an array of 60 KB, and step 500 is 0.8 ms against 150 KB.
 *
 * So this is once again what it says it is — a runaway guard — rather than the
 * point where recording falls over.
 */
export const MAX_STEPS = 500;

/** Where the popup mentions export weight. Not a countdown to `MAX_STEPS`. */
export const WARN_STEPS = 150;

/**
 * How long to wait after an interaction before screenshotting, so the page has
 * painted its response (a menu opening, a field filling). Only used when there
 * is no pre-capture to fall back on — see PRECAPTURE_TTL_MS.
 */
export const SETTLE_DELAY_MS = 150;

/**
 * Chrome allows roughly two `captureVisibleTab` calls per second and rejects the
 * rest. Captures are spaced by this instead of being fired and lost.
 */
export const CAPTURE_MIN_INTERVAL_MS = 550;

/**
 * How long a pre-capture stays usable.
 *
 * A click on a link or a submit button navigates before the settle delay
 * elapses, so the screenshot used to show the *destination* while the step text
 * described the element that was clicked, with a highlight box positioned for a
 * layout that no longer existed. For those interactions the screenshot is taken
 * on pointerdown instead, and claimed by the click that follows.
 */
export const PRECAPTURE_TTL_MS = 3000;

/**
 * How long to wait for a repaint before giving up and capturing anyway.
 *
 * The recording indicator is removed from the page before every screenshot, and
 * the removal has to be painted or the capture still contains it. In a
 * background tab no frame is ever painted, so the wait needs a ceiling.
 */
export const PAINT_TIMEOUT_MS = 50;

/*
 * No storage quota constant: the manifest asks for `unlimitedStorage`, so the
 * only ceiling is the user's disk. A genuinely full disk still surfaces as
 * `STORAGE_QUOTA` from `chrome/storage.ts`, handled where it happens.
 */

/**
 * How recent a stored failure has to be for the popup to interrupt with it. An
 * hour-old capture error is noise; one from thirty seconds ago is the reason the
 * user just opened the popup.
 */
export const ERROR_TTL_MS = 60_000;

/** JPEG quality for captured screenshots — legible text at a third of PNG size. */
export const SCREENSHOT_QUALITY = 60;

/** Delay before an `input` event is committed as a step, so typing is one step. */
export const INPUT_DEBOUNCE_MS = 800;

/**
 * How long to let a single-page app render its new route before screenshotting.
 *
 * The URL changes first and the framework paints afterwards, so a capture in the
 * same task photographs the route the user has just left.
 */
export const SPA_SETTLE_MS = 250;

/**
 * How long to wait for a reloading tab to come back before recording anyway.
 *
 * Only a backstop: a page that never fires `complete` — a hung request, a
 * download — should not leave the user staring at a Start button that does
 * nothing.
 */
export const RELOAD_TIMEOUT_MS = 10_000;

/**
 * Response and request bodies are truncated to this before leaving the page.
 *
 * It bounds each body and not their number, which is the gap worth knowing
 * about: a step that makes six hundred requests is held down only by the
 * response budget on the far side, and that shrinks the document *after* the
 * fact rather than capturing less in the first place. A per-step network cap
 * would be an ordinary preference — Tier 1, next to the body cap — and no
 * constant for it exists yet.
 */
export const BODY_CAP = 51_200;

/** Bodies longer than this are replaced by an inferred schema in exports. */
export const SCHEMA_THRESHOLD = 1024;

/** Where recorded flows are POSTed when the MCP integration is enabled. */
export const DEFAULT_MCP_URL = 'http://127.0.0.1:7734/flows';

/**
 * The version of the `FlowPayload` wire format.
 *
 * Bump when a field the server reads changes meaning or disappears — adding one
 * is not a bump, since the server ignores what it does not know. The two sides
 * ship separately (the extension as a zip, the server to npm), so this is the
 * only thing that tells a server which shape it has been handed.
 */
/**
 * Tier 3 — not configurable. A wire contract between two things that ship
 * separately. A user-set version is a user-set lie: the server would trust it
 * and read fields by a shape the extension never wrote.
 */
export const FLOW_SCHEMA_VERSION = 1;

/**
 * `localStorage` key holding a copy of the theme preference.
 *
 * `chrome.storage.sync` is the authority, but it is asynchronous and an
 * extension page cannot run an inline script to beat first paint. This mirror is
 * read synchronously so an explicit theme choice does not flash the other one.
 */
export const THEME_MIRROR_KEY = 'devflow.theme';

/** Marks messages the injected agent posts to the content script. */
/** Tier 3 — not configurable. A protocol identifier, not a preference. */
export const AGENT_MESSAGE_SOURCE = 'devflow-agent';

/** DOM id of the on-page recording indicator. */
/** Tier 3 — not configurable. A DOM identifier, not a preference. */
/**
 * The prefix on the id of every element DevFlow puts into a page.
 *
 * `INDICATOR_ID` below carries it, and so do the picker's `devflow-pick-box`
 * and `devflow-pick-label` in `injected/overlay.ts`. It is a constant rather
 * than a convention because something now depends on it: the mutation observer
 * in `content/index.ts` has to be able to tell the page's changes from
 * DevFlow's own, and it is DevFlow's own that would otherwise dominate — the
 * recording indicator is removed and re-added around every screenshot, so every
 * step would open with a div appearing and going in `<body>`.
 */
export const DEVFLOW_ELEMENT_PREFIX = 'devflow-';

export const INDICATOR_ID = 'devflow-indicator';

/**
 * Badge colour while recording.
 *
 * Tier 3 — not configurable, ruled in Phase 3. Phase 0's inventory listed this
 * as an open question because it is the same red as `ANNOTATION_STROKE`, which
 * *is* Tier 1. They have different jobs. The annotation stroke is a mark the
 * user makes on their own screenshot for their own reader; the badge is
 * DevFlow telling the user it is recording right now, on the only surface that
 * is always visible. A colour somebody chose to match their theme is a colour
 * that can be missed, and a recording nobody noticed starting is the most
 * expensive thing this extension can do.
 */
export const BADGE_COLOR = '#FF3B30';

/**
 * The other two badge states, beside the red of a live recording.
 *
 * Here rather than in the worker for the same reason `BADGE_COLOR` is: the
 * badge is the one surface that is always visible, and three states that are
 * only distinguishable by a number are not three states. Paused is the amber of
 * `--warn` and waiting-to-be-saved is `--fg-muted`, both from `tokens.css` —
 * written out because `chrome.action.setBadgeBackgroundColor` takes a value and
 * cannot read a custom property, which is the same reason the red is a literal.
 * If the tokens move, these move with them.
 */
export const BADGE_PAUSED_COLOR = '#8A6212';
export const BADGE_WAITING_COLOR = '#4E5C59';

/**
 * Highlight box baked into screenshots.
 *
 * Tier 1, and in the field table as `annotation.stroke`. Red is invisible on a
 * red error banner, which is the whole reason it is a setting.
 *
 * **There is no second constant for the fill, and that is the point.** Phase 0
 * flagged the fill as a real gap rather than a judgement call — a stroke the
 * user can set beside a wash they cannot gives a green box with a red middle —
 * and Phase 3 ruled that the answer is derivation rather than a second colour
 * control, which would let the two disagree deliberately. Phase 4 wired the
 * setting and did the deriving in the same change: `fillFor()` in
 * `background/annotator.ts` is the stroke at 8% alpha, computed from whatever
 * the stroke is, and `ANNOTATION_FILL` no longer exists to drift from it.
 */
export const ANNOTATION_STROKE = '#FF3B30';

// ── React source attribution ─────────────────────────────────────────────────

/** Marks control messages the content script posts *to* the MAIN-world agent. */
/** Tier 3 — not configurable. A protocol identifier, not a preference. */
export const CONTROL_MESSAGE_SOURCE = 'devflow-control';

/**
 * How many components of the chain above a clicked element are kept, counting
 * outwards from the element.
 *
 * Upstream's picker keeps 50 because it draws a browsable tree. A flow wants to
 * say where a click landed, and the far end of a deep tree is `App` wrapped in
 * nine providers — nothing an AI can use, at the cost of a `toString()` and a
 * hash each.
 */
export const MAX_COMPONENT_CHAIN = 12;

/** Hard cap on raw fibers visited while walking (cycle guard). */
export const MAX_FIBER_WALK = 2000;

/**
 * How long the content script waits for the component chain before writing the
 * step without it.
 *
 * The chain crosses from the MAIN world by `postMessage`, which is a task, so it
 * can land after the click handler has already run. The wait is a ceiling, not a
 * delay: the message has normally arrived before this is even awaited, and the
 * step then still passes through `afterPaint()` and the worker's 150 ms settle.
 * A step is never held hostage to it — no chain simply means no chain.
 */
export const REACT_CHAIN_TIMEOUT_MS = 50;

/** Chains held for a step that has not asked for them yet. */
export const REACT_BUFFER_SIZE = 16;

/**
 * How long an unclaimed chain stays in the buffer.
 *
 * Some interactions are captured by the agent and then deliberately dropped by
 * the recorder — a click on a `<select>` is covered by the `change` step
 * instead. Those chains are never claimed, and this is what stops them
 * accumulating.
 */
export const REACT_BUFFER_TTL_MS = 5000;

/**
 * How long a chain computed on `pointerdown` may be reused by the `click`.
 *
 * Tier 2, ruled in Phase 3 and tabled by Phase 6 as `react.prewarmTtlMs` — it
 * sits between `REACT_BUFFER_TTL_MS` and `REACT_CHAIN_TIMEOUT_MS`, which are
 * both Tier 2, and it is the same kind of number.
 */
export const REACT_PREWARM_TTL_MS = 1000;

/**
 * How many interactions may fail to find React before the agent gives up on a
 * document and detaches.
 *
 * Not one: an SPA can mount React after the first interaction, and a click can
 * land outside the React root on a page that is otherwise entirely React.
 */
export const REACT_PROBE_ATTEMPTS = 3;

/**
 * Defaults for the three React settings.
 *
 * Three contexts read them independently — the content script gates capture,
 * the worker gates resolution, the settings page renders both — and a default
 * that disagreed between them would show a switch that does not match what is
 * actually happening. Both toggles default on: capture costs nothing on a page
 * that is not React, and resolution's fetches are cache-first and never leave
 * the machine.
 */
export const REACT_SETTING_DEFAULTS: {
  reactCapture: boolean;
  reactResolve: boolean;
  projectRoot: string;
  editor: string;
  customEditorTemplate: string;
} = {
  reactCapture: true,
  reactResolve: true,
  projectRoot: '',
  // VS Code, because its scheme is the one most other editors chose to answer
  // to as well. Nothing is opened until a project root is set regardless.
  editor: 'vscode',
  customEditorTemplate: '',
};

/** Length of the high-specificity needle taken from the head of `fn.toString()`. */
/**
 * Tier 3 — not configurable, along with the two below.
 *
 * Resolution correctness. Shorten a needle and false positives dominate;
 * lengthen it and a minifier's line break stops it matching. Either way the
 * failure mode is a confident *wrong* file path in a flow, which is worse than
 * no path at all because nobody re-checks it.
 */
export const NEEDLE_HEAD_LEN = 200;

/** Length of the secondary needle taken from the function body. */
export const NEEDLE_BODY_LEN = 80;

/** Shortest needle worth searching; below this, false positives dominate. */
export const MIN_NEEDLE_LEN = 12;

/** Function sources longer than this are sliced before a needle is built. */
export const MAX_FN_SOURCE_LEN = 65_536;

/**
 * Distinct components recorded per flow.
 *
 * A runaway guard for a page that renders thousands of one-off components, not
 * a product limit — a real flow touches a handful. Hitting it is recorded in the
 * table rather than passed over in silence.
 */
export const MAX_COMPONENTS_PER_FLOW = 128;

/**
 * Distinct occurrences of a needle worth counting.
 *
 * Above one the match is ambiguous and the path may be the wrong one; the exact
 * number past a handful changes nothing anybody would do about it.
 */
/** Tier 3 — not configurable: see `NEEDLE_HEAD_LEN`. Resolution correctness. */
export const MAX_MATCHES_TRACKED = 5;

/** Scripts larger than this are assets or data, not code worth scanning. */
export const MAX_RESOURCE_BYTES = 24 * 1024 * 1024;

/**
 * Source maps larger than this are skipped outright.
 *
 * The streaming decode means a big map costs time rather than memory, but the
 * JSON parse ahead of it does not: the string and its parsed form both sit in
 * the worker's heap at once, and an MV3 worker that overruns is killed with no
 * warning and no error to report.
 */
export const MAX_MAP_BYTES = 64 * 1024 * 1024;

/** Bundles fetched at once while resolving. */
export const RESOLVE_CONCURRENCY = 4;

/**
 * Active resolution work permitted per flow.
 *
 * A ceiling for a pathological site — hundreds of chunks, no maps, nothing ever
 * matching — not a product limit. Whatever is cut off is recorded as `skipped`
 * with a sentence rather than left looking unresolvable.
 */
export const MAX_RESOLVE_MS_PER_FLOW = 30_000;

/**
 * Quiet time after a step before resolution runs.
 *
 * Resolution happens *during* recording, on idle, because the page is still open
 * and its bundles are still warm in the HTTP cache. Waiting for Stop would mean
 * fetching bundles for a tab that may be closed, from a session that may have
 * expired. Long enough that a burst of clicks resolves once, not once each.
 */
export const RESOLVE_DEBOUNCE_MS = 1500;

/**
 * What one screenshot costs an assistant that opens it.
 *
 * Not a setting and not a measurement — a working figure for a 1280-wide JPEG,
 * accurate enough to answer the only question anybody asks of it: *is sending
 * nine screenshots expensive?* It is, and nothing on the send dialog said so.
 *
 * The dialog's other number is the walkthrough, which is text and is priced by
 * rendering it. Images are not in that document at all — they are paths in it,
 * and a path is fifty characters where the picture it names is fifteen hundred
 * tokens. So a nine-shot send read `~470 tokens of context` while handing over
 * something closer to fourteen thousand, and the one part of a flow that
 * dominates its cost was the one part the estimate could not see.
 *
 * Here rather than in the dialog because `mcp.maxImages` says the same number
 * in its consequence line, and two hardcoded 1,500s are two numbers that drift.
 */
export const VISION_TOKENS_PER_IMAGE = 1500;

/** Bundle texts held in the worker's cache at once, and their total size. */
export const BUNDLE_CACHE_ENTRIES = 24;
export const BUNDLE_CACHE_BYTES = 48 * 1024 * 1024;

/**
 * Script URLs remembered per origin.
 *
 * A code-split app can legitimately load a hundred chunks; a page that
 * generates script URLs in a loop is a runaway, and searching more than this
 * would cost more than the answer is worth.
 */
export const MAX_SCRIPTS_PER_ORIGIN = 200;

/**
 * How long a blank launcher tab is given to hand off to an editor.
 *
 * Chrome losing focus is the reliable signal that the handoff happened, so this
 * only covers the case where nothing ever launched — long enough that the
 * protocol prompt is not dismissed out from under the user while they read it.
 */
/*
 * Tier 2, ruled in Phase 3 and tabled by Phase 6 as `ui.launcherTimeoutMs`. It
 * is user-visible — it is how long a blank tab sits there before giving up on
 * an editor — which is what keeps it out of Tier 3, and it degrades nothing
 * about a recording, which is what keeps it out of Tier 1.
 */
export const LAUNCHER_TAB_TIMEOUT_MS = 20_000;

// ── Moved here so a setting has exactly one default ──────────────────────────
//
// Everything below was a module-private `const` in the file that used it. The
// settings table (`features/settings/fields.ts`) imports its defaults rather
// than retyping them, and a default it could not import would be a second copy
// of the number — which is the failure the whole mechanism exists to avoid.
// The rationale comments moved with the values, because they are the answer to
// "what happens if I change this" that the Settings screen has to print.

/**
 * How long to let the page respond before reading the region back.
 *
 * Long enough for a click to have produced its visible result — a spinner, a
 * banner, a disabled button — and short enough that it is still that click's
 * result rather than the next thing the user did. Deliberately longer than
 * `SETTLE_DELAY_MS`, which exists to get a good *photograph*: the screenshot is
 * the moment the page reacted, and this is what it settled into.
 */
export const DOM_DELTA_MS = 700;

/** Visible text worth keeping from one region. Two lines of prose, roughly. */
export const CONTAINER_TEXT_CAP = 240;

// ── What the document did ────────────────────────────────────────────────────
//
// The structural half of the same question `DOM_DELTA_MS` asks about text. The
// text delta reads one region — the one around the element that was touched —
// twice, and says what it said. This watches the *whole document* for the same
// window and says what appeared, went, or was re-attributed anywhere in it: a
// banner that opened in the page header is invisible to a region read around a
// button at the foot of a form.
//
// The reverted v3.2.0 attempt pushed every `MutationRecord` on the document
// into an array with no cap and no throttle, on every page, for the length of
// the recording. Both numbers below exist because of that, and they bound two
// different things: how much *work* one step may cost, and how much of the
// *recording* one step may spend.

/**
 * Mutation records one step's observer may process before it gives up.
 *
 * The work bound, and the observer disconnects itself when it bites — so the
 * cost of a step on a page that animates is this number, not the page's. Four
 * hundred is generous for a click that opens a dialog and mean for a page
 * running a sixty-frames-a-second transition, which is the split it is for.
 *
 * A step whose observer stopped here says so (`StepDomChanges.capped`), because
 * "nothing else changed" and "nobody was still watching" are the two readings
 * of the same empty list.
 */
export const DOM_MUTATION_CAP = 400;

/**
 * Distinct changes one step may report.
 *
 * The recording bound, spent after folding: a hundred rows appended to one list
 * is *one* change with a count of a hundred, not a hundred entries. Twelve is
 * about what a reader takes in before they stop reading, and a step that had
 * more says how many it did not print.
 */
export const DOM_MAX_CHANGES = 12;

/**
 * Characters kept from the one string that describes a change.
 *
 * Tier 3, deliberately: it is the width of a single line in a reply that prints
 * a dozen of them, and there is no app for which a different number is right —
 * a value that needs more than this to be recognisable is not being read off a
 * summary anyway. `recording.containerTextCap` is not reused for it because
 * that is the size of a *region's* text and this is a fragment of one, and
 * because reusing it would make a cap the region reader owns bite on a feature
 * the region reader is independent of.
 */
export const DOM_CHANGE_TEXT_CAP = 80;

// ── Application state ────────────────────────────────────────────────────────
//
// State is read by *sampling*, not by subscribing: the page's stores are read
// once when an interaction is dispatched and once after it settles, and nothing
// is patched, wrapped or defined on the page in between. The caps below are
// therefore two budgets rather than one — how much of a store is worth looking
// at, and how much of the difference between two looks is worth writing down.

/**
 * How long to let the app settle before reading its stores back.
 *
 * The same reasoning as `DOM_DELTA_MS`, and deliberately the same number: a
 * click's effect on the state and its effect on the screen arrive together, and
 * two settle delays that disagree would produce a step whose visible change and
 * whose state change describe different moments.
 */
export const STATE_SETTLE_MS = 700;

/**
 * How deep into a store a snapshot goes.
 *
 * A normalised Redux store is `entities.users.byId.<id>.profile.address` before
 * it is interesting, which is six. Below that is where an app keeps the things
 * it did not mean to put in a store — a whole API response, a DOM node, a
 * Date-keyed cache — and where the cost of a snapshot stops being bounded by
 * anything the app promised.
 */
export const STATE_MAX_DEPTH = 6;

/**
 * Keys kept from one object, and entries kept from one array.
 *
 * Separate numbers because they fail differently. Forty keys is more than any
 * hand-written slice has and fewer than a normalised `byId` map; twenty entries
 * is enough to see a list's shape and its head, which is what a diff of it
 * needs, and a list longer than that changes by its length far more often than
 * by its two-hundredth element.
 */
export const STATE_MAX_KEYS = 40;
export const STATE_MAX_ENTRIES = 20;

/** Characters kept from one string in a snapshot. */
export const STATE_STRING_CAP = 200;

/**
 * Stores read per recording.
 *
 * An app with more contexts than this has them, and DevFlow reads the eight it
 * saw most recently rather than all of them, because the alternative is a
 * recording whose size is set by how many providers the app happens to wrap its
 * tree in.
 */
export const STATE_MAX_STORES = 8;

/**
 * Operations one store's patch may carry for one step.
 *
 * Over budget, the patch is re-cut at a shallower path — never trimmed. See
 * `StepStateDelta.collapsed` for why a patch with operations removed from it is
 * not a patch.
 */
export const STATE_MAX_PATCH_OPS = 40;

/** Whether the app's stores are sampled around each interaction at all. */
export const CAPTURE_STATE = true;

/** Whether the fiber tree is sampled around each interaction to see what re-rendered. */
export const CAPTURE_RENDERS = true;

/**
 * Fibers the render walk visits before it stops, per sample.
 *
 * The walk runs twice per step and the first of the two runs inside the user's
 * gesture, so this number is click latency on a page being recorded — which is
 * why it is a third of `DISCOVERY_NODE_CAP`, whose walk runs only on the
 * settled sample where nobody is waiting.
 *
 * At this cap one sample costs about 0.2ms over synthetic fibers carrying eight
 * props each (`tests/render-walk-budget.test.ts`, jsdom, this machine). That
 * number is not a browser measurement and must not be quoted as one — a real
 * fiber is not a plain object and jsdom is not Chrome. What the test actually
 * holds is the property the cap exists for: the work is a function of the cap
 * and not of the page, so an app with fifty thousand fibers pays what an app
 * with two thousand pays, and a walk that quietly became quadratic goes red
 * there rather than in somebody's recording.
 *
 * When the cap bites, `FlowRenders.capped` says so. A recording that reports no
 * re-renders while capped is reporting on the cap.
 */
export const RENDER_NODE_CAP = 1500;

/**
 * Components one step may report as having re-rendered.
 *
 * A step where three hundred components re-rendered has a different problem
 * from the one this tool answers, and printing all three hundred would cost
 * more tokens than the rest of the step put together. The busiest are kept —
 * the ones with the most observed changes — and `FlowRenders.note` says when
 * the list was cut.
 */
export const RENDER_MAX_COMPONENTS = 25;

/**
 * Changed props, hooks or contexts reported for one component.
 *
 * A component handed forty props that all changed is one fact — its parent
 * re-rendered wholesale — and the fortieth prop adds nothing to it.
 */
export const RENDER_MAX_CHANGES = 8;



/**
 * How much of a response body a *document* is worth, and how many console lines
 * ride along with a step.
 *
 * The renderer's other two caps (`MAX_REQUEST_BODY`, `MAX_CONSOLE_MESSAGE`) stay
 * local to `core/export/markdown.ts`: nothing outside that file has an opinion
 * about them. These two do — they are the density of the walkthrough, which is
 * a real preference — so they live where a setting can name them.
 */
export const MAX_RESPONSE_BODY = 800;
export const MAX_CONSOLE_ENTRIES = 5;

/**
 * Per-argument ceiling on a captured console line.
 *
 * A page that logs its whole store on every action was attaching hundreds of
 * kilobytes to each step, and every capture rewrites the entire step array — so
 * the cost is paid again on every step that follows.
 */
export const LOG_ARG_CAP = 4096;

/** How much of a stack trace is worth keeping. Deeper frames are framework. */
export const STACK_FRAMES = 12;

/** The five levels `console` is patched on, in the order Settings lists them. */
export const CONSOLE_LEVELS = ['log', 'warn', 'error', 'info', 'debug'] as const;

/** Matches `.flow-row__thumb` in viewer.css, at 2× for a HiDPI screen. */
export const THUMBNAIL_WIDTH = 128;
export const THUMBNAIL_HEIGHT = 80;

/** Well under a kilobyte at this size, and it is never looked at closely. */
export const THUMBNAIL_QUALITY = 0.5;

/** How long to wait before calling a silent address unreachable. */
export const SEND_TIMEOUT_MS = 10_000;
export const HEALTH_TIMEOUT_MS = 4000;
export const REMOTE_TIMEOUT_MS = 10_000;

// ── The MCP server's own numbers, mirrored ───────────────────────────────────
//
// `mcp-server/server.js` is a separate npm package in a separate process; it
// cannot import TypeScript, so it keeps its own literals and always will. These
// are the extension's copy — what the Settings screen shows, what it clamps
// against, and what it sends to `POST /config` in a later phase.
//
// A second copy of a number is exactly what the rest of this file exists to
// prevent, so it is the one thing here with a test of its own:
// `tests/settings-defaults.test.ts` parses `server.js` and fails if a value
// drifts from the mirror below. That test is load-bearing — a silent drift here
// would show the user one number while the server used another.

/** Response budget for one MCP tool call, in tokens. `DEVFLOW_MAX_TOKENS`. */
export const MCP_MAX_TOKENS = 20_000;

/** Screenshots returned by a single MCP call. */
export const MCP_MAX_IMAGES = 3;

/** Body characters included per request in MCP tool output. */
export const MCP_BODY_LIMIT = 4096;

/** Whether MCP tool calls include the underlying step data unless asked. */
export const MCP_RAW_DEFAULT = false;

/** Flows kept in `~/.devflow/flows` before the oldest is evicted. */
export const MCP_MAX_FLOWS = 200;

/** Total bytes kept in `~/.devflow/flows` before the oldest is evicted. */
export const MCP_MAX_FLOW_BYTES = 2 * 1024 * 1024 * 1024;

/** The loopback port the server listens on. `DEVFLOW_PORT`. */
export const MCP_PORT = 7734;

// ── Export and send defaults ─────────────────────────────────────────────────
//
// The dialogs remember the last choice per surface (`exportOptions`,
// `sendOptions` in local storage). These are the shipped answer to what to
// offer when there is no memory — and, since Phase 4, the default the
// `export.*` settings start from. The memory and the setting are two different
// things and both are relied on; `features/export/defaults.ts` is the rule for
// deciding between them.

/** What an export includes before anyone has chosen otherwise. */
export const EXPORT_DEFAULT_IMAGES = true;
export const EXPORT_DEFAULT_NETWORK = true;
export const EXPORT_DEFAULT_LOGS = true;
export const EXPORT_DEFAULT_REACT = true;
export const EXPORT_DEFAULT_FORMAT = 'zip';

/**
 * What a send includes before anyone has chosen otherwise.
 *
 * Narrower than an export on purpose, and the asymmetry is the whole reason
 * these are eight constants and not four. An image is the cheapest thing on
 * this wire and the most useful on its own — the server writes it to disk and
 * Claude pays only for the ones it opens. Network bodies and console logs are
 * the expensive half: they are read back with every step, and on a flow against
 * a chatty API they are most of the context. Someone debugging a failed request
 * knows to switch them on; someone showing Claude what they clicked should not
 * pay for them without asking. The component table stays on, with the
 * screenshots rather than with the bodies: it is what makes the flow
 * *actionable* — the assistant opens the file instead of searching for the
 * component by name — and it is ids plus one table, a rounding error next to a
 * single response body.
 */
export const SEND_DEFAULT_IMAGES = true;
export const SEND_DEFAULT_NETWORK = false;
export const SEND_DEFAULT_LOGS = false;
export const SEND_DEFAULT_REACT = true;

// ── Capture switches that have never had one ─────────────────────────────────
//
// These are `true` in the code today because there is no way to say otherwise —
// the behaviour is unconditional. The tiering makes each of
// them a setting, and the default has to be the behaviour that ships now or the
// migration is a behaviour change wearing a settings screen.

/** Whether a step carries a screenshot at all. */
export const CAPTURE_SCREENSHOTS = true;

/** Whether request and response bodies are recorded. */
export const CAPTURE_BODIES = true;

/** Whether bodies over `SCHEMA_THRESHOLD` are replaced by an inferred schema. */
export const SUMMARISE_BODIES = true;

/** Whether uncaught errors and unhandled rejections become console entries. */
export const CAPTURE_UNCAUGHT = true;

/** Whether the region around an interaction is read back after `DOM_DELTA_MS`. */
export const CAPTURE_DOM_DELTA = true;

/**
 * Whether the document is watched for structural change around an interaction.
 *
 * Separate from `CAPTURE_DOM_DELTA` because they are separate facts and either
 * is worth having without the other — see the block above `DOM_MUTATION_CAP`.
 */
export const CAPTURE_DOM_MUTATIONS = true;

/** Whether pressing Stop collects the state the last interaction left behind. */
export const CAPTURE_TRAILING_STEP = true;

// ── Picking ──────────────────────────────────────────────────────────────────
//
// From react-source-locator. Two of its four constants did not survive the
// merge, and what happened to them is the merge in miniature:
//
//   - `FETCH_CONCURRENCY = 6` is gone. It was the same quantity DevFlow had
//     already made a Tier 2 setting at `react.resolveConcurrency`, and after the
//     merge both `BundleProvider` implementations read the setting. Two numbers
//     became one.
//   - `POLL_INTERVAL_MS = 150` is gone. The panel polled a page global for a
//     pick result because it had `eval`-injected its own agent and had no
//     channel back. DevFlow ships one agent at `document_start` with a real
//     message path, so the result is pushed and there is nothing to poll.
//   - `AGENT_VERSION` is gone with the injection dance it existed for: a
//     manifest-declared agent cannot be stale relative to the extension that
//     declares it.

/**
 * How many ancestor components the picker walks up from the clicked node.
 *
 * Deliberately not `MAX_COMPONENT_CHAIN` (12). A pick draws a browsable tree and
 * the user is looking at it, so the far end is worth keeping; a recorded step
 * says where a click landed, and nine providers above `App` are nothing an AI
 * can use at the cost of a `toString()` and a hash each.
 */
export const MAX_ANCESTORS = 50;

/**
 * How long a pick stays armed before it is abandoned.
 *
 * A ceiling on a gesture the user may simply have walked away from — without it
 * an armed picker outlives navigations and panel closes, and the page keeps its
 * listeners forever.
 */
export const PICK_TIMEOUT_MS = 120_000;

/**
 * Whether one interactive locate reads the page's source maps.
 *
 * Deliberately a second answer to a question `reactResolve` already answers for
 * the recorder, because the two costs are paid by different people at different
 * moments. `reactResolve` gates a background pass over a whole flow; this gates
 * the one lookup somebody is sitting and waiting for. Folded into one setting,
 * the only way to stop a slow pick would be to turn off the background pass a
 * recording depends on, and the only way to get an answer now would be to pay
 * for that pass first.
 */
export const USE_SOURCE_MAPS = true;

/**
 * Whether a recognised framework category is hidden from the component trees.
 *
 * One constant for all five categories because it is one decision, not five:
 * an app's ancestor chain is mostly routers and providers, and hiding them is
 * what makes the tree readable at all. The categories are separate *settings*
 * so that somebody chasing which route rendered a page can bring routers back
 * without also bringing back every styled-component wrapper.
 */
export const HIDE_COMPONENT_CATEGORY = true;

/**
 * Globals the injected agent owns on the inspected page.
 *
 * One namespace, because there is one agent. The nine globals the locator kept
 * under its own prefix do not survive — see the banned list in
 * docs/CONTRACTS.md §4.5, which the literal is deliberately not written out
 * here to satisfy — and neither does the shape they named: these two are the
 * agent's own working state for a live pick, not a channel the extension reads
 * across worlds. The channel is `postMessage`.
 */
export const PAGE_GLOBALS = {
  /** The agent's own API object, so a second injection can detect the first. */
  agent: '__DEVFLOW_AGENT__',
  /** The fibers and nodes behind the components in the last pick result. */
  picked: '__DEVFLOW_PICKED__',
} as const;
