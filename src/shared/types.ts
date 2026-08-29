/**
 * DevFlow's data model — one recording, one pick, one vocabulary.
 *
 * These shapes are persisted in `chrome.storage.local` and written to disk by the
 * MCP server, so they are a compatibility surface: existing recordings must keep
 * loading. Fields are optional here where the pre-TypeScript code left them
 * optional in practice, not because the model is loose.
 *
 * The file carries both halves of the merge deliberately. A recorded step and an
 * interactive pick end at the same place — `ComponentSource`, "where this
 * component was written" — and the shared result card (built once, in W1·D) takes
 * that one shape from all three surfaces. Two structurally identical types with
 * different field names is precisely how a merged product goes on reading as two
 * products, so there is one, and `LocateResult` carries it rather than
 * re-describing it.
 *
 * **Positions are typed, not documented.** `ComponentSource.line` is `Pos1` and
 * `ComponentSource.compiled.line` is `Pos0`; see `core/react/positions.ts` for
 * why a `base: 0 | 1` parameter was rejected. Reading either back out of storage
 * or off the wire is an assertion (`pos1(raw.line)`) at exactly one edge.
 */

import type { Pos0, Pos1 } from '../core/react/positions.js';

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** What was interacted with, described every way we know how to describe it. */
export interface ElementRef {
  tag: string;
  /** Visible text, capped at 80 chars. */
  text?: string | null;
  /** Best human label: `<label>`, placeholder, aria-label, or falling back to text. */
  label?: string | null;
  role?: string | null;
  type?: string | null;
  /** Stable-first selector: id > data-testid > aria-label > CSS path. */
  cssSelector: string;
  xpath: string;
  boundingBox: BoundingBox | null;
  ariaLabel?: string | null;
  /** The React components this element sits inside, when the page is React. */
  react?: ElementReactRef;
}

/**
 * Component *ids*, not paths.
 *
 * A path repeated across forty steps is pure token waste, and at the moment a
 * step is written the resolution that would produce it has not happened yet.
 * The ids index `FlowReact.components`, which is filled in asynchronously and
 * merged at export time.
 */
export interface ElementReactRef {
  /** Component ids, outermost first. */
  chain: string[];
  /** The walk hit its cap, so `chain[0]` is not the root component. */
  truncated?: boolean;
  /**
   * Which of the chain the flow attributes this step to.
   *
   * Decided once, when the flow is frozen for export, and written down so that
   * every reader of it — this extension, the MCP server, anything downstream —
   * names the same component. The rule that picks it is four preference tiers
   * deep (`core/react/owner.ts`); re-deriving it in each reader is how two
   * halves of one document end up disagreeing about which button was clicked.
   */
  owner?: string;
  /**
   * The nearest component *outside* `owner` that is the app's own feature code.
   *
   * Present only when it adds something the owner does not. On an app with a
   * shared UI kit the owner is often `Button`, correctly — the click did land
   * there — and this is the `CheckoutButton` that rendered it, which is what
   * makes the step legible. Stamped beside `owner`, by the same rule, at the
   * same moment. See `core/react/owner.ts`.
   */
  within?: string;
}

/** Why a component's source is not a resolved original file. */
export type ComponentStatus =
  | 'resolved'
  | 'compiled-only'
  | 'ambiguous'
  | 'not-found'
  | 'no-map'
  | 'map-error'
  | 'unfetchable'
  | 'skipped'
  | 'pending';

/**
 * Where one React component was written.
 *
 * Every outcome that is not `resolved` carries a `detail` sentence. A flow that
 * silently omits a path reads as "this component has no source"; one that says
 * *the component is in a lazy chunk that was never loaded* tells whoever reads
 * it what to do instead. Both this extension and its sibling hold that line.
 */
