/**
 * Every setting DevFlow has, as data.
 *
 * One entry per Tier 1 and Tier 2 setting. The table is the single description
 * of a setting: it drives the `Settings`
 * type, the `DEFAULTS` object, the clamp in `resolve()`, the input attributes
 * the Settings screen renders, the "reset to default" affordance, and the file
 * `public/settings.default.json`. A setting that exists in one of those and not
 * the others is the failure this shape exists to make impossible — `Settings` is
 * *derived* from `FIELDS`, so a key cannot appear in the type without appearing
 * here.
 *
 * Two rules the table has to keep:
 *
 *   - **Defaults are imported, never retyped.** Every `default` below is a
 *     constant from `shared/constants.ts`. A literal here would be a second copy
 *     of a number that already exists, and the day someone changes one of them
 *     the other would keep shipping. `tests/settings-defaults.test.ts` asserts
 *     the whole table against those constants.
 *   - **`description` is the writing that ships.** These sentences ship as
 *     written, and `consequence` is the rule that a dangerous setting states
 *     its cost next to the input rather than in a tooltip. Neither is
 *     placeholder text to be improved during the UI phase.
 *
 * Pure — no `chrome.*`, no DOM. `index.ts` is where storage happens.
 */

import {
  ANNOTATION_STROKE,
  BODY_CAP,
  BUNDLE_CACHE_BYTES,
  BUNDLE_CACHE_ENTRIES,
  CAPTURE_BODIES,
  CAPTURE_DOM_DELTA,
  CAPTURE_DOM_MUTATIONS,
  CAPTURE_MIN_INTERVAL_MS,
  CAPTURE_SCREENSHOTS,
  CAPTURE_RENDERS,
  RENDER_NODE_CAP,
  CAPTURE_A11Y,
  A11Y_NODE_CAP,
  RENDER_MAX_COMPONENTS,
  RENDER_MAX_CHANGES,
  CAPTURE_STATE,
  CAPTURE_TRAILING_STEP,
  CAPTURE_UNCAUGHT,
  CONSOLE_LEVELS,
  CONTAINER_TEXT_CAP,
  DEFAULT_MCP_URL,
  DOM_DELTA_MS,
  DOM_MAX_CHANGES,
  DOM_MUTATION_CAP,
  ERROR_TTL_MS,
  EXPORT_DEFAULT_FORMAT,
  EXPORT_DEFAULT_IMAGES,
  EXPORT_DEFAULT_LOGS,
  EXPORT_DEFAULT_NETWORK,
  EXPORT_DEFAULT_REACT,
  HEALTH_TIMEOUT_MS,
  HIDE_COMPONENT_CATEGORY,
  INPUT_DEBOUNCE_MS,
  LAUNCHER_TAB_TIMEOUT_MS,
  LOG_ARG_CAP,
  MAX_COMPONENT_CHAIN,
  MAX_COMPONENTS_PER_FLOW,
  MAX_CONSOLE_ENTRIES,
  MAX_FIBER_WALK,
  MAX_MAP_BYTES,
  MAX_RESOLVE_MS_PER_FLOW,
  MAX_RESOURCE_BYTES,
  MAX_RESPONSE_BODY,
  MAX_SCRIPTS_PER_ORIGIN,
  MAX_STEPS,
  MCP_BODY_LIMIT,
  MCP_MAX_FLOW_BYTES,
  MCP_MAX_FLOWS,
  MCP_MAX_IMAGES,
  VISION_TOKENS_PER_IMAGE,
  MCP_MAX_TOKENS,
  MCP_PORT,
  MCP_RAW_DEFAULT,
  PAINT_TIMEOUT_MS,
  PRECAPTURE_TTL_MS,
  REACT_BUFFER_SIZE,
  REACT_BUFFER_TTL_MS,
  REACT_CHAIN_TIMEOUT_MS,
  REACT_PREWARM_TTL_MS,
  REACT_SETTING_DEFAULTS,
  RELOAD_TIMEOUT_MS,
  REMOTE_TIMEOUT_MS,
  STATE_MAX_DEPTH,
  STATE_MAX_ENTRIES,
  STATE_MAX_KEYS,
  STATE_MAX_PATCH_OPS,
  STATE_MAX_STORES,
  STATE_SETTLE_MS,
  STATE_STRING_CAP,
  RESOLVE_CONCURRENCY,
  RESOLVE_DEBOUNCE_MS,
  SCHEMA_THRESHOLD,
  SCREENSHOT_QUALITY,
  SEND_DEFAULT_IMAGES,
  SEND_DEFAULT_LOGS,
  SEND_DEFAULT_NETWORK,
  SEND_DEFAULT_REACT,
  SEND_TIMEOUT_MS,
  SETTLE_DELAY_MS,
  SPA_SETTLE_MS,
  STACK_FRAMES,
  SUMMARISE_BODIES,
  THUMBNAIL_HEIGHT,
  THUMBNAIL_QUALITY,
  THUMBNAIL_WIDTH,
  TRACE_HEADER_ENABLED,
  TRACE_ORIGINS,
  TRACEPARENT_ENABLED,
  USE_SOURCE_MAPS,
  VUE_MAX_VNODE_WALK,
  WARN_STEPS,
} from "../../shared/constants.js";
import { EDITORS } from "../../core/locate/editor.js";
import type { Overrides } from "../../shared/types.js";

// ── Vocabulary ───────────────────────────────────────────────────────────────

/**
 * Which of the four processes reads a setting.
 *
 * Recorded per field because the whole difficulty is that no two of them can
 * read the same thing: the worker and the content script have
 * `chrome.storage`, the MAIN-world agent has no `chrome.*` at all, and the MCP
 * server is a different process on the other side of an HTTP boundary. A field
 * that says `agent` is a field the content script has to *push*, and a field
 * that says `mcp` is one that has to travel in the flow or in `POST /config`.
 * Nothing enforces this yet; it is what the later phases route by.
 */
export type Consumer = "worker" | "content" | "agent" | "mcp" | "ui";

/*
 * `ui` is a fifth, and the delivery table has four. The addition is deliberate.
 *
 * The table is about the four processes that cannot read each other's
 * storage, and it is right about all four. But an extension *page* — the popup,
 * the viewer, the Settings screen — is a real reading surface too, and several
 * settings are read there and nowhere else: the popup's "this flow is getting
 * long" threshold, the JPEG quality the image editor re-encodes at, the body
 * rules an export is rendered under.
 *
 * Phase 2 found four fields labelled `content` that the content script does not
 * read, because `ui` was the honest answer and there was no word for it. A
 * wrong label is worse than a missing one: this list is what a later phase
 * routes delivery by, and `content` means "push it to the agent as well".
 */

/** The category rail in the Settings screen, and the prefix on every key. */
export type Group =
  | "appearance"
  | "recording"
  | "screenshots"
  | "network"
  | "console"
  | "annotation"
  | "export"
  | "react"
  | "vue"
  | "mcp"
  | "thumbnails"
  | "ui";

/**
 * Tier 1 is a plain preference; Tier 2 lives behind the Advanced disclosure
 * because a bad value degrades recordings in ways that look like bugs. Tier 3
 * is not here at all — it stays in `shared/constants.ts` with the reason it can
 * never be a setting written next to it.
 */
export type Tier = 1 | 2;

/**
 * When a `consequence` is true of the value on screen.
 *
 * The consequence "appears when the entered value enters the range it
 * describes, not always". A warning that is on for everybody at all times is
 * wallpaper, and the row it sits in is the row the user stops reading.
 *
 * Omitted, a consequence shows only while the setting is **modified** — the
 * shipped default is by definition not the dangerous answer, so "you have moved
 * this, and here is what that costs" is the honest reading of a bare
 * `consequence`.
 */
export interface ConsequenceWhen {
  /** Numeric: true below this value. */
  readonly below?: number;
  /** Numeric: true above this value. */
  readonly above?: number;
  /** Boolean or enum: true when the value is exactly this. */
  readonly is?: boolean | string;
}

interface Common {
  readonly key: string;
  readonly group: Group;
  readonly tier: Tier;
  readonly title: string;
  readonly description: string;
  /** The rule: a setting that can degrade a recording says so by the input. */
  readonly consequence?: string;
  /** When that consequence is true. See `ConsequenceWhen`. */
  readonly consequenceWhen?: ConsequenceWhen;
  readonly consumers: readonly Consumer[];
  /**
   * Whether the extension reads this setting today, and therefore whether the
   * Settings screen shows it.
   *
   * Phase 0 tabled all seventy-one fields it then knew about at once, so the
   * type, the clamp and the generated default file could be built from one
   * place; it deliberately wired *no* consumer to any of them beyond the eight
   * settings that already existed. Sixty-three of the entries below were read
   * by nobody, and a control that silently does nothing is worse than an absent
   * one — it is the shipped page's own stated reason for not drawing the
   * redaction toggles.
   *
   * So this flag, and not a list of keys in the UI: a phase that wires a
   * consumer flips `wired` in the same table it already has to touch, and the
   * setting appears. There is nothing else to remember, and no second place for
   * the two lists to disagree.
   *
   * **Every row is wired as of Phase 6**, so the flag is
   * currently true everywhere and `WIRED` is the whole table. It stays because
   * it is what the *next* setting needs: the one added between the day it is
   * tabled and the day something reads it, which is a gap every phase here had.
   */
  readonly wired?: true;
  /**
   * The setting is frozen for the duration of a recording, and the flow stamps
   * the value it was recorded under.
   *
   * `START_RECORDING` snapshots, and changes apply to the next recording. A
   * flow whose first ten steps followed one body cap and whose last ten
   * followed another, with nothing recording that, is not a flow anybody can
   * reason about. `features/settings/recording.ts` is the snapshot; the flag is
   * what says which keys are in it.
   *
   * It is also what makes the stamp honest. A flow recording the settings it was
   * made under is the single most important part of this —
   * without it a flow recorded at quality 20 with bodies off is
   * indistinguishable from one where capture failed, and the reader concludes
   * the latter.
   */
  readonly recorded?: true;
  /**
   * The setting shapes a flow when it is *handed over*, not when it is
   * recorded, and the payload stamps the value it was rendered under.
   *
   * The distinction is not pedantry. Body summarisation happens at export, so
   * freezing it at record time would mean somebody who turns summarising off to
   * read the raw bytes of a flow they recorded yesterday gets the summary
   * anyway, forever — a setting that looks broken. Read live, stamped at build
   * time, and the stamp still describes the document in the reader's hands.
   */
  readonly rendered?: true;
  /**
   * The setting is a property of this *installation*, not of a recording, and
   * reaches the MCP server through `POST /config` rather than inside a flow.
   *
   * The server's settings split in two, and the split is not a matter of
   * taste. The response budget or the image limit is a statement about one
   * document a reader is about to be handed, so it travels in the flow that
   * document is rendered from. The port this machine's server listens on, and
   * how much history it keeps on this machine's disk, are true of the machine
   * whichever recording is being read — a flow arriving from another browser
   * profile, or from last month, cannot sensibly carry an answer to them.
   *
   * There is no other channel for these. Before this flag they were read from
   * `process.env` and nothing else, which the plan calls "effectively
   * unreachable": setting one meant editing the launcher of a process the user
   * never starts by hand.
   *
   * It is also the endpoint's allow-list. `POST /config` writes only the keys
   * flagged here, and the whole of what makes an unauthenticated loopback
   * endpoint acceptable is that the worst it can do is what these three fields
   * describe. See `mcp-server/server.js`.
   */
  readonly machine?: true;
}