export interface ComponentSource {
  /** displayName at capture time — minified on a production build, which is fine. */
  name: string;
  status: ComponentStatus;
  via?: 'debug-source' | 'bundle-search';
  /** Normalised, repo-relative where possible: `src/components/Cart.tsx`. */
  source?: string;
  /**
   * 1-based, for humans and editors — source maps are 0-based, converted once,
   * at the source-map edge in `lookupOriginal`. The brand is what stops the
   * conversion happening twice, or not at all.
   */
  line?: Pos1;
  column?: Pos1;
  /** Kept verbatim when the source map recorded an absolute local path. */
  absolutePath?: string;
  /** The resolved path is inside node_modules, so this is not the user's code. */
  dependency?: boolean;
  /**
   * Position in the served bundle. Present whenever a bundle match was made.
   *
   * 0-based, and stays that way: this is a position in a minified file that
   * DevTools' own Sources panel is asked to open, and its API is 0-based too.
   * Nothing shows this number to a person without converting it first.
   */
  compiled?: { url: string; line: Pos0; column: Pos0 };
  /** Distinct places the needle matched. Above 1 the path may be the wrong one. */
  matchCount?: number;
  /** One sentence, whenever `status` is not `resolved`. */
  detail?: string;
}

/** React facts about the page a flow was recorded on. */
export interface FlowReact {
  detected: boolean;
  version?: string;
  build?: 'development' | 'production' | 'unknown';
  /** Keyed by component id, as referenced by `ElementReactRef.chain`. */
  components: Record<string, ComponentSource>;
}

/**
 * One request the page made, as the agent saw it.
 *
 * Bodies are captured up to `BODY_CAP` and the fact that the cap bit is carried
 * *beside* the body, never inside it. The marker used to be appended to the
 * string — `…[truncated — 307200b total]` — which made a truncated JSON body
 * unparseable, so `compactBody` saw a leading `{`, threw on `JSON.parse`, and
 * exported a 300KB JSON API response as `[non-JSON · 50.0KB · truncated]` plus
 * 300 characters. The schema inference that exists precisely for large bodies
 * never ran on a single large body.
 *
 * Every truncation field is optional: a flow recorded before they existed has
 * none, which reads as "not truncated" — the same thing it meant then.
 */
export interface NetworkCall {
  method: string;
  url: string;
  requestHeaders: Record<string, string>;
  requestBody: string | null;
  /** The request body was cut at the capture cap. */
  requestBodyTruncated?: boolean;
  /** Length of the whole request body, in characters, before the cut. */
  requestBodyBytes?: number;
  /** `null` when the request failed before a response. */
  status: number | null;
  responseHeaders: Record<string, string>;
  responseBody: string | null;
  /** The response body was cut at the capture cap. */
  responseBodyTruncated?: boolean;
  /** Length of the whole response body, in characters, before the cut. */
  responseBodyBytes?: number;
  durationMs: number;
  timestamp: number;
}

export type ConsoleLevel = 'log' | 'warn' | 'error' | 'info' | 'debug';

export interface ConsoleEntry {
  level: ConsoleLevel;
  args: string[];
  timestamp: number;
}

export type StepType = 'click' | 'input' | 'navigate' | 'note';

/**
 * A sparse set of settings overrides: flat dotted keys, only what was changed.
 *
 * Declared here rather than in `features/settings/fields.ts` — which re-exports
 * it — because it is a *stored* and *sent* shape before it is a settings shape:
 * it is what `chrome.storage.sync` holds, what a recording freezes in
 * `chrome.storage.local`, and what travels on `FlowPayload.settings` to a
 * separate process that has no settings table of its own.
 *
 * `unknown`, not a union of the value types, on purpose: a key from a newer
 * FlowSnap can hold anything at all, and `resolve()` is the only thing allowed
 * to decide what it means.
 */
export type Overrides = Readonly<Record<string, unknown>>;

/**
 * Fields every step carries. `element` and `value` sit here rather than on the
 * variants because the viewer renders steps generically; the variants below
 * still require whichever of them they cannot exist without.
 */
interface StepBase {
  url: string;
  timestamp: number;
  /** Human-readable sentence: `Clicked "Save"`, `Typed "ada@" into Email`. */
  action: string;
  /** Assigned at capture time. Stale after a deletion — see `renumber()`. */
  stepNumber?: number;
  /** Annotated JPEG data URL, or null when capture failed or was skipped. */
  screenshot?: string | null;
  /** Un-annotated original, kept so the image editor has a clean base. */
  screenshotOriginal?: string | null;
  /**
   * Set when the user supplied this image themselves instead of the recorder
   * capturing it — a modal that was gone by the time the shutter fired, a
   * moment the settle delay missed.
   *
   * It exists because everything downstream reads a screenshot as evidence of
   * what the page looked like at that instant. For an imported image that is a
   * claim nobody checked, and the exports and the card say so rather than
   * letting it pass as a capture. Absent means captured, so older flows load
   * unchanged.
   */
  screenshotImported?: boolean;
  /**
   * Why this step has no image, in the words a reader needs.
   *
   * Nothing in Tier 1 may make a recording silently worse. A step with no
   * screenshot because the user turned screenshots off looks exactly like a
   * step whose capture failed, which looks exactly like a page that rendered
   * nothing — and a reader with no way to tell picks the worst of the three.
   * So the step says which it was, and the exports print it where the image
   * would have been.
   *
   * Set for a capture that failed as well as for one that was never attempted:
   * the failure was already invisible in the flow, and only visible in the
   * popup's error strip minutes before anybody read the recording.
   *
   * Absent means the step has an image, or is a kind of step that never has one
   * — the trailing note deliberately carries no picture and says so in its own
   * text.
   */
  screenshotOmitted?: string;
  highlightBox?: BoundingBox | null;
  dpr?: number;
  title?: string;
  notes?: string;
  value?: string;
  element?: ElementRef;
  consoleLogs?: ConsoleEntry[];
  networkCalls?: NetworkCall[];
  /**
   * What the region around the touched element said before the interaction and
   * shortly after it — the cheap half of what a screenshot tells a human.
   *
   * *The button said "Add to cart" and then "Processing…", and an error banner
   * appeared* is roughly fifty tokens. Learning the same thing from the image
   * costs about fifteen hundred, and only a reader that can see images at all.
   * Present only when the text actually changed: a step where nothing visibly
   * happened has nothing to say, and saying it anyway on every step is how a
   * useful field becomes noise.
   */
  domDelta?: { before: string; after: string };
}

export interface ClickStep extends StepBase {
  type: 'click';
  element: ElementRef;
}

export interface InputStep extends StepBase {
  type: 'input';
  element: ElementRef;
  value: string;
}

export interface NavigateStep extends StepBase {
  type: 'navigate';
  title: string;
}

/** Synthesised by the recorder, e.g. when the step limit is reached. */
export interface NoteStep extends StepBase {
  type: 'note';
  value: string;
}

export type Step = ClickStep | InputStep | NavigateStep | NoteStep;

/** A step being built by the content script, before the worker attaches an image. */
export type DraftStep = Omit<Step, 'stepNumber' | 'screenshot' | 'screenshotOriginal'>;

/**
 * Metadata for one archived flow, listed without loading its steps.
 *
 * Everything below `stepCount` is optional and derived at save time. The library
 * needs a host, a size and a sense of what is in a flow to be worth looking at,
 * and loading every flow's steps to find out would defeat the point of an index —
 * a 10-flow library would decode a hundred screenshots to draw a list. Optional
 * because flows saved by an earlier build do not have them, and a list that
 * refuses to render an old flow is worse than one that shows it plainly.
 */
export interface FlowMeta {
  id: string;
  name: string;
  createdAt: number;
  stepCount: number;
  /** Host of the first URL in the flow. */
  host?: string;
  /** Approximate bytes the flow occupies in storage. */
  bytes?: number;
  /** A small JPEG of the first screenshot, for the list row. */
  thumbnail?: string | null;
  /** How many steps of each type, for the list row's chips. */
  counts?: Partial<Record<StepType, number>>;
  /**
   * Steps carrying a console error or a 4xx/5xx response.
   *
   * Misnamed: it counts *steps*, not failures. `failureCount` was added beside
   * it rather than renaming this, because the name is written into every
   * `meta.json` already on disk and a rename would orphan them. Fold the two
   * together the next time the schema version is bumped for some other reason —
   * not on its own account, which would be a migration bought for a word.
   */
  errorCount?: number;
  /**
   * The settings this flow was recorded under, sparse — see
   * `features/settings/recording.ts`.
   *
   * In the index rather than beside the steps because it is what the library
   * row and the export both need before opening anything, and because it is
   * empty for almost every flow: a recording made at the defaults stamps `{}`,
   * which costs two characters.
   *
   * Absent on a flow archived before this existed, which reads correctly as
   * "the defaults of the build that made it".
   */
  settings?: Overrides;
}