interface NumberField extends Common {
  readonly type: "number";
  readonly default: number;
  readonly min: number;
  readonly max: number;
  /** Non-integers are rounded by `resolve`; only thumbnail quality opts out. */
  readonly fractional?: true;
  /** Rendered beside the input, and the unit the min/max are in. */
  readonly unit?:
    | "ms"
    | "bytes"
    | "steps"
    | "tokens"
    | "px"
    | "%"
    | "flows"
    | "chars"
    | "keys"
    | "entries"
    | "stores"
    | "ops"
    | "fibers"
    | "elements"
    | "components"
    | "changes"
    | "records";
}

interface BooleanField extends Common {
  readonly type: "boolean";
  readonly default: boolean;
}

interface StringField extends Common {
  readonly type: "string";
  readonly default: string;
  /** A value that fails this resolves to the default — see `resolve`. */
  readonly pattern?: RegExp;
  readonly maxLength?: number;
}

interface EnumField extends Common {
  readonly type: "enum";
  readonly default: string;
  readonly options: readonly string[];
}

/** A multi-select over `options`; an empty selection is a legal answer. */
interface LevelsField extends Common {
  readonly type: "levels";
  readonly default: readonly string[];
  readonly options: readonly string[];
}

export type Field =
  | NumberField
  | BooleanField
  | StringField
  | EnumField
  | LevelsField;

// ── The table ────────────────────────────────────────────────────────────────

/**
 * `min`/`max` are the range `resolve` clamps to, not a suggestion. They are set
 * where a value stops being a preference and starts being a broken recording:
 * wide enough that nobody with a real reason hits them, narrow enough that a
 * corrupted or hand-edited value cannot make the extension unusable.
 *
 * ## The eight keys with no dot
 *
 * `theme`, `mcpServerUrl`, `mcpAutoSend`, `reactCapture`, `reactResolve`,
 * `projectRoot`, `editor`, `customEditorTemplate` are the settings that already
 * existed, and their names are the `chrome.storage.sync` keys users' machines
 * are already synced under.
 *
 * **They keep them. Decided in Phase 3, and not to be reopened without a new
 * argument** — Phase 0 left the question open and asked Phase 1 to settle it,
 * Phase 1 did not reach it, and Phase 3 is where it became visible, because the
 * export file shows the mixed namespace to the user.
 *
 * The cost of keeping them is cosmetic: eight keys sort oddly in
 * an exported file. The cost of renaming them is not. Phase 0's own migration
 * recipe was "read the legacy key when the canonical one is absent, write only
 * the canonical key, and never delete the legacy one, because an older version
 * installed alongside still reads it" — and *never delete* means the area holds
 * both keys after the first save, with an older build writing one and this build
 * writing the other and nothing deciding which wins. That is precisely the
 * two-writers-no-defined-winner failure this deliberately does not build for a
 * settings file on disk. Deleting the legacy key instead strands the user whose other machine
 * has not updated yet, which is precisely the failure avoided by declining to
 * reject a file on its `$schema`.
 *
 * Both branches are failures this plan has already named and rejected elsewhere,
 * and the thing being bought is that `editor` would sort next to `react.*`.
 *
 * Nothing about the mixed namespace misbehaves: `isSettingKey` recognises all
 * eight, so they resolve, export, import and diff like any other key and the
 * JSON pane never flags one as unknown. `tests/settings-file.test.ts` holds that.
 */