/**
 * The payload POSTed to the MCP server.
 *
 * A wire contract, not an internal shape: the server is published to npm on its
 * own and updated by `npx`, so a user can be running any server version against
 * any extension version. `schemaVersion` is what lets the receiving end tell
 * which one it is looking at.
 */
export interface FlowPayload {
  schemaVersion: number;
  id: string;
  name: string;
  timestamp: number;
  startUrl?: string;
  steps: Step[];
  /**
   * Absent entirely when the page was not React. Additive, so this is not a
   * `schemaVersion` bump — a server that predates it ignores what it does not
   * know, which is exactly what the version field exists to allow.
   */
  react?: FlowReact;
  /**
   * Which sections the sender deliberately left out.
   *
   * Absence of data and absence of failures look identical on the receiving
   * side: a flow sent without its network calls has nothing for the server to
   * count, so it reported "no step failed" for a recording made to capture a
   * 500. This is what lets the server say "you did not send that" instead of
   * answering a debugging question with a confident wrong answer.
   */
  omitted?: string[];
  /**
   * The settings the flow was made under, sparse and flat-dotted.
   *
   * This is the single most important part of making FlowSnap configurable: a
   * flow recorded at quality 20 with bodies off is indistinguishable from a
   * flow where capture failed, and a reader with no way to tell concludes the
   * latter. With it, the walkthrough opens by saying what was in force.
   *
   * Overrides only, never the resolved object — for the same reason storage
   * holds overrides: a flow recorded at today's defaults should read as
   * "defaults", not as sixteen numbers that happen to match, and a default
   * improved in a later version should not be frozen into every flow ever
   * recorded.
   *
   * Two kinds of entry, in one object because they are one claim about the
   * document in hand: what was frozen when the recording started, and what was
   * in force when this payload was built. `Common.recorded` and
   * `Common.rendered` in `features/settings/fields.ts` say which is which.
   *
   * Additive, like `react` and `omitted`: a server that predates it ignores it.
   */
  settings?: Overrides;
}

/** Which parts of a flow an export includes. */
export interface ExportOptions {
  images: boolean;
  network: boolean;
  logs: boolean;
  /**
   * Whether the flow carries which React component each step happened in, and
   * the file it was written in.
   *
   * On by default, like every other part of a recording: a flow that names the
   * component behind a click is the difference between an assistant opening one
   * file and searching a repository, and it is the cheapest text in the
   * payload — ids on the steps and one table at the end, not a path per step.
   *
   * Off strips both halves — the per-step ids and the component table — and
   * nothing else. `Settings → React` decides whether the data is *captured* at
   * all; this decides whether what was captured leaves the machine, which is
   * the same split screenshots have had since exports existed.
   *
   * Missing on an options object stored by a build that predates it, which is
   * why every read spreads it over a default rather than trusting the shape.
   */
  react: boolean;
}

export type RecordingState = 'idle' | 'recording' | 'paused';

/** Everything the extension persists in `chrome.storage.local`. */
export interface LocalStorageShape {
  recordingActive: boolean;
  recordingPaused: boolean;
  /**
   * When the live recording began, for the popup's elapsed timer. `null` when
   * nothing is recording — and possibly absent on a flow recorded by an older
   * build, which the timer treats as "unknown" rather than "zero".
   */
  recordingStartedAt: number | null;
  recordedSteps: Step[];
  exportOptions: ExportOptions;
  /**
   * Which parts of a flow the "Send to Claude" dialog hands over. Kept apart
   * from `exportOptions` because the two answers differ: a ZIP on disk costs
   * nothing to over-pack, and a flow in a model's context costs tokens.
   */
  sendOptions: ExportOptions;
  /**
   * What `export.*` said when the memory above was written.
   *
   * The dialog's memory and the configured default are two different things and
   * both are relied on — see `features/export/defaults.ts`. Deciding which is
   * the more recent statement of intent needs to know what the default *was*
   * when the memory was made, and this is that. Absent on a machine whose
   * memory predates Phase 4, which reads correctly as "nothing was recorded".
   */
  exportOptionsAgainst: ExportOptions;
  sendOptionsAgainst: ExportOptions;
  savedFlowsMeta: FlowMeta[];
  lastMcpFlowId: string;
  /**
   * Resolved (or pending) component sources for the live recording.
   *
   * Its own key rather than a field on the steps, because `recordedSteps` is
   * rewritten wholesale by every capture while this is written by the resolver:
   * one key with two writers loses updates. Merged into the flow at export time
   * and pruned to the ids the surviving steps still reference.
   */
  reactComponents: Record<string, ComponentSource>;
  /** React facts about the page, minus the component table. */
  reactMeta: Omit<FlowReact, 'components'> | null;
  /**
   * Search needles for components still awaiting resolution.
   *
   * Deliberately a separate key from `reactComponents`: a needle is 200
   * characters of the site's own compiled source and is an input to resolution,
   * never part of a flow. Keeping it in a key that is never merged into a
   * payload is what makes "needles never ship" structural rather than a rule
   * somebody has to remember.
   */
  reactNeedles: Record<string, ComponentNeedle>;
  /**
   * Script URLs seen on each page of the recording, keyed by document URL.
   *
   * Persisted rather than held in the worker, because the worker is killed
   * whenever Chrome feels like it and a needle captured on page A must still be
   * searched against page A's bundles afterwards. A flow that crosses pages has
   * a different set per page, so this is not one flat list.
   */
  reactScripts: Record<string, string[]>;
  /** The most recent failure, so the UI can show what went wrong. */
  lastError: StoredError | null;
  /**
   * The settings the live recording was started under, sparse.
   *
   * Settings are frozen for the duration of a recording. This key is the
   * freeze — written in the same batch as `recordingActive: true`, read by the
   * worker and the content script instead of `load()` for anything that shapes
   * what is captured, and copied onto the flow as its stamp. See
   * `features/settings/recording.ts`, which owns every read and write of it.
   */
  recordingSettings: Overrides;
}

/**
 * What the resolver needs to find one component in the page's bundles, captured
 * at click time because the page may be gone by the time it is searched.
 */
export interface ComponentNeedle {
  head: string;
  body?: string;
  bodyOffset?: number;
  /** The page the component was seen on — its bundles are the ones to search. */
  pageUrl: string;
  /**
   * How many of that page's scripts this component has already been searched
   * against, when a search came back empty.
   *
   * A lazy chunk can load minutes after the click that wanted it, so "not found"
   * is worth revisiting — but only once there is somewhere new to look. Without
   * this, every resolver pass would rescan every bundle for every component it
   * has already failed to find.
   */
  searched?: number;
}

/** A FlowError plus when it happened, as persisted for the UI to read. */
export interface StoredError {
  code: string;
  message: string;
  detail?: string;
  at: number;
}

/** Archived flows are stored one key per flow, keyed by this. */
export function savedFlowKey(id: string): `savedFlow_${string}` {
  return `savedFlow_${id}`;
}

/**
 * An archived flow's React components, one key per flow.
 *
 * Separate from the steps because it is written by a different thing at a
 * different time — and because a flow archived before this existed simply has
 * no such key, which reads as "no components" rather than as a broken record.
 */
export function savedFlowReactKey(id: string): `savedFlowReact_${string}` {
  return `savedFlowReact_${id}`;
}

/**
 * Which palette to render. `system` is the default and stamps nothing on the
 * document, so `prefers-color-scheme` decides — see src/ui/styles/tokens.css.
 */
export type ThemePreference = 'system' | 'light' | 'dark';