export const FIELDS = [
  // ── Appearance ─────────────────────────────────────────────────────────────
  {
    key: "theme",
    group: "appearance",
    tier: 1,
    type: "enum",
    options: ["system", "light", "dark"],
    default: "system",
    title: "Theme",
    description:
      "Whether DevFlow follows the operating system or is pinned to light or dark. In the DevTools panel, “System” means the theme DevTools itself is set to, which DevTools lets you choose independently of the OS; a light or dark choice here wins on every surface.",
    consumers: ["content", "ui"],
    wired: true,
  },

  // ── Recording ──────────────────────────────────────────────────────────────
  {
    key: "recording.maxSteps",
    group: "recording",
    tier: 1,
    type: "number",
    default: MAX_STEPS,
    min: 10,
    max: 5000,
    unit: "steps",
    title: "Stop recording after N steps",
    description:
      "A long QA pass legitimately exceeds it; someone else wants a hard 50.",
    consequence:
      "Recording stops at this number. A run that hits it is cut off, not paused.",
    // The cap is always in force; it only *bites* when it is low enough that an
    // ordinary pass reaches it. The description's "someone else wants a hard 50"
    // is the case this is warning about.
    consequenceWhen: { below: 200 },
    consumers: ["worker"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.warnSteps",
    group: "recording",
    tier: 1,
    type: "number",
    default: WARN_STEPS,
    min: 10,
    max: 5000,
    unit: "steps",
    title: "Warn at N steps",
    description: "Follows the above.",
    consumers: ["ui"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.inputDebounceMs",
    group: "recording",
    tier: 1,
    type: "number",
    default: INPUT_DEBOUNCE_MS,
    min: 100,
    max: 5000,
    unit: "ms",
    title: "Typing debounce",
    description: "Fast typists lose steps; slow forms want longer.",
    consequence:
      "Typing is committed as one step after this much quiet. Shorter splits a single field into several steps.",
    // The sentence is about *shorter*, so it says nothing at 2000ms. Below
    // ~400ms a normal typing pause splits one field across several steps.
    consequenceWhen: { below: 400 },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.domDelta",
    group: "recording",
    tier: 1,
    type: "boolean",
    default: CAPTURE_DOM_DELTA,
    title: "Record what changed on screen",
    description: "The delay is app-specific; the feature is worth a switch.",
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.domDeltaMs",
    group: "recording",
    tier: 1,
    type: "number",
    default: DOM_DELTA_MS,
    min: 100,
    max: 5000,
    unit: "ms",
    title: "Wait before reading the change",
    description: "The delay is app-specific; the feature is worth a switch.",
    consequence:
      "Too short and the change has not happened yet; too long and it is the next thing the user did.",
    // The one consequence in the table that is true at both ends, which is why
    // `below` and `above` are OR-ed rather than being alternatives.
    consequenceWhen: { below: 300, above: 2000 },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.domMutations",
    group: "recording",
    tier: 1,
    type: "boolean",
    default: CAPTURE_DOM_MUTATIONS,
    title: "Record what changed in the page",
    // Its own switch rather than a mode of the one above, because the two
    // answer different questions and either is worth having alone: the region
    // read says what the button now says, and this says the dialog opened.
    description:
      "What appeared, went or was rewritten anywhere in the document across each interaction — not just the region around it. Watched for the same window as the change above, and folded, so a hundred rows appended is one line.",
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.domMutationCap",
    group: "recording",
    tier: 2,
    type: "number",
    default: DOM_MUTATION_CAP,
    min: 20,
    max: 5000,
    unit: "records",
    title: "Mutations watched per step",
    description: "How many changes the observer looks at before it stops.",
    // The one of the two whose cost lands on the page rather than on the
    // recording, which is why it is the one with the consequence written from
    // the page's side.
    consequence:
      "The observer disconnects when it reaches this, so a page that animates costs a step this much work and no more. Past it nothing is seen, and the step says it was capped rather than that nothing else changed.",
    consequenceWhen: { above: DOM_MUTATION_CAP },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.domMaxChanges",
    group: "recording",
    tier: 2,
    type: "number",
    default: DOM_MAX_CHANGES,
    min: 1,
    max: 100,
    unit: "changes",
    title: "Changes kept per step",
    description: "Distinct changes one step reports, after repeats are folded.",
    consequence:
      "Spent structural changes first, then text, then attributes, and style last — so what a low number drops is the least of what was seen. The step says how many it did not print.",
    consequenceWhen: { below: DOM_MAX_CHANGES },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  // ── The app's own state ────────────────────────────────────────────────────
  //
  // Under `recording.` rather than a `state.` prefix of its own, because
  // `docs/CONTRACTS.md` §3.6 enumerates the prefixes the Recording group owns
  // and it is frozen. A prefix that is not in that table does not exist, and
  // the honest reading of the gap is to use one that is — the same conclusion
  // `features/arkg/ingest.ts` reached about its own missing key.
  {
    key: "recording.state",
    group: "recording",
    tier: 1,
    type: "boolean",
    default: CAPTURE_STATE,
    title: "Record the app’s state",
    // The privacy point is in the description rather than a `consequence`,
    // because no boolean in this table carries one: a consequence shows while a
    // setting is merely *modified*, and for a switch that is on by default the
    // sentence a user needs is the one they read before touching it.
    description:
      "The difference between what the app’s stores held before each interaction and after it settled. A store holds whatever the app put in it, which on some apps includes the signed-in user.",
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.stateSettleMs",
    group: "recording",
    tier: 1,
    type: "number",
    default: STATE_SETTLE_MS,
    min: 100,
    max: 5000,
    unit: "ms",
    title: "Wait before reading state back",
    description: "The delay is app-specific; the feature is worth a switch.",
    consequence:
      "Too short and the store has not been written yet; too long and the change belongs to the next thing the user did.",
    consequenceWhen: { below: 300, above: 2000 },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.stateMaxDepth",
    group: "recording",
    tier: 2,
    type: "number",
    default: STATE_MAX_DEPTH,
    min: 1,
    max: 12,
    title: "State depth",
    description: "How deep into a store one snapshot goes.",
    consequence:
      "Anything below the cut reads as unchanged whether it changed or not. The step says the snapshot was cut, but it cannot say what it missed.",
    // Shallower than the shipped depth is where a normalised store starts
    // hiding its interesting half; deeper only costs size, which the other
    // caps already speak for.
    consequenceWhen: { below: STATE_MAX_DEPTH },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.stateMaxKeys",
    group: "recording",
    tier: 2,
    type: "number",
    default: STATE_MAX_KEYS,
    min: 4,
    max: 400,
    unit: "keys",
    title: "State keys per object",
    description: "Keys kept from one object in a snapshot, in sorted order.",
    consequence:
      "Keys are sorted and then cut, so the cut is the same in both snapshots and a diff never invents a change. What it does mean below the shipped value is that a store with more slices than this loses the ones late in the alphabet entirely.",
    consequenceWhen: { below: STATE_MAX_KEYS },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.stateMaxEntries",
    group: "recording",
    tier: 2,
    type: "number",
    default: STATE_MAX_ENTRIES,
    min: 2,
    max: 200,
    unit: "entries",
    title: "State entries per list",
    description: "Entries kept from one array in a snapshot.",
    consequence:
      "Only the head of a longer list is kept, so an append past this point looks like nothing happening — the list a store holds is usually longer than the part of it that changed.",
    consequenceWhen: { below: STATE_MAX_ENTRIES },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.stateStringCap",
    group: "recording",
    tier: 2,
    type: "number",
    default: STATE_STRING_CAP,
    min: 20,
    max: 4000,
    unit: "chars",
    title: "State string cap",
    description: "Characters kept from one string in a snapshot.",
    consequence:
      "Two strings that differ only past the cut read as identical, so an edit to the tail of a long value is a change the patch cannot see. The step says the snapshot was cut; it cannot say where.",
    consequenceWhen: { below: STATE_STRING_CAP },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.stateMaxStores",
    group: "recording",
    tier: 2,
    type: "number",
    default: STATE_MAX_STORES,
    min: 1,
    max: 32,
    unit: "stores",
    title: "Stores read",
    description: "How many of the page’s stores one recording reads.",
    consequence:
      "The innermost providers are kept and the outermost cut, so below this the stores that go are the ones wrapped around the whole app — the theme, the session — while the route’s own survive.",
    consequenceWhen: { below: STATE_MAX_STORES },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.statePatchOps",
    group: "recording",
    tier: 2,
    type: "number",
    default: STATE_MAX_PATCH_OPS,
    min: 1,
    max: 500,
    unit: "ops",
    title: "State patch operations",
    description: "Operations one store’s patch may carry for one step.",
    consequence:
      "Over budget the patch is re-cut at a shallower path, never trimmed — it stays applicable and becomes coarser, and the step counts what that cost.",
    consequenceWhen: { below: STATE_MAX_PATCH_OPS },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  // ── What re-rendered ───────────────────────────────────────────────────────
  //
  // Under `recording.` for the reason the state block above gives: §3.6 is
  // frozen and enumerates the prefixes this group owns.
  {
    key: "recording.renders",
    group: "recording",
    tier: 1,
    type: "boolean",
    default: CAPTURE_RENDERS,
    title: "Record which components re-rendered",
    description:
      "Which components re-rendered across each interaction, and which of their props, state and contexts changed value. Read off the fibers React already keeps — nothing is installed on the page.",
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.renderNodeCap",
    group: "recording",
    tier: 2,
    type: "number",
    default: RENDER_NODE_CAP,
    min: 100,
    max: 20000,
    unit: "fibers",
    title: "Components compared per interaction",
    description: "How far the walk goes before it stops, each time it samples.",
    // The one number here whose cost lands on the user rather than on the
    // recording: the first of the two walks runs inside the click.
    consequence:
      "The first walk of each pair runs inside the interaction, so raising this is latency the person recording feels. Past the cap components are never compared, and the recording says it was capped rather than that nothing re-rendered.",
    consequenceWhen: { above: RENDER_NODE_CAP },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  // ── Accessibility ──────────────────────────────────────────────────────────
  //
  // Under `recording.` with the two blocks above it, for the reason they give:
  // §3.6 of the frozen contract enumerates the prefixes this group owns.
  {
    key: "recording.a11y",
    group: "recording",
    tier: 1,
    type: "boolean",
    default: CAPTURE_A11Y,
    title: "Audit accessibility while recording",
    // No `consequence`, because no boolean in this table carries one — see the
    // note on `recording.state`. This is the only recorder capture that is off
    // by default, and the reason is a measurement rather than a policy: the
    // settled walk asks the browser for a computed style per element, which is
    // the one reading here that makes the engine do work rather than handing
    // over something it already has. So the cost goes in the sentence somebody
    // reads before switching it on.
    description:
      "Contrast against the colours the browser actually computed, missing accessible names, controls the keyboard cannot reach, and whether focus moved into a dialog that opened. Read off the page once it has settled — nothing is installed and nothing is simulated. Costs one extra walk of the page per interaction, which is why it is off until you ask for it.",
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.a11yNodeCap",
    group: "recording",
    tier: 2,
    type: "number",
    default: A11Y_NODE_CAP,
    min: 100,
    max: 20000,
    unit: "elements",
    title: "Elements audited per interaction",
    // Says outright that the walk it budgets is not running. This is the one
    // number in the table whose parent capture ships off, so on a fresh install
    // it is a control that governs nothing — and a control that silently does
    // nothing is the failure `wired` exists to prevent, arriving here by a
    // different route.
    description:
      "How far the accessibility walk goes before it stops. The audit above is off until you switch it on, so on a new installation this number decides nothing yet.",
    consequence:
      "Past the cap elements are never audited, and the step says it was capped rather than that the page is clean. This walk runs after the app has settled rather than inside the interaction, so raising it is not latency the person recording feels.",
    consequenceWhen: { above: A11Y_NODE_CAP },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.renderMaxComponents",
    group: "recording",
    tier: 2,
    type: "number",
    default: RENDER_MAX_COMPONENTS,
    min: 1,
    max: 200,
    unit: "components",
    title: "Re-rendered components kept per step",
    description: "Components one step may report, busiest first.",
    consequence:
      "A step that re-rendered more than this keeps the ones with the most changes and says the list was cut.",
    consequenceWhen: { below: RENDER_MAX_COMPONENTS },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.renderMaxChanges",
    group: "recording",
    tier: 2,
    type: "number",
    default: RENDER_MAX_CHANGES,
    min: 1,
    max: 50,
    unit: "changes",
    title: "Changes kept per component",
    description: "Changed props, hooks and contexts reported for one component.",
    consequence:
      "A component handed forty changed props is one fact about its parent; the fortieth adds nothing to it.",
    consequenceWhen: { below: RENDER_MAX_CHANGES },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.containerTextCap",
    group: "recording",
    tier: 1,
    type: "number",
    default: CONTAINER_TEXT_CAP,
    min: 40,
    max: 4000,
    unit: "chars",
    title: "Region text kept",
    description: "Dense UIs want more.",
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.trailingStep",
    group: "recording",
    tier: 1,
    type: "boolean",
    default: CAPTURE_TRAILING_STEP,
    title: "Collect the trailing step on Stop",
    description: "New behaviour; should be visible and refusable.",
    consumers: ["worker"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.spaSettleMs",
    group: "recording",
    tier: 2,
    type: "number",
    default: SPA_SETTLE_MS,
    min: 0,
    max: 5000,
    unit: "ms",
    title: "Single-page route settle",
    description:
      "How long to let a single-page app render its new route before screenshotting.",
    consequence:
      "The URL changes first and the framework paints afterwards, so below the shipped 250ms the screenshot is of the route the user has just left.",
    consequenceWhen: { below: SPA_SETTLE_MS },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "recording.reloadTimeoutMs",
    group: "recording",
    tier: 2,
    type: "number",
    default: RELOAD_TIMEOUT_MS,
    min: 1000,
    max: 120_000,
    unit: "ms",
    title: "Reload timeout",
    description:
      "How long to wait for a reloading tab to come back before recording anyway.",
    consequence:
      "A backstop only. Below a couple of seconds a normal page load looks like a hang, and recording starts against a blank tab.",
    consequenceWhen: { below: 2000 },
    consumers: ["ui"],
    wired: true,
  },

  // ── Screenshots ────────────────────────────────────────────────────────────
  {
    key: "screenshots.capture",
    group: "screenshots",
    tier: 1,
    type: "boolean",
    default: CAPTURE_SCREENSHOTS,
    title: "Capture screenshots",
    description:
      "A page with sensitive content on every screen; a much lighter flow.",
    consequence:
      "Off means every step is text. The flow says so rather than looking as though capture failed.",
    consequenceWhen: { is: false },
    consumers: ["worker"],
    recorded: true,
    wired: true,
  },
  {
    key: "screenshots.quality",
    group: "screenshots",
    tier: 1,
    type: "number",
    default: SCREENSHOT_QUALITY,
    min: 1,
    max: 100,
    unit: "%",
    title: "Screenshot quality",
    description: "Text-heavy UIs need 80; storage-constrained users want 35.",
    consequence:
      "Below about 30, small text in a screenshot stops being readable.",
    // The sentence names its own threshold. Without this it also appeared at 90,
    // where the opposite is true.
    consequenceWhen: { below: 30 },
    consumers: ["worker", "ui"],
    recorded: true,
    wired: true,
  },
  {
    key: "screenshots.settleDelayMs",
    group: "screenshots",
    tier: 1,
    type: "number",
    default: SETTLE_DELAY_MS,
    min: 0,
    max: 5000,
    unit: "ms",
    title: "Wait before screenshotting",
    description:
      "A slow app paints its response after 400ms and every screenshot is early. Only used when there is no pre-capture to fall back on.",
    /*
     * The old consequence was "Only used when there is no pre-capture to fall
     * back on", which is a *qualifier* — it says when the setting applies, not
     * what a bad value costs — and there is no threshold that makes it true.
     * It moved into the description, where a qualifier belongs, and the
     * consequence now names the degradation a Tier 1 setting is required to
     * state: a screenshot of the page before it changed.
     */
    consequence:
      "Below about 100ms a slow app has not painted its response yet, and the step is a picture of the page before it changed.",
    consequenceWhen: { below: 100 },
    consumers: ["worker"],
    recorded: true,
    wired: true,
  },
  {
    key: "screenshots.minIntervalMs",
    group: "screenshots",
    tier: 2,
    type: "number",
    default: CAPTURE_MIN_INTERVAL_MS,
    min: 0,
    max: 10_000,
    unit: "ms",
    title: "Minimum interval between captures",
    description: "Captures are spaced by this instead of being fired and lost.",
    consequence:
      "Chrome allows roughly two captures a second. Below the shipped 550ms it rejects the rest, and those steps silently have no image.",
    consequenceWhen: { below: CAPTURE_MIN_INTERVAL_MS },
    consumers: ["worker"],
    recorded: true,
    wired: true,
  },
  {
    key: "screenshots.precaptureTtlMs",
    group: "screenshots",
    tier: 2,
    type: "number",
    default: PRECAPTURE_TTL_MS,
    min: 0,
    max: 30_000,
    unit: "ms",
    title: "Pre-capture lifetime",
    description:
      "How long a screenshot taken on pointerdown stays claimable by the click that follows.",
    consequence:
      "Too short and a link click has no image, because the page navigated before the click was recorded; too long and a click claims a picture of a page that has since changed.",
    consequenceWhen: { below: 500, above: 10_000 },
    consumers: ["worker"],
    recorded: true,
    wired: true,
  },
  {
    key: "screenshots.paintTimeoutMs",
    group: "screenshots",
    tier: 2,
    type: "number",
    default: PAINT_TIMEOUT_MS,
    min: 0,
    max: 2000,
    unit: "ms",
    title: "Repaint wait",
    description:
      "How long to wait for a repaint before giving up and capturing anyway.",
    consequence:
      "The recording indicator is hidden before every capture and this is how long the page is given to repaint. At zero the indicator is in the screenshots.",
    consequenceWhen: { below: 10 },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },

  // ── Network ────────────────────────────────────────────────────────────────
  {
    key: "network.captureBodies",
    group: "network",
    tier: 1,
    type: "boolean",
    default: CAPTURE_BODIES,
    title: "Capture request/response bodies",
    description:
      "The single biggest privacy and size lever, and it has no switch.",
    consequence:
      "Off means requests are recorded with their method, URL and status but no payload.",
    consequenceWhen: { is: false },
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },
  {
    key: "network.bodyCap",
    group: "network",
    tier: 1,
    type: "number",
    default: BODY_CAP,
    min: 0,
    max: 5 * 1024 * 1024,
    unit: "bytes",
    title: "Body capture limit",
    description: "Enough for most; far too much for an app that streams.",
    consequence:
      "Bodies over this are truncated before leaving the page, and marked as truncated.",
    // Truncation is the point of the setting, so saying so at 200 KB is
    // wallpaper. Below 8 KB an ordinary JSON response no longer survives whole.
    consequenceWhen: { below: 8192 },
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },
  {
    key: "network.summariseBodies",
    group: "network",
    tier: 1,
    type: "boolean",
    default: SUMMARISE_BODIES,
    title: "Summarise bodies at all",
    description: "Someone debugging a serialisation bug needs the bytes.",
    consumers: ["ui", "mcp"],
    rendered: true,
    wired: true,
  },
  {
    key: "network.schemaThreshold",
    group: "network",
    tier: 1,
    type: "number",
    default: SCHEMA_THRESHOLD,
    min: 0,
    max: 1024 * 1024,
    unit: "bytes",
    title: "Summarise bodies larger than",
    description: "The schema/verbatim tradeoff is genuinely per-app.",
    consumers: ["ui", "mcp"],
    rendered: true,
    wired: true,
  },

  // ── The three that change what the page sends ──────────────────────────────
  //
  // Every other row in this table narrows what DevFlow writes down. These three
  // decide whether an outbound request leaves the page carrying a header it
  // would not otherwise have carried, which is a different kind of act — so
  // they are off by default, read only while a recording is running, and
  // `recorded: true` so a flow says which of them its requests were made under.
  // A reader who cannot tell whether a recording's traffic was modified has to
  // assume it was. The rule itself is `decideTrace` in `core/trace`, and its
  // header is where the argument for the shape of all three is written.
  {
    key: "network.traceHeader",
    group: "network",
    tier: 2,
    type: "boolean",
    default: TRACE_HEADER_ENABLED,
    title: "Tag recorded requests with a trace id",
    description:
      "While a flow is recording, outbound requests carry an `X-DevFlow-Trace-Id` header holding the same id the recording shows — so the request in front of you can be found in your backend’s own logs by searching for that id. Nothing is added when no recording is running.",
    consequence:
      "A cross-origin request that gains a custom header stops being a simple request, so the browser sends an OPTIONS preflight it did not send before, and a backend that does not name the header in Access-Control-Allow-Headers fails the request outright. Same-origin requests are exempt from CORS and cannot fail this way; every other destination is left alone until it is named below.",
    consequenceWhen: { is: true },
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },
  {
    key: "network.traceparent",
    group: "network",
    tier: 2,
    type: "boolean",
    default: TRACEPARENT_ENABLED,
    title: "Tag recorded requests with a W3C traceparent",
    // A separate row and not a mode of the one above, because the two carry
    // different risk in both directions: this one a backend is more likely to
    // accept already, and more likely to act on once it has.
    description:
      "The standard header rather than the bespoke one, so a backend running OpenTelemetry files the request under the id the recording shows. A request the page already sent a traceparent on is left exactly as the page built it — overwriting one would splice a recording into the middle of somebody’s production trace tree.",
    consequence:
      "The header is marked sampled, which asks an OpenTelemetry backend to record traces it would otherwise have sampled away — a real cost on somebody’s observability bill, and one that has nothing to do with CORS. The preflight above applies here too: a cross-origin destination has to be named below or the request fails.",
    consequenceWhen: { is: true },
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },
  {
    key: "network.traceOrigins",
    group: "network",
    tier: 2,
    type: "string",
    default: TRACE_ORIGINS,
    /*
     * Absolute http(s) addresses, separated by whitespace or commas, or
     * nothing at all. Deliberately no stricter than that: `parseOrigins` in
     * `core/trace` is what turns each entry into the origin the rule compares,
     * and it accepts the trailing slash and the path a person gets by pasting
     * from an address bar. A pattern that rejected those would refuse the value
     * the parser was written to forgive, and refuse it by silently resolving
     * the whole field back to empty — which is the failure this row is least
     * able to afford, since the visible symptom is a header that never appears.
     *
     * What it does reject is a value that is not addresses at all, and that
     * falls back to empty. Empty is the safe direction: nothing cross-origin is
     * given a header.
     */
    pattern: /^[,\s]*(?:https?:\/\/[^\s,]+(?:[,\s]+https?:\/\/[^\s,]+)*[,\s]*)?$/,
    maxLength: 2048,
    title: "Cross-origin destinations that accept a trace header",
    // The cost is in the description rather than in a `consequence`, and the
    // reason is the one `recording.state` gives: a consequence has to name the
    // range it is true in, and for a list of origins that range is "not empty",
    // which is the bare-consequence rule — and the bare rule is spoken for. The
    // sentence a user needs here is the one they read before typing, not after.
    description:
      "Origins the two switches above may add a header to — `https://api.example.com`, separated by spaces or commas. Pasting the whole address of an endpoint works; only its origin is kept. Same-origin requests need no entry and never consult this list. Everything else is left alone until it is named here, because naming an origin is you saying that backend accepts the header: there is no way to discover that except by sending the request that might fail, and a failed preflight has already rejected the page’s own request by the time anyone hears about it.",
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },

  // ── Console ────────────────────────────────────────────────────────────────
  {
    key: "console.levels",
    group: "console",
    tier: 1,
    type: "levels",
    default: CONSOLE_LEVELS,
    options: CONSOLE_LEVELS,
    title: "Console levels captured",
    description:
      "Most users want error+warn only, at capture rather than at export.",
    consequence:
      "A level not selected is never recorded, so it cannot be recovered at export.",
    /*
     * No `consequenceWhen`, deliberately. The default is all five levels, so
     * "modified" and "a level has been switched off" are the same condition —
     * the bare-consequence rule is already exactly right here, and a threshold
     * would be a less accurate way of saying it. Left explicit because the next
     * reader auditing this column will otherwise assume it was missed.
     */
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },
  {
    key: "console.captureUncaught",
    group: "console",
    tier: 1,
    type: "boolean",
    default: CAPTURE_UNCAUGHT,
    title: "Capture uncaught errors",
    description:
      "No good reason to turn off, but it is new behaviour and should be visible.",
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },
  {
    key: "console.logArgCap",
    group: "console",
    tier: 2,
    type: "number",
    default: LOG_ARG_CAP,
    min: 64,
    max: 1024 * 1024,
    unit: "chars",
    title: "Console argument limit",
    description: "Per-argument ceiling on a captured console line.",
    consequence:
      "A page that logs its whole store on every action attaches this much to every step that follows, and every capture rewrites the whole step array.",
    consequenceWhen: { above: LOG_ARG_CAP },
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },
  {
    key: "console.stackFrames",
    group: "console",
    tier: 2,
    type: "number",
    default: STACK_FRAMES,
    min: 0,
    max: 100,
    title: "Stack frames kept",
    description:
      "How much of a stack trace is worth keeping. Deeper frames are framework.",
    consequence:
      "At zero a captured error keeps its message and nothing about where it came from — which is the half of it a reader needs.",
    consequenceWhen: { below: 1 },
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },

  // ── Annotation ─────────────────────────────────────────────────────────────
  {
    key: "annotation.stroke",
    group: "annotation",
    tier: 1,
    type: "string",
    default: ANNOTATION_STROKE,
    pattern: /^#[0-9a-fA-F]{6}$/,
    maxLength: 7,
    title: "Annotation colour",
    // The pattern is the whole of what this row will accept, and until this
    // sentence said so the only copy on screen was the reason to change it. A
    // free-text field that refuses `red` and `#f00` without ever having asked
    // for `#RRGGBB` is a field whose rule the user has to discover by being
    // told no.
    description:
      "Red is invisible on a red error banner. Six hex digits with a leading hash — `#2E7DFF`.",
    consumers: ["worker", "ui"],
    recorded: true,
    wired: true,
  },

  // ── Export and send ────────────────────────────────────────────────────────
  {
    key: "export.format",
    group: "export",
    tier: 1,
    type: "enum",
    // Every format the export dialog offers, and it has to be every one of
    // them: `ExportFormat` in `features/export/formats.ts` gained the two
    // compilers, this list did not, and a format the dialog draws that the
    // default cannot name is a preference somebody can express once per export
    // and never once for good.
    options: ["zip", "markdown", "json", "playwright", "cypress"],
    default: EXPORT_DEFAULT_FORMAT,
    title: "Default export format",
    description:
      "ZIP carries the screenshots as files beside the document; Markdown and JSON are one file. Playwright and Cypress compile the flow to a runnable spec instead of describing it.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "export.images",
    group: "export",
    tier: 1,
    type: "boolean",
    default: EXPORT_DEFAULT_IMAGES,
    title: "Export includes screenshots",
    description:
      "Screenshots are most of an archive’s size and most of its value.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "export.network",
    group: "export",
    tier: 1,
    type: "boolean",
    default: EXPORT_DEFAULT_NETWORK,
    title: "Export includes network",
    description:
      "Request and response bodies — the most useful thing in an export and the most likely to hold something private.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "export.logs",
    group: "export",
    tier: 1,
    type: "boolean",
    default: EXPORT_DEFAULT_LOGS,
    title: "Export includes console",
    description:
      "Console errors and warnings, beside the step that produced them.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "export.react",
    group: "export",
    tier: 1,
    type: "boolean",
    default: EXPORT_DEFAULT_REACT,
    title: "Export includes components",
    description: "The component table, and the source file behind each step.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "export.sendImages",
    group: "export",
    tier: 1,
    type: "boolean",
    default: SEND_DEFAULT_IMAGES,
    title: "Send includes screenshots",
    description:
      "The server writes screenshots to disk, so Claude pays only for the ones it opens.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "export.sendNetwork",
    group: "export",
    tier: 1,
    type: "boolean",
    default: SEND_DEFAULT_NETWORK,
    title: "Send includes network",
    description:
      "Read back with every step, so on a chatty API they are most of the context. Off by default for that reason.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "export.sendLogs",
    group: "export",
    tier: 1,
    type: "boolean",
    default: SEND_DEFAULT_LOGS,
    title: "Send includes console",
    description:
      "Read back with every step. Off by default, like the bodies beside them.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "export.sendReact",
    group: "export",
    tier: 1,
    type: "boolean",
    default: SEND_DEFAULT_REACT,
    title: "Send includes components",
    description:
      "What lets Claude open the right file instead of searching for the component by name.",
    consumers: ["ui"],
    wired: true,
  },

  // ── React attribution ──────────────────────────────────────────────────────
  {
    key: "reactCapture",
    group: "react",
    tier: 1,
    type: "boolean",
    default: REACT_SETTING_DEFAULTS.reactCapture,
    title: "Record the React component behind each step",
    description:
      "The master switch for the whole feature: off means the agent never attaches its listeners, so a page that is not being attributed costs nothing at all.",
    consumers: ["content", "agent"],
    recorded: true,
    wired: true,
  },
  {
    key: "reactResolve",
    group: "react",
    tier: 1,
    type: "boolean",
    default: REACT_SETTING_DEFAULTS.reactResolve,
    title: "Find the file each component was written in",
    description:
      "Separate from capture because the two have different costs: naming a component is free, while finding its file reads the page’s scripts.",
    consumers: ["worker"],
    recorded: true,
    wired: true,
  },
  {
    key: "react.useSourceMaps",
    group: "react",
    tier: 1,
    type: "boolean",
    default: USE_SOURCE_MAPS,
    title: "Read source maps when you locate one component",
    description:
      "Separate from the switch above because the two costs are paid at different moments: that one governs a background pass over a whole recording, this one governs the single lookup somebody is sitting and waiting for. One switch for both would mean stopping a slow pick by turning off the pass a recording depends on, or paying for that whole pass to get one answer now.",
    consequence:
      "Off, a pick names the component and the bundled file it was compiled into, and stops there. There is no original file to open.",
    // The sentence is about being off, and being off is the whole of it — a
    // `modified` fallback would say the same thing, but this way the row is
    // explicit that there is exactly one state worth warning about.
    consequenceWhen: { is: false },
    consumers: ["worker", "ui"],
    wired: true,
  },
  {
    key: "projectRoot",
    group: "react",
    tier: 1,
    type: "string",
    default: REACT_SETTING_DEFAULTS.projectRoot,
    maxLength: 4096,
    title: "Project root",
    description:
      "Absolute local path the source paths sit under, so a component’s file can be opened in an editor — whether the component was recorded in a step or picked out of the page. Empty means no link is offered.",
    consumers: ["content", "ui"],
    wired: true,
  },
  {
    key: "editor",
    group: "react",
    tier: 1,
    type: "enum",
    options: Object.keys(EDITORS),
    default: REACT_SETTING_DEFAULTS.editor,
    title: "Editor",
    description: "Which editor a source link opens.",
    consumers: ["content", "ui"],
    wired: true,
  },
  {
    key: "customEditorTemplate",
    group: "react",
    tier: 1,
    type: "string",
    default: REACT_SETTING_DEFAULTS.customEditorTemplate,
    maxLength: 2048,
    title: "Custom editor URL template",
    description:
      "Used when the editor is “Custom…”. `{path}` is absolute; `{line}`/`{col}` are 0-based, `{line1}`/`{col1}` are 1-based.",
    consequence:
      "The URL is handed to the browser, so a template that produced an https:// address would make this field a way to open arbitrary pages. It is validated before use.",
    /*
     * No `consequenceWhen`, for the same reason `console.levels` has none. The
     * default is the empty string, so "modified" and "there is a template to
     * validate" are one condition. `commitProblem` in `ui/settings/view.ts`
     * says the more specific thing at the keystroke that caused it.
     */
    consumers: ["content", "ui"],
    wired: true,
  },
  {
    key: "locator.hidden.routing",
    group: "react",
    tier: 1,
    type: "boolean",
    default: HIDE_COMPONENT_CATEGORY,
    title: "Hide routers in component trees",
    description:
      "Routers, routes and switches — react-router and its relatives. Hidden by default because an ancestor chain is mostly these; bring them back when the question is which route rendered the page.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "locator.hidden.providers",
    group: "react",
    tier: 1,
    type: "boolean",
    default: HIDE_COMPONENT_CATEGORY,
    title: "Hide providers in component trees",
    description:
      "Context, store and client providers. They wrap everything and are almost never the component that was clicked; bring them back when the question is where a value came from.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "locator.hidden.react",
    group: "react",
    tier: 1,
    type: "boolean",
    default: HIDE_COMPONENT_CATEGORY,
    title: "Hide React internals in component trees",
    description:
      "Fragment, Suspense, Portal, StrictMode, and the memo and forwardRef wrappers React inserts on its own. Nobody wrote these, so there is no file behind one to open.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "locator.hidden.styling",
    group: "react",
    tier: 1,
    type: "boolean",
    default: HIDE_COMPONENT_CATEGORY,
    title: "Hide styling wrappers in component trees",
    description:
      "Theme providers, style engines and headless UI primitives. They sit between the component that was written and the node that was clicked, and hiding them is what leaves the two ends of that chain next to each other.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "locator.hidden.dependency",
    group: "react",
    tier: 1,
    type: "boolean",
    default: HIDE_COMPONENT_CATEGORY,
    title: "Hide components from node_modules",
    description:
      "Anything React recorded as living in node_modules — and in a production build, where no source is recorded, anything matching a list of known names instead. Components written in this project are never hidden by any of these five.",
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "react.maxComponentsPerFlow",
    group: "react",
    tier: 1,
    type: "number",
    default: MAX_COMPONENTS_PER_FLOW,
    min: 1,
    max: 10_000,
    title: "Component budget per flow",
    description:
      "Large apps exceed it. Reaching the cap is written into the component table, so a flow never quietly stops naming components.",
    consequence:
      "Components seen after this many are not recorded, and the steps inside them carry no source file.",
    // A runaway guard at its default: a flow that sees 128 distinct components
    // is already unusual. It only *bites* when somebody sets it low, which is
    // the case the sentence is about.
    consequenceWhen: { below: 20 },
    consumers: ["worker"],
    recorded: true,
    wired: true,
  },
  {
    key: "react.maxResolveMsPerFlow",
    group: "react",
    tier: 1,
    type: "number",
    default: MAX_RESOLVE_MS_PER_FLOW,
    min: 1000,
    max: 600_000,
    unit: "ms",
    title: "Source-resolution time budget",
    description:
      "Big bundles need longer; impatient users want less. Whatever is cut off is recorded as skipped with a sentence rather than left looking unresolvable.",
    consequence:
      "A pass that runs out of time leaves components with no file path — on a large app most of them, since the bundles are read before anything is found in them.",
    // Phase 3's rule, applied: the shipped 30s finishes an ordinary app, so the
    // sentence is only true once somebody has cut the budget to a few seconds.
    consequenceWhen: { below: 5000 },
    consumers: ["worker"],
    wired: true,
  },
  {
    key: "react.maxComponentChain",
    group: "react",
    tier: 2,
    type: "number",
    default: MAX_COMPONENT_CHAIN,
    min: 1,
    max: 100,
    title: "Component chain depth",
    description:
      "How many components above a clicked element are kept, counting outwards.",
    consequence:
      "Below about four the chain rarely reaches the component that owns the element; above twenty-four the far end is App wrapped in nine providers, at a toString() and a hash each.",
    consequenceWhen: { below: 4, above: 24 },
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },
  {
    key: "react.maxFiberWalk",
    group: "react",
    tier: 2,
    type: "number",
    default: MAX_FIBER_WALK,
    min: 100,
    max: 100_000,
    title: "Fiber walk ceiling",
    description: "Hard cap on raw fibers visited while walking (cycle guard).",
    consequence:
      "A cycle guard, not a budget. Below a few hundred the walk gives up inside a deep provider tree and the step records no component at all.",
    consequenceWhen: { below: 500 },
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },
  {
    key: "react.chainTimeoutMs",
    group: "react",
    tier: 2,
    type: "number",
    default: REACT_CHAIN_TIMEOUT_MS,
    min: 0,
    max: 2000,
    unit: "ms",
    title: "Chain wait",
    description:
      "How long the content script waits for the component chain before writing the step without it. A step is never held hostage to it — no chain simply means no chain.",
    consequence:
      "Below about 20ms the chain regularly arrives after its step has been written, and the step records no component even though the walk found one.",
    consequenceWhen: { below: 20 },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "react.bufferSize",
    group: "react",
    tier: 2,
    type: "number",
    default: REACT_BUFFER_SIZE,
    min: 1,
    max: 1000,
    title: "Chain buffer size",
    description: "Chains held for a step that has not asked for them yet.",
    consequence:
      "Chains arrive before the step that claims them. Below a handful, a burst of clicks evicts chains that were still waiting, and those steps record no component.",
    consequenceWhen: { below: 4 },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "react.bufferTtlMs",
    group: "react",
    tier: 2,
    type: "number",
    default: REACT_BUFFER_TTL_MS,
    min: 100,
    max: 60_000,
    unit: "ms",
    title: "Chain buffer lifetime",
    description: "How long an unclaimed chain stays in the buffer.",
    consequence:
      "A typed step asks for its chain 800ms after the keystroke, by the typing debounce. Below about a second, an input step’s components have already expired.",
    consequenceWhen: { below: 1000 },
    consumers: ["content"],
    recorded: true,
    wired: true,
  },
  {
    key: "react.prewarmTtlMs",
    group: "react",
    tier: 2,
    type: "number",
    default: REACT_PREWARM_TTL_MS,
    min: 0,
    max: 10_000,
    unit: "ms",
    title: "Pre-warmed chain lifetime",
    description:
      "A chain is walked on pointerdown so the click that follows does not pay for it. This is how long that head start stays usable.",
    consequence:
      "At zero every click walks the fiber tree itself, on the click, which is the pause the pre-warm exists to remove.",
    consequenceWhen: { below: 100 },
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },
  {
    key: "react.resolveConcurrency",
    group: "react",
    tier: 2,
    type: "number",
    default: RESOLVE_CONCURRENCY,
    min: 1,
    max: 32,
    title: "Bundles fetched at once",
    description: "Bundles fetched at once while resolving.",
    consequence:
      "These fetches share the page’s connections. Above about eight, the app’s own requests queue behind DevFlow’s while the user is still recording.",
    consequenceWhen: { above: 8 },
    consumers: ["worker"],
    wired: true,
  },
  {
    key: "react.resolveDebounceMs",
    group: "react",
    tier: 2,
    type: "number",
    default: RESOLVE_DEBOUNCE_MS,
    min: 0,
    max: 60_000,
    unit: "ms",
    title: "Resolution debounce",
    description: "Quiet time after a step before resolution runs.",
    consequence:
      "Below about 500ms every click in a burst starts its own resolution pass, and they compete for the same bundle fetches while the recording is still running.",
    consequenceWhen: { below: 500 },
    consumers: ["worker"],
    wired: true,
  },
  {
    key: "react.bundleCacheEntries",
    group: "react",
    tier: 2,
    type: "number",
    default: BUNDLE_CACHE_ENTRIES,
    min: 1,
    max: 1000,
    title: "Bundle cache entries",
    description: "Bundle texts held in the worker’s cache at once.",
    consequence:
      "Below a handful, a flow that touches several chunks re-fetches and re-parses the same bundles for every component it resolves.",
    consequenceWhen: { below: 4 },
    consumers: ["worker"],
    wired: true,
  },
  {
    key: "react.bundleCacheBytes",
    group: "react",
    tier: 2,
    type: "number",
    default: BUNDLE_CACHE_BYTES,
    min: 1024 * 1024,
    max: 512 * 1024 * 1024,
    unit: "bytes",
    title: "Bundle cache size",
    description: "Total size of the bundle texts held in the worker’s cache.",
    consequence:
      "An MV3 worker that overruns its memory is killed outright — no warning, no error, and the resolution in flight is simply lost.",
    consequenceWhen: { above: BUNDLE_CACHE_BYTES },
    consumers: ["worker"],
    wired: true,
  },
  {
    key: "react.maxResourceBytes",
    group: "react",
    tier: 2,
    type: "number",
    default: MAX_RESOURCE_BYTES,
    min: 1024 * 1024,
    max: 512 * 1024 * 1024,
    unit: "bytes",
    title: "Largest script scanned",
    description:
      "Scripts larger than this are assets or data, not code worth scanning.",
    consequence:
      "Too low and a bundle over it is not scanned at all, so every component in it resolves to no file — which reads as React capture being broken rather than as a limit; too high and the script text sits in the worker’s heap, which an MV3 worker is killed for overrunning.",
    consequenceWhen: { below: MAX_RESOURCE_BYTES, above: MAX_RESOURCE_BYTES },
    consumers: ["worker"],
    wired: true,
  },
  {
    key: "react.maxMapBytes",
    group: "react",
    tier: 2,
    type: "number",
    default: MAX_MAP_BYTES,
    min: 1024 * 1024,
    max: 512 * 1024 * 1024,
    unit: "bytes",
    title: "Largest source map parsed",
    description: "Source maps larger than this are skipped outright.",
    consequence:
      "The string and its parsed form sit in the worker’s heap at once, and an MV3 worker that overruns is killed silently.",
    consequenceWhen: { above: MAX_MAP_BYTES },
    consumers: ["worker"],
    wired: true,
  },
  {
    key: "react.maxScriptsPerOrigin",
    group: "react",
    tier: 2,
    type: "number",
    default: MAX_SCRIPTS_PER_ORIGIN,
    min: 1,
    max: 10_000,
    title: "Script URLs remembered per origin",
    description: "A code-split app can legitimately load a hundred chunks.",
    consequence:
      "Below a hundred, a code-split app’s later chunks are forgotten and the components in them resolve to no file.",
    consequenceWhen: { below: 100 },
    consumers: ["worker"],
    wired: true,
  },

  // ── Vue ────────────────────────────────────────────────────────────────────
  {
    key: "vue.maxVNodeWalk",
    group: "vue",
    tier: 2,
    type: "number",
    default: VUE_MAX_VNODE_WALK,
    min: 100,
    max: 1_000_000,
    title: "Vue tree search ceiling",
    description:
      "Vnodes one search may visit before it gives up. A production build deletes the link from an element to its component, so the whole tree is searched from the top on every click — and because the innermost match is the right one, the search always runs to the end. This is a size of page, not a length of walk: the shipped 20,000 covers about 17,000 elements at a sixth of a millisecond.",
    consequence:
      "Below about a thousand, any real page runs out before the element is reached and the step records no Vue component — reported as a search that gave up, not as a page without Vue. Every 100,000 raised costs about a millisecond per click on a page big enough to use it.",
    consequenceWhen: { below: 1000, above: 200_000 },
    consumers: ["agent"],
    recorded: true,
    wired: true,
  },

  // ── MCP ────────────────────────────────────────────────────────────────────
  {
    key: "mcpServerUrl",
    group: "mcp",
    tier: 1,
    type: "string",
    default: DEFAULT_MCP_URL,
    pattern: /^https?:\/\/\S+$/,
    maxLength: 2048,
    title: "MCP server address",
    // The scheme is not optional and nothing here used to say so. `127.0.0.1:7734/flows`
    // is what a person types when they mean the shipped address, and it is
    // exactly what the pattern refuses.
    description:
      "Where recorded flows are POSTed when the MCP integration is enabled. A whole address including `http://` or `https://`, with the path the server accepts flows on.",
    consumers: ["worker", "content"],
    wired: true,
  },
  {
    key: "mcpAutoSend",
    group: "mcp",
    tier: 1,
    type: "boolean",
    default: false,
    title: "Send automatically when a recording stops",
    description:
      "Off by default: it sends screenshots and captured request bodies to whatever address is configured, which should be a decision, not a surprise.",
    consequence:
      "On means every recording leaves the browser the moment you press Stop.",
    consequenceWhen: { is: true },
    consumers: ["worker"],
    wired: true,
  },
  {
    key: "mcp.port",
    group: "mcp",
    tier: 1,
    type: "number",
    default: MCP_PORT,
    min: 1024,
    max: 65_535,
    title: "MCP server port",
    description:
      "Already contested on some machines, and must match on both sides.",
    consequence:
      "Changing it here does not move a server that is already running, and both sides must agree or sends fail.",
    consumers: ["mcp"],
    machine: true,
    wired: true,
  },
  {
    key: "mcp.maxTokens",
    group: "mcp",
    tier: 1,
    type: "number",
    default: MCP_MAX_TOKENS,
    min: 1000,
    max: 1_000_000,
    unit: "tokens",
    title: "MCP response budget",
    description: "Depends entirely on the client’s own cap.",
    consequence:
      "One response is cut on a step boundary at this size and the rest is paged. Above your MCP client’s own cap the client cuts it instead — silently, mid-document — which is the failure this budget exists to prevent.",
    consequenceWhen: { above: 25_000 },
    consumers: ["mcp"],
    rendered: true,
    wired: true,
  },
  {
    key: "mcp.raw",
    group: "mcp",
    tier: 1,
    type: "boolean",
    default: MCP_RAW_DEFAULT,
    title: "Include step data by default",
    description:
      "A user who always wants the record should not pass a flag every time.",
    consequence:
      "Every get_flow response then carries the step JSON as well: roughly twice the tokens, for replay data that answers no question about what went wrong.",
    consequenceWhen: { is: true },
    consumers: ["mcp"],
    rendered: true,
    wired: true,
  },
  {
    key: "mcp.maxImages",
    group: "mcp",
    tier: 1,
    type: "number",
    default: MCP_MAX_IMAGES,
    min: 0,
    max: 50,
    title: "Screenshots per MCP call",
    description: "Vision-heavy workflows want more.",
    consequence:
      `At zero, get_flow_screenshots returns paths and no pictures. Each image is around ${VISION_TOKENS_PER_IMAGE.toLocaleString("en-US")} tokens of vision budget.`,
    consequenceWhen: { below: 1 },
    consumers: ["mcp"],
    rendered: true,
    wired: true,
  },
  {
    key: "mcp.bodyLimit",
    group: "mcp",
    tier: 1,
    type: "number",
    default: MCP_BODY_LIMIT,
    min: 0,
    max: 1024 * 1024,
    unit: "chars",
    title: "Body length in tool output",
    description: "Follows the budget.",
    consequence:
      "Bodies in the step JSON are cut to this. Below about 500 characters a stack trace loses the frames that name the cause.",
    consequenceWhen: { below: 500 },
    consumers: ["mcp"],
    rendered: true,
    wired: true,
  },
  {
    key: "mcp.maxResponseBody",
    group: "mcp",
    tier: 1,
    type: "number",
    default: MAX_RESPONSE_BODY,
    min: 0,
    max: 100_000,
    unit: "chars",
    title: "Walkthrough body cap",
    description: "The narrative’s density is a real preference.",
    consequence:
      "The walkthrough quotes this much of each response body. At zero it quotes none, and the cut is stated rather than silent — but a failed call then reads as one nobody looked at.",
    consequenceWhen: { below: 100 },
    consumers: ["ui", "mcp"],
    rendered: true,
    wired: true,
  },
  {
    key: "mcp.maxConsoleEntries",
    group: "mcp",
    tier: 1,
    type: "number",
    default: MAX_CONSOLE_ENTRIES,
    min: 0,
    max: 200,
    title: "Walkthrough console cap",
    description: "The narrative’s density is a real preference.",
    consequence:
      "At zero the walkthrough prints no console output, and a step whose only evidence is an error reads as a step that logged nothing.",
    consequenceWhen: { below: 1 },
    consumers: ["ui", "mcp"],
    rendered: true,
    wired: true,
  },
  {
    key: "mcp.maxFlows",
    group: "mcp",
    tier: 1,
    type: "number",
    default: MCP_MAX_FLOWS,
    min: 1,
    max: 100_000,
    unit: "flows",
    title: "Keep at most N flows",
    description:
      "A runaway guard on this machine’s ~/.devflow, not a retention policy — the shipped ceiling sits far above any plausible working set, because losing a recording somebody still wanted is the worse failure.",
    consequence:
      "Lowering it deletes: the sweep after the next send removes the oldest recordings from ~/.devflow until this many are left, and a recording that has been swept is gone from the disk the MCP server reads.",
    consequenceWhen: { below: MCP_MAX_FLOWS },
    consumers: ["mcp"],
    machine: true,
    wired: true,
  },
  {
    key: "mcp.maxFlowBytes",
    group: "mcp",
    tier: 1,
    type: "number",
    default: MCP_MAX_FLOW_BYTES,
    min: 64 * 1024 * 1024,
    max: 1024 * 1024 * 1024 * 1024,
    unit: "bytes",
    title: "Keep at most N GB",
    description:
      "The second ceiling, because the two fail differently: a few enormous flows blow the disk budget while the count still looks fine, and a great many tiny ones blow the count while the bytes do.",
    consequence:
      "Lowering it deletes, and this is the ceiling that bites first on a library of screenshot-heavy flows: the sweep after the next send removes the oldest recordings until the rest fit.",
    consequenceWhen: { below: MCP_MAX_FLOW_BYTES },
    consumers: ["mcp"],
    machine: true,
    wired: true,
  },
  {
    key: "mcp.sendTimeoutMs",
    group: "mcp",
    tier: 2,
    type: "number",
    default: SEND_TIMEOUT_MS,
    min: 500,
    max: 300_000,
    unit: "ms",
    title: "Send timeout",
    description:
      "How long to wait before calling a silent address unreachable.",
    consequence:
      "A long recording with screenshots legitimately takes seconds to send. Below about five, it is abandoned as unreachable while the server is still reading it.",
    consequenceWhen: { below: 5000 },
    consumers: ["ui", "worker"],
    wired: true,
  },
  {
    key: "mcp.healthTimeoutMs",
    group: "mcp",
    tier: 2,
    type: "number",
    default: HEALTH_TIMEOUT_MS,
    min: 500,
    max: 300_000,
    unit: "ms",
    title: "Health-check timeout",
    description:
      "How long to wait before calling a silent address unreachable.",
    consequence:
      "Test connection calls a working server unreachable if it answers slower than this.",
    consequenceWhen: { below: 1000 },
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "mcp.remoteTimeoutMs",
    group: "mcp",
    tier: 2,
    type: "number",
    default: REMOTE_TIMEOUT_MS,
    min: 500,
    max: 300_000,
    unit: "ms",
    title: "Remote-delete timeout",
    description:
      "How long to wait before calling a silent address unreachable.",
    consequence:
      "A delete that times out leaves the recording on the server: the row disappears from the library and Claude still lists it.",
    consequenceWhen: { below: 1000 },
    consumers: ["ui"],
    wired: true,
  },

  // ── Thumbnails ─────────────────────────────────────────────────────────────
  {
    key: "thumbnails.width",
    group: "thumbnails",
    tier: 2,
    type: "number",
    default: THUMBNAIL_WIDTH,
    min: 16,
    max: 1024,
    unit: "px",
    title: "Thumbnail width",
    description: "Matches the library row, at 2× for a HiDPI screen.",
    consequence:
      "The library row is 128×80 CSS pixels. Smaller is upscaled and blurred; much larger grows every index entry for pixels the row never shows.",
    consequenceWhen: { below: THUMBNAIL_WIDTH, above: 256 },
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "thumbnails.height",
    group: "thumbnails",
    tier: 2,
    type: "number",
    default: THUMBNAIL_HEIGHT,
    min: 16,
    max: 1024,
    unit: "px",
    title: "Thumbnail height",
    description: "Matches the library row, at 2× for a HiDPI screen.",
    consequence:
      "The library row is 128×80 CSS pixels. Smaller is upscaled and blurred; much larger grows every index entry for pixels the row never shows.",
    consequenceWhen: { below: THUMBNAIL_HEIGHT, above: 160 },
    consumers: ["ui"],
    wired: true,
  },
  {
    key: "thumbnails.quality",
    group: "thumbnails",
    tier: 2,
    type: "number",
    default: THUMBNAIL_QUALITY,
    min: 0.05,
    max: 1,
    fractional: true,
    title: "Thumbnail quality",
    description:
      "Well under a kilobyte at this size, and it is never looked at closely.",
    consequence:
      "Below about 0.2 the tile is visibly blocky. Above 0.8 the index entry grows several times over, for a picture 128 pixels wide.",
    consequenceWhen: { below: 0.2, above: 0.8 },
    consumers: ["ui"],
    wired: true,
  },

  // ── Interface ──────────────────────────────────────────────────────────────
  {
    key: "ui.launcherTimeoutMs",
    group: "ui",
    tier: 2,
    type: "number",
    default: LAUNCHER_TAB_TIMEOUT_MS,
    min: 1000,
    max: 300_000,
    unit: "ms",
    title: "Editor launch tab timeout",
    description:
      "Opening a source link uses a blank tab to hand off to the editor. Chrome losing focus closes it; this is the backstop for a launch that never happened.",
    consequence:
      "Below a few seconds the tab closes while Chrome’s “open this application?” prompt is still on screen, taking the prompt with it.",
    consequenceWhen: { below: 5000 },
    consumers: ["worker"],
    wired: true,
  },
  {
    key: "ui.errorTtlMs",
    group: "ui",
    tier: 2,
    type: "number",
    default: ERROR_TTL_MS,
    min: 0,
    max: 24 * 60 * 60 * 1000,
    unit: "ms",
    title: "How recent a failure has to be to interrupt",
    description:
      "An hour-old capture error is noise; one from thirty seconds ago is the reason the user just opened the popup.",
    consequence:
      "At zero the popup never mentions a failed capture, so a recording that lost its screenshots looks like one that went fine.",
    consequenceWhen: { below: 1 },
    consumers: ["ui"],
    wired: true,
  },
] as const satisfies readonly Field[];

// ── The type, derived ────────────────────────────────────────────────────────

type Entry = (typeof FIELDS)[number];

/**
 * The value a field holds, widened out of the literal `as const` gave it.
 *
 * Without this, `recording.maxSteps` would be typed `500` rather than `number`
 * and assigning 400 to it would not compile. Enums keep their union, because
 * that is exactly the narrowing worth having — `theme` is `'system' | 'light' |
 * 'dark'` and nothing else.
 */
type ValueOf<F> = F extends { type: "boolean" }
  ? boolean
  : F extends { type: "number" }
    ? number
    : F extends { type: "enum"; options: readonly (infer O)[] }
      ? O
      : F extends { type: "levels"; options: readonly (infer O)[] }
        ? O[]
        : F extends { type: "string" }
          ? string
          : never;

/**
 * Every setting, resolved. Derived from `FIELDS`, never written by hand — a key
 * that is not in the table cannot be in the type, which is what makes "every key
 * exists exactly once" a compile error rather than a review comment.
 */
export type Settings = { [F in Entry as F["key"]]: ValueOf<F> };

/**
 * A sparse set of overrides: flat dotted keys, only what the user changed.
 *
 * Declared in `shared/types.ts` and re-exported here, because it is a stored
 * and sent shape as much as a settings one — the sync area, a recording's
 * frozen snapshot and `FlowPayload.settings` are all one of these.
 */
export type { Overrides } from "../../shared/types.js";

export type SettingKey = keyof Settings;

// ── Derived tables ───────────────────────────────────────────────────────────

/**
 * Every default, exactly as the code ships today.
 *
 * Built from `FIELDS` rather than declared, so it cannot list a key the table
 * does not have or miss one it does. This is the object `resolve` falls back to,
 * the object `public/settings.default.json` is generated from, and the object
 * `tests/settings-defaults.test.ts` compares against `shared/constants.ts`.
 */
export const DEFAULTS: Settings = Object.freeze(
  Object.fromEntries(
    FIELDS.map((field) => [field.key, freezeValue(field.default)]),
  ),
) as Settings;

/** Arrays in `DEFAULTS` are frozen too, or a consumer could mutate the default. */
function freezeValue(value: unknown): unknown {
  return Array.isArray(value) ? Object.freeze([...value]) : value;
}

const BY_KEY = new Map<string, Field>(
  FIELDS.map((field) => [field.key, field]),
);

/** The field a key names, or `undefined` for a key from a newer version. */
export function fieldFor(key: string): Field | undefined {
  return BY_KEY.get(key);
}

export function isSettingKey(key: string): key is SettingKey {
  return BY_KEY.has(key);
}

/** Fields in one group, in table order — the order the screen renders them. */
export function fieldsInGroup(group: Group): readonly Field[] {
  return FIELDS.filter((field) => field.group === group);
}

// ── The component-tree filter, derived ───────────────────────────────────────

/**
 * The prefix the component-tree filter's five keys share.
 *
 * A storage prefix and not a word the product says — see docs/CONTRACTS.md §4.5.
 * Flat dotted keys rather than one nested `hidden` object because a nested value
 * cannot be partially overridden, and a sparse store that could only hold all
 * five or none of them would write four defaults into every profile the moment
 * somebody changed the fifth.
 */
export const HIDDEN_KEY_PREFIX = "locator.hidden.";

/**
 * The categories a component tree can suppress, in table order.
 *
 * Derived from `FIELDS` rather than imported from `core/react/classify.ts`, and
 * that is the direction the dependency has to run: the settings table is the one
 * place a setting exists, so the list of categories that *have* a setting is a
 * fact about this table. A category added to the classifier and not to the table
 * is a category nothing can hide, and this list says so by not containing it.
 */
export const HIDDEN_CATEGORIES: readonly string[] = FIELDS.filter((field) =>
  field.key.startsWith(HIDDEN_KEY_PREFIX),
).map((field) => field.key.slice(HIDDEN_KEY_PREFIX.length));

/** The key a category's toggle is stored under, or `undefined` if it has none. */
export function hiddenKeyFor(category: string): SettingKey | undefined {
  const key = `${HIDDEN_KEY_PREFIX}${category}`;
  return isSettingKey(key) ? key : undefined;
}

// ── Concepts ─────────────────────────────────────────────────────────────────

/**
 * The four things this product is configured *about*.
 *
 * Settings are grouped by concept, not by origin. Half of the table came from a
 * recorder and half from a tool that finds the file a component was written in,
 * and a rail with a "Recording" section and a section that is recognisably the
 * other half's would tell the user they are holding two products in one window.
 * They are not: the project root and the chosen editor already served both, and
 * the source resolution a recording does in the background is the same work one
 * interactive pick does in the foreground.
 *
 * So the concept is the top level and `Group` is the level under it. A concept
 * is not a second grouping of settings — every group belongs to exactly one, and
 * `tests/settings-groups.test.ts` holds that the partition is total — it is the
 * word the rail puts above a run of groups so that "where would I look for this"
 * has four answers instead of eleven.
 */
export type Concept = "source" | "recording" | "handover" | "appearance";

/** The four, in the order the rail reads them. */
export const CONCEPTS = [
  { id: "source", title: "React & source resolution" },
  { id: "recording", title: "Recording" },
  { id: "handover", title: "Export & MCP" },
  { id: "appearance", title: "Appearance" },
] as const satisfies readonly { id: Concept; title: string }[];

export type ConceptInfo = (typeof CONCEPTS)[number];

const BY_CONCEPT = new Map<Concept, ConceptInfo>(
  CONCEPTS.map((concept) => [concept.id, concept]),
);

/** A concept's title. Total: `Concept` is the union of `CONCEPTS` ids. */
export function conceptInfo(concept: Concept): ConceptInfo {
  const found = BY_CONCEPT.get(concept);
  // Unreachable while `CONCEPTS` satisfies the union — the same guarantee, and
  // the same reason, as `groupInfo` below.
  if (!found) throw new Error(`DevFlow: no such settings concept: ${concept}`);
  return found;
}

// ── Groups ───────────────────────────────────────────────────────────────────

/**
 * The category rail, in the order the page renders it.
 *
 * The screen was specified as "seven entries, always visible", named from an earlier
 * grouping; the table below has twelve, because that is what `FIELDS` actually
 * came out as. The rail is built from this list rather than from a number in
 * the plan, so it cannot describe a set of groups the settings are not in.
 *
 * Twelve groups under four concepts, and the twelve are kept rather than
 * collapsed into the four: "Screenshots", "Network" and "Console" are each a
 * real subject with its own paragraph, and merging them would throw away three
 * headings and three paragraphs to buy a shorter list. The concept is what the
 * user navigates by; the group is what they land in.
 *
 * The paragraph is the group's own writing — each group opens with one
 * — and it lives here for the same reason every other sentence on the screen
 * does: the screen has no copy of its own.
 */
export const GROUPS = [
  {
    id: "react",
    concept: "source",
    title: "React & source resolution",
    description:
      "On a React page a component can be traced back to the file it was written in — for every step of a recording, and for any one component picked out of the page. These decide how far that goes, where the files are, and what the component trees leave out.",
  },
  {
    id: "vue",
    concept: "source",
    title: "Vue",
    description:
      "A Vue page in development says outright which component drew an element. A production build deletes that, and the only way left to the answer is to search the whole component tree from the top on every click. This decides how far that search is allowed to go.",
  },
  {
    id: "recording",
    concept: "recording",
    title: "Recording",
    description:
      "What ends a recording, and how much of what happened is treated as one step.",
  },
  {
    id: "screenshots",
    concept: "recording",
    title: "Screenshots",
    description:
      "Every step carries a picture. These decide how good it is and how long DevFlow waits for the page to settle before taking it.",
  },
  {
    id: "network",
    concept: "recording",
    title: "Network",
    description:
      "Request and response bodies are the most useful thing in a flow and the most likely to hold something private. Headers are always stripped.",
  },
  {
    id: "console",
    concept: "recording",
    title: "Console",
    description:
      "Which console output is kept beside the step that produced it.",
  },
  {
    id: "annotation",
    concept: "recording",
    title: "Annotation",
    description: "The boxes and arrows drawn on a screenshot in the viewer.",
  },
  {
    id: "thumbnails",
    concept: "recording",
    title: "Thumbnails",
    description: "The small images the library lists a flow by.",
  },
  {
    id: "export",
    concept: "handover",
    title: "Handing over",
    description:
      "What an export or a send includes before anybody touches a checkbox. These are the defaults the dialogs open on, not a ceiling.",
  },
  {
    id: "mcp",
    concept: "handover",
    title: "Claude and MCP",
    description:
      "Where recorded flows go when you send them to the local MCP server.",
  },
  {
    id: "appearance",
    concept: "appearance",
    title: "Appearance",
    description: "Applies to the popup and the flow viewer.",
  },
  {
    id: "ui",
    concept: "appearance",
    title: "Interface",
    description: "Small behaviours of the popup and the viewer.",
  },
] as const satisfies readonly {
  id: Group;
  concept: Concept;
  title: string;
  description: string;
}[];

export type GroupInfo = (typeof GROUPS)[number];

const BY_GROUP = new Map<Group, GroupInfo>(
  GROUPS.map((group) => [group.id, group]),
);

/** A group's title and paragraph. Total: `Group` is the union of `GROUPS` ids. */
export function groupInfo(group: Group): GroupInfo {
  const found = BY_GROUP.get(group);
  // Unreachable while `GROUPS` satisfies the union — the cast in the map's key
  // type is what makes that a compile error rather than a blank heading.
  if (!found) throw new Error(`DevFlow: no such settings group: ${group}`);
  return found;
}

/**
 * Whether a field's `consequence` is true of `value`.
 *
 * `modified` carries the fallback rule described on `ConsequenceWhen`: a
 * consequence with no explicit range is shown only once the user has moved the
 * setting off its default.
 */
export function consequenceApplies(
  field: Field,
  value: unknown,
  modified: boolean,
): boolean {
  if (!field.consequence) return false;

  const when = field.consequenceWhen;
  if (!when) return modified;

  if (when.is !== undefined) return value === when.is;
  if (typeof value !== "number") return false;
  if (when.below !== undefined && value < when.below) return true;
  if (when.above !== undefined && value > when.above) return true;
  return false;
}

/** The settings the extension actually reads today — see `Common.wired`. */
export const WIRED: readonly Field[] = (FIELDS as readonly Field[]).filter(
  (field) => field.wired === true,
);

// ── The recording snapshot, derived ──────────────────────────────────────────

/**
 * The keys `START_RECORDING` freezes — see `Common.recorded`.
 *
 * A union rather than a `string[]`, so `RecordingSettings` below can be a
 * `Pick` of `Settings`: a consumer holding the frozen object cannot read
 * `theme` off it and silently get the default, because the field is not on the
 * type. That is the same class of failure `settings-module-scope.test.ts`
 * guards, caught by the compiler instead.
 */
export type RecordedKey = Extract<Entry, { recorded: true }>["key"];

/** The keys stamped at hand-over rather than at capture — see `Common.rendered`. */
export type RenderedKey = Extract<Entry, { rendered: true }>["key"];

/**
 * The settings a recording is frozen at, resolved.
 *
 * Deliberately not `Settings`. The frozen object is a description of one
 * recording, and the settings that are *not* in it — the theme, the editor, the
 * MCP address — are still live and must be read from `load()`. A `Pick` is what
 * stops the two being confused at a call site.
 */
export type RecordingSettings = Pick<Settings, RecordedKey>;

/** The settings a payload is rendered under, resolved. */
export type RenderSettings = Pick<Settings, RenderedKey>;

/**
 * `recorded` and `wired` are independent, and two entries prove it.
 *
 * `console.logArgCap` and `console.stackFrames` are Tier 2 and not on screen
 * yet, but they are pushed to the MAIN-world agent in the same message as the
 * console levels — so they are in the snapshot the message is built from, or
 * the agent would be told a frozen cap and a live one in the same object.
 * Nobody can change them, so they never appear in a stamp; when Phase 6 draws
 * them, the freeze is already correct and there is nothing to remember.
 */
export const RECORDED: readonly Field[] = (FIELDS as readonly Field[]).filter(
  (field) => field.recorded === true,
);

export const RENDERED: readonly Field[] = (FIELDS as readonly Field[]).filter(
  (field) => field.rendered === true,
);

/**
 * Every key that appears in a flow's `settings` stamp, in table order.
 *
 * The order is the table's, not the object's, so two flows recorded under the
 * same overrides print the same header regardless of the order the user
 * happened to change them in.
 */
export const STAMPED: readonly Field[] = (FIELDS as readonly Field[]).filter(
  (field) => field.recorded === true || field.rendered === true,
);

/** Whether `key` is one of the keys a recording freezes. */
export function isRecordedKey(key: string): key is RecordedKey {
  return fieldFor(key)?.recorded === true;
}

/** Whether `key` is one of the keys a hand-over stamps. */
export function isRenderedKey(key: string): key is RenderedKey {
  return fieldFor(key)?.rendered === true;
}

// ── The machine-wide half, derived ───────────────────────────────────────────

/** The keys that reach the server through `POST /config` — see `Common.machine`. */
export type MachineKey = Extract<Entry, { machine: true }>["key"];

/** What `~/.devflow/config.json` is allowed to decide. */
export type MachineSettings = Pick<Settings, MachineKey>;

/**
 * The machine-wide fields, in table order.
 *
 * The order matters for the same reason the stamp's does: this list is what the
 * endpoint's allow-list and the Settings screen's push are both built from, and
 * two lists that could disagree is the failure the whole table exists against.
 */
export const MACHINE: readonly Field[] = (FIELDS as readonly Field[]).filter(
  (field) => field.machine === true,
);

/** The same list as plain keys — what `mcp-server/server.js` filters a body by. */
export const MACHINE_KEYS: readonly string[] = MACHINE.map(
  (field) => field.key,
);

export function isMachineKey(key: string): key is MachineKey {
  return fieldFor(key)?.machine === true;
}

/**
 * The machine-wide half of a sparse override object.
 *
 * Sparse in, sparse out. `POST /config` sends the *overrides* rather than the
 * resolved values, because `config.json` is the settings file and the same
 * rule holds on disk as in storage: a file that materialises a default freezes
 * today's number into the installation forever, and the day the shipped default
 * improves nobody who never touched it gets the improvement.
 *
 * A key the user has reset is therefore absent, which is what tells the server
 * to drop it from the file rather than keep the last value it was sent.
 */
export function machineOverrides(overrides: Overrides): Overrides {
  const out: Record<string, unknown> = {};
  for (const field of MACHINE) {
    if (Object.hasOwn(overrides, field.key)) {
      out[field.key] = (overrides as Record<string, unknown>)[field.key];
    }
  }
  return out;
}