/** Everything the extension persists in `chrome.storage.sync`. */
export interface SyncStorageShape {
  theme: ThemePreference;
  mcpServerUrl: string;
  /**
   * Whether stopping a recording uploads it automatically. Off by default: it
   * sends screenshots and captured request bodies to whatever address is
   * configured, which should be a decision, not a surprise.
   */
  mcpAutoSend: boolean;
  /**
   * Whether a step records the React component it happened in.
   *
   * The master switch for the whole feature: off means the agent never attaches
   * its listeners, so a page that is not being attributed costs nothing at all.
   */
  reactCapture: boolean;
  /**
   * Whether captured components are looked up in the page's own bundles and
   * source maps to find the file they were written in.
   *
   * Separate from capture because the two have different costs: naming a
   * component is free, while finding its file reads the page's scripts. With
   * this off a step still names its component, and every entry says why it has
   * no path rather than looking as though it has no source.
   */
  reactResolve: boolean;
  /**
   * Absolute local path the recorded source paths sit under, so the viewer can
   * offer to open one in an editor. Empty means no link is offered.
   */
  projectRoot: string;
  /** A key into `EDITORS` in core/react/editor.ts, or `custom`. */
  editor: string;
  /** Used when `editor` is `custom`. Supports {path} {line} {col} {line1} {col1}. */
  customEditorTemplate: string;
  /**
   * Whether an interactive locate resolves the compiled position through the
   * bundle's source map.
   *
   * Deliberately **not** the same switch as `reactResolve`, which gates the
   * recorder's whole background resolution pass. One is a user waiting on a
   * component they just picked; the other is work done on idle across a whole
   * recording. Merging them would mean turning off background resolution to stop
   * a slow pick, or paying for a background pass to get one answer now. See
   * `docs/CONTRACTS.md` §3.
   */
  useSourceMaps: boolean;
  /**
   * Which component categories the trees suppress, one flag per
   * `HideableCategory` (`core/react/classify.ts`).
   *
   * Flat dotted keys in storage — `locator.hidden.routing` and friends — because
   * DevFlow keeps FlowSnap's sparse-override model, where a nested object would
   * be one value that cannot be partially overridden. This nested shape is the
   * *resolved* view; `features/settings/` owns the flattening. All default true:
   * an ancestor chain is mostly routers and providers, and hiding them is what
   * makes the tree readable.
   */
  locatorHidden: Record<string, boolean>;
}

// ── Picking and locating ─────────────────────────────────────────────────────
//
// From react-source-locator, with its vocabulary folded into DevFlow's. Nothing
// below says "RST", and `LocateResult` ends at `ComponentSource` rather than at a
// second shape that means the same thing.

/** Which list a component came from — the ancestor chain or the sibling row. */
export type TreeGroup = 'ancestry' | 'sibling';

/** A component the picker found, plus the JSX source React recorded for it. */
export interface PickedComponent {
  name: string;
  /**
   * `fiber._debugSource` when React attached it (development builds). When
   * present this is the authoritative original location and beats any bundle
   * search — React records 1-based lines, so this is `Pos1` with no conversion.
   */
  debugSource?: { source: string; line: Pos1; column: Pos1 } | null;
}

export interface PickSuccess {
  kind: 'picked';
  ancestry: PickedComponent[];
  siblings: PickedComponent[];
}

export interface PickCancelled {
  kind: 'cancelled';
}

export interface PickFailure {
  kind: 'error';
  error: string;
}

export type PickResult = PickSuccess | PickCancelled | PickFailure;

/**
 * What one interactive locate produced.
 *
 * `source` is the same `ComponentSource` a recorded step carries, and that is the
 * whole point: the DevTools panel, the popup and the flow review all render one
 * card (`ui/components/result-card.ts`, built in W1·D) because all three are
 * holding the same type. `status`, `via`, `matchCount` and the `detail` sentence
 * that explains every non-`resolved` outcome come with it, so the panel stops
 * needing its own words for "no map" and "ambiguous".
 */
export interface LocateResult {
  /** The component the user picked, by the name React knows it by. */
  component: string;
  /** Where it was written, in the one shape every surface renders. */
  source: ComponentSource;
  /** The chain above the picked component, outermost last. */
  ancestry: PickedComponent[];
  /** The picked component's siblings, for the tree view. */
  siblings: PickedComponent[];
  /** How many of the page's bundles were searched before answering. */
  resourcesSearched: number;
}
