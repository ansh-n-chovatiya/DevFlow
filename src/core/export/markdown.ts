/**
 * Markdown export — the comprehension artifact an AI actually reads.
 *
 * Everything here is in service of staying token-lean: brittle full-path CSS
 * selectors are omitted (they live in flow.json for replay), bodies are
 * schema-compacted, and console output is filtered to errors and warnings.
 */

import { isStableSelector } from '../selector/index.js';
import { compactBody, type BodyLimits } from '../schema/index.js';
import { callFailed, flowHost, urlPath } from '../flow/index.js';
import {
  formatSource,
  referencedComponentIds,
  sourceProvenance,
  stepEnclosing,
  stepOwner,
} from '../react/attribution.js';
import { CAPPED_ID } from '../react/table.js';
import type { ComponentSource, ExportOptions, FlowReact, Step } from '../../shared/types.js';
import { MAX_CONSOLE_ENTRIES, MAX_RESPONSE_BODY } from '../../shared/constants.js';

/**
 * How a step's screenshot is referenced.
 * - `inline`: the base64 data URL, for a single self-contained .md file.
 * - `file`: a relative path into the ZIP's images/ folder. Vision models read
 *   image files; they cannot read base64 pasted as text.
 * - `none`: images excluded.
 */
export type ImageStrategy =
  | { kind: 'inline' }
  | { kind: 'file'; names: (string | null)[] }
  | { kind: 'none' };

/**
 * The limits one document is rendered under.
 *
 * `BodyLimits` is what `compactBody` reads — whether a body is summarised, and
 * above what size. The two added here are the walkthrough's own density: how
 * much of a response body it quotes, and how many console entries one step
 * prints. They travel together because they are one answer to one question —
 * *how much of this recording ends up in front of a reader* — and because they
 * arrive together: all four are keys in a flow's own `settings` stamp, and both
 * the extension's export and the MCP server derive this object from it.
 *
 * Every field is optional and every reader falls back to the constant beside
 * it. A flow recorded and rendered at the defaults carries no stamp at all, and
 * `undefined` has to mean "the shipped answer" rather than "nothing".
 *
 * `core/` still knows nothing about the field table: `features/settings/
 * render.ts` builds this from resolved settings, on both sides of the wire.
 */
export interface RenderLimits extends BodyLimits {
  /** `mcp.maxResponseBody` — how much of one response body the walkthrough quotes. */
  readonly responseBody?: number;
  /** `mcp.maxConsoleEntries` — how many errors and warnings one step prints. */
  readonly consoleEntries?: number;
}

/*
 * How much page-derived text each slot is worth.
 *
 * These two stay local: nothing outside this renderer has an opinion about how
 * long a *request* body may be in a document, or how much of one console line is
 * worth quoting, and the JSON export deliberately keeps the full one.
 */
const MAX_REQUEST_BODY = 150;
const MAX_CONSOLE_MESSAGE = 200;

/*
 * The other two are settings — the walkthrough's density is a real preference,
 * so they live in `shared/constants` where `features/settings/fields.ts` can
 * import them as its defaults instead of retyping the numbers.
 */

/**
 * Cut to `limit`, and say so.
 *
 * Silent truncation is worse than no truncation: a 900-character JSON body cut
 * to 150 ends mid-object and reads as a complete one, so a reader concludes the
 * cart held two items when it held nine. `compactBody` already stamps
 * `[schema — 12.4KB raw]` for exactly this reason; these cuts then shortened its
 * output again without a word.
 */
function truncate(text: string, limit: number): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}… (+${text.length - limit} chars truncated)`;
}

/** Collapse every run of whitespace, so page text cannot span lines. */
function flatten(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** The longest run of backticks in `text`, or 0. */
function backtickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/**
 * A fence long enough that `content` cannot escape it.
 *
 * Response bodies are arbitrary page text and routinely carry their own ``` — a
 * code sample inside an error message, a chat API echoing a snippet. Pasted into
 * a three-backtick block that run closes it and opens an unterminated one, and
 * everything after it (this step's console errors, every later step, the whole
 * React components table) renders as literal text inside it. CommonMark closes a
 * fence only on a run at least as long, so the fence grows past the content's
 * longest run.
 */
function fenceFor(content: string): string {
  return '`'.repeat(Math.max(3, backtickRun(content) + 1));
}

/**
 * One line of page-derived text as an inline code span.
 *
 * Page text reaches the document verbatim — a console `error` whose message
 * contains `### 100. Clicked "Confirm delete"` used to render as a step heading
 * for an action nobody performed, and an ordinary multi-line stack trace broke
 * the document's structure without anyone trying. Flattened so it cannot open a
 * new block, fenced past its own backticks so it cannot leave the span.
 */
function inlineCode(text: string): string {
  const flat = flatten(text);
  const ticks = '`'.repeat(backtickRun(flat) + 1);
  // CommonMark strips one space from each side of a span, so padding is what
  // lets the content itself start or end with a backtick.
  const pad = flat.startsWith('`') || flat.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${flat}${pad}${ticks}`;
}

/**
 * One table cell of page-derived text.
 *
 * A component's `name` is its `displayName`, which is a string the recorded
 * application chose: a `|` in it opens a column the header never declared, and
 * a newline ends the table and leaves the rest of the row as prose — the same
 * forging `inlineCode` prevents for a step's own text, in the one place the
 * document quotes page text outside a span. A source path carries the same risk
 * for the same reason, since it is read off the application's source map.
 */
function cell(text: string): string {
  return flatten(text).replace(/\|/g, '\\|');
}

function imageRef(step: Step, index: number, strategy: ImageStrategy): string | null {
  switch (strategy.kind) {
    case 'inline':
      return step.screenshot ?? null;
    case 'file':
      return strategy.names[index] ?? null;
    case 'none':
      return null;
  }
}

/**
 * Host of the first URL we can parse, shown once in the header, and the compact
 * pathname used for page-change markers.
 *
 * Both live in `core/flow` now that the viewer's library and the component table
 * also need them; re-exported here because this is where they have always been
 * imported from.
 */
export { flowHost, urlPath };

/**
 * Append one step block. `prevPath` is the previous step's path; the returned
 * path lets the caller track transitions so 📍 only marks real page changes.
 */
function appendStep(
  lines: string[],
  step: Step,
  n: number,
  prevPath: string,
  image: string | null,
  opts: Partial<ExportOptions>,
  components: Record<string, ComponentSource>,
  limits: RenderLimits | undefined,
): string {
  /*
   * `action` is page text: `accessibleName()` is `innerText.trim().slice(0,80)`,
   * and innerText keeps its internal newlines. A plan card reading "Pro plan"
   * over "$20/mo" used to produce `### 1. Clicked "Pro plan` and leave `$20/mo"`
   * behind as a stray paragraph — no attacker required.
   */
  lines.push(`### ${n}. ${flatten(step.action ?? '') || step.type}`);

  const path = urlPath(step.url);
  if (path && path !== prevPath) lines.push(`📍 ${path}`);

  if (step.element && isStableSelector(step.element.cssSelector)) {
    // `inlineCode` rather than a hand-written span: an id or an aria-label may
    // hold a backtick, `CSS.escape` keeps it, and a span it closes early leaves
    // the rest of the selector as prose.
    lines.push(inlineCode(step.element.cssSelector));
  }

  /*
   * The component *name* only. Its path is in the table at the end of the
   * document, so a flow that clicks one button forty times pays for that path
   * once — the same rule that keeps full CSS selectors out of here.
   */
  const owner = stepOwner(step, components);
  if (owner) {
    // The enclosing feature component is named alongside it, because on an app
    // with a shared UI kit `⚛ Button` on its own is true and useless.
    const within = stepEnclosing(step, components);
    // Flattened for `action`'s reason one block up: a `displayName` is a string
    // the application chose, and one carrying a newline turned the rest of
    // itself into a paragraph — or into a heading for a step nobody performed.
    const name = flatten(owner.component.name);
    lines.push(within ? `⚛ ${name} · in ${flatten(within.component.name)}` : `⚛ ${name}`);
  }

  /*
   * Typed text, quoted as code rather than in bare quotation marks. A textarea
   * holding `### 99. Clicked "Delete account"` forged a step that way; a value
   * with a newline in it spilled the rest into the document as prose.
   */
  if (step.value) {
    if (/\n/.test(step.value)) {
      // A multi-line value is worth keeping whole — a pasted address, a commit
      // message — so it gets a block rather than being squashed onto one line.
      const fence = fenceFor(step.value);
      lines.push('↳ value:');
      lines.push(fence);
      lines.push(step.value);
      lines.push(fence);
    } else {
      lines.push(`↳ value: ${inlineCode(step.value)}`);
    }
  }

  /*
   * What the interaction visibly did.
   *
   * Placed above the screenshot on purpose: it is the same fact the image
   * carries, in the form a reader can act on without opening a file, and a
   * reader that has just been told the button changed to "Processing…" and an
   * error banner appeared often does not need to look.
   */
  if (step.domDelta) {
    lines.push(`↺ was: ${inlineCode(step.domDelta.before || '(empty)')}`);
    lines.push(`↺ now: ${inlineCode(step.domDelta.after || '(empty)')}`);
  }

  if (step.notes?.trim()) {
    lines.push(`> ${step.notes.trim().replace(/\n/g, '\n> ')}`);
    lines.push('');
  }

  /*
   * The alt text carries the provenance because the image itself cannot. A
   * model reading this treats a screenshot as evidence of what the page looked
   * like; for an imported one that is the user's account, not the recorder's.
   */
  if (image) {
    lines.push(`![${step.screenshotImported ? `${n} — added by hand` : n}](${image})`);
  } else if (step.screenshotOmitted) {
    /*
     * Nothing may make a recording silently worse.
     *
     * A step with no image is otherwise indistinguishable from a step whose
     * image was left out of this export, and both are indistinguishable from a
     * page that rendered nothing. The recorder wrote down which it was; this is
     * where a reader finds out. `inlineCode` because the reason is written by
     * the recorder but travels through storage, and a document's structure must
     * not depend on a string that could be edited.
     */
    lines.push(`🚫 no screenshot — ${inlineCode(step.screenshotOmitted)}`);
  }

  if (step.networkCalls?.length && opts.network !== false) {
    lines.push('');
    for (const call of step.networkCalls) {
      lines.push(
        `\`${call.method || 'GET'}\` ${urlPath(call.url)} → ${call.status ?? 'err'} (${call.durationMs || 0}ms)`,
      );
      /*
       * The trace id, and only on a call that failed.
       *
       * It is 32 hex characters of pure identifier, so printing it beside every
       * healthy call would cost thousands of tokens across a long recording to
       * say something nobody asked. On a *failed* call it is the next thing the
       * reader does — the same id their own backend logged, to grep for. That
       * asymmetry is a decision, not an omission, and `tests/markdown.test.ts`
       * asserts both halves of it.
       *
       * `callFailed` rather than a second `status >= 400` written here: the
       * rule for what counts as a failure lives in `core/flow` and the server
       * reads the same one.
       */
      if (call.traceId && callFailed(call)) lines.push(`  ↳ trace: ${inlineCode(call.traceId)}`);
      if (call.requestBody) {
        const body = truncate(
          flatten(
            compactBody(
              call.requestBody,
              { truncated: call.requestBodyTruncated, bytes: call.requestBodyBytes },
              limits,
            ) ?? '',
          ),
          MAX_REQUEST_BODY,
        );
        lines.push(`  ↳ req: ${inlineCode(body)}`);
      }
      if (call.responseBody) {
        // Truncated before the block is built, not after: the old code indented
        // every line first and then sliced, so a multi-line body lost two
        // characters of its own content per line to the indent. The indent is
        // gone as well — it is what let an interior ``` line up as a closer.
        const body = truncate(
          compactBody(
            call.responseBody,
            { truncated: call.responseBodyTruncated, bytes: call.responseBodyBytes },
            limits,
          ) ?? '',
          limits?.responseBody ?? MAX_RESPONSE_BODY,
        );
        const fence = fenceFor(body);
        lines.push('  ↳ res:');
        lines.push(fence);
        lines.push(body);
        lines.push(fence);
      }
    }
  }

  // Console: only errors and warnings. `log`/`info` are noise for an AI.
  if (step.consoleLogs?.length && opts.logs !== false) {
    const all = step.consoleLogs.filter((log) => log.level === 'error' || log.level === 'warn');
    const notable = all.slice(0, limits?.consoleEntries ?? MAX_CONSOLE_ENTRIES);
    if (all.length) {
      lines.push('');
      for (const log of notable) {
        const text = truncate(flatten(log.args.join(' ')), MAX_CONSOLE_MESSAGE);
        lines.push(`⚠ \`[${log.level}]\` ${inlineCode(text)}`);
      }
      /*
       * Six errors on one step reading as five is a different story about the
       * page than six is, so the cap says what it swallowed.
       *
       * The guard above is on `all`, not `notable`, because the cap is a
       * setting now. At the shipped 5 the two are the same test; at 0 they are
       * not, and guarding on `notable` made a step with seven errors print
       * nothing at all — a clean-looking step, which is the one thing a
       * setting may never quietly produce. The header names the cap; this line
       * is what says the cap bit *here*.
       */
      if (all.length > notable.length) lines.push(`⚠ … +${all.length - notable.length} more`);
    }
  }

  lines.push('');
  return path;
}

/**
 * The Notes cell: the provenance worth naming, then the row's own sentence.
 *
 * `sourceProvenance` is silent for DevFlow's own two paths and speaks only for a
 * build stamp, so this adds a phrase to a row roughly never — and to exactly the
 * rows where a reader is entitled to know the answer came out of a build step in
 * the recorded application rather than out of DevFlow. `ROADMAP_AND_PHASES.md`
 * §1.1 rule 3 is the reason, and this table is where it was failing: a stamped
 * component has no `detail`, so the cell was empty and `get_flow` — the primary
 * tool, and the document `flow.md` holds on disk — was the one surface that read
 * an attribution in full and said nothing about where it came from.
 *
 * A stamped entry carries no `detail` today, so the join is for the case where
 * that stops being true rather than for one that exists.
 */
function componentNotes(component: ComponentSource): string {
  const how = sourceProvenance(component);
  return [how, component.detail].filter(Boolean).join(' · ');
}

/**
 * The one place a component's source is written down.
 *
 * Every row states its own confidence, so the document cannot claim a path in
 * one place and hedge about it in another. A component with nowhere to point
 * still gets a row: its name appeared beside a step, and whoever looks it up
 * deserves the reason rather than a gap.
 */
function appendComponents(lines: string[], react: FlowReact, steps: Step[]): void {
  const rows = referencedComponentIds(steps)
    .map((id) => react.components[id])
    .filter((component): component is ComponentSource => Boolean(component))
    .map((c) => `| ${cell(c.name)} | ${cell(formatSource(c) ?? '—')} | ${cell(componentNotes(c))} |`);

  /*
   * The cap is a fact about the recording, not about any one row.
   *
   * `pruneComponents` keeps the marker whatever happens, so a flow that exceeded
   * `MAX_COMPONENTS_PER_FLOW` and then had its early steps deleted arrives here
   * with the marker and nothing else. Returning on the empty table first threw
   * the note away with it, and the document then claimed nothing was left out.
   */
  const capped = react.components[CAPPED_ID];
  const note = capped?.detail;

  if (rows.length === 0) {
    if (note) {
      lines.push(`> ${note}`);
      lines.push('');
    }
    return;
  }

  lines.push('## React components');
  lines.push('');
  lines.push('| Component | Source | Notes |');
  lines.push('| --- | --- | --- |');
  lines.push(...rows);
  lines.push('');

  if (note) {
    lines.push(`> ${note}`);
    lines.push('');
  }
}

/**
 * One step, rendered on its own.
 *
 * The MCP server returns a *window* onto a recording rather than all of it, and
 * to decide where the window ends it has to know what each step costs before
 * committing to it. Rendering the whole document to find out is what the budget
 * exists to avoid, so the per-step renderer is exposed rather than reimplemented
 * — the alternative was the server keeping a second, weaker copy of these rules,
 * which is what it did, and which is why a response body containing `## Step 99`
 * could forge a step that nobody performed.
 *
 * `prevPath` is the previous step's path, so `📍` marks real page changes and
 * not every step; the returned path is what the caller passes to the next call.
 */
export function renderStep(
  step: Step,
  n: number,
  prevPath: string,
  image: string | null,
  options: Pick<Partial<ExportOptions>, 'network' | 'logs'> = {},
  components: Record<string, ComponentSource> = {},
  /** What this document is rendered under — see `RenderLimits`. */
  limits?: RenderLimits,
): { lines: string[]; path: string } {
  const lines: string[] = [];
  const path = appendStep(lines, step, n, prevPath, image, options, components, limits);
  return { lines, path };
}

/**
 * The React component table for a set of steps, or `[]` when there is nothing
 * to say. Exposed for the same reason as `renderStep`.
 */
export function renderComponents(react: FlowReact, steps: Step[]): string[] {
  const lines: string[] = [];
  appendComponents(lines, react, steps);
  return lines;
}

export interface MarkdownOptions extends Omit<Partial<ExportOptions>, 'images' | 'react'> {
  title?: string;
  /** `true`/`undefined` inlines base64; `false` omits; a strategy is explicit. */
  images?: ImageStrategy | boolean;
  /**
   * The flow's component table, when it was recorded on a React page.
   *
   * Stands in for the `react` switch the other parts have, exactly as it does in
   * `exportToJSON`: no table means no `⚛` line and no components section, since
   * the per-step ids are unreadable without it. The caller decides; this renders.
   */
  react?: FlowReact;
  /**
   * The body rules and walkthrough caps this document is built under — see
   * `RenderLimits`.
   */
  limits?: RenderLimits;
  /**
   * The flow's settings stamp, already turned into sentences.
   *
   * Lines, not the stamp itself: this module is bundled into the MCP server and
   * knows nothing about the field table, so the caller — which does — describes
   * the stamp and hands over the words. `features/settings/stamp.ts` is where
   * that wording lives, and it is the only place it lives, so the walkthrough a
   * tool returns and the `flow.md` beside it cannot describe one recording two
   * different ways.
   *
   * Empty or absent means the flow was recorded at the defaults, and the header
   * says nothing — which is the honest reading and the cheap one.
   */
  settings?: readonly string[];
  /**
   * The commit this recording was made at, already worded — and worded by the
   * caller for `settings`' reason, plus one of its own.
   *
   * The MCP server stamps a flow with the commit of the project it runs in, at
   * the moment the recording arrives; the extension writing its own export has
   * no repository and no commit, so this is simply absent there and the header
   * says nothing. What the stamp is worth is not a fact about markdown — it is
   * narrower than "the build that was running" and needs a caveat when the page
   * was not served by this machine — so `core/git` does the wording and this
   * prints it.
   */
  commit?: string;
  /**
   * The moment this document is being written, supplied by the caller.
   *
   * Not read here. `core/` is bundled into `mcp-server/core.js` and imported by
   * a Node process with no clock of this module's choosing — the clock belongs
   * to `features/`, and a defaulted `new Date()` would keep the impurity
   * reachable while looking as though it had been dealt with. Absent means the
   * caller has nothing to stamp, and the header simply omits the line: an export
   * time nobody supplied is not worth inventing.
   */
  now?: Date;
}

/**
 * A timestamp as the document prints it: `2026-08-01 09:30 UTC`.
 *
 * Fixed and UTC rather than `toLocaleString()`, which was what this used. A
 * `flow.md` is an artefact — committed beside a bug report, diffed against last
 * week's, read by a model — and `toLocaleString()` renders one recording as
 * "8/1/2026, 9:30:00 AM" here and "01.08.2026, 11:30:00" in Berlin. Two exports
 * of the same flow then differ in the header on machines that agree about
 * everything else, and the MCP server, which renders this on demand, returns a
 * different document per host. A reader who wants their own timezone has the
 * offset written down; a reader who has the other rendering has nothing.
 */
function stamp(at: Date): string {
  return `${at.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** Render a flow as Markdown. */
export function exportToMarkdown(steps: Step[], options: MarkdownOptions = {}): string {
  const list = steps;
  const title = options.title ?? 'Flow Recording';

  const strategy: ImageStrategy =
    options.images === false
      ? { kind: 'none' }
      : options.images === true || options.images === undefined
        ? { kind: 'inline' }
        : options.images;

  const lines: string[] = [];
  const host = flowHost(list);

  lines.push(`# ${title}`);
  /*
   * "Recorded" is the capture time the steps carry, not the moment of export.
   * Reading it off a clock dated a flow captured on 1 August to the 24th, which
   * is the one date a reader cannot check against anything else in the document.
   * The export time is still worth having — it says how stale the screenshots
   * are — so it is kept under its own name, as `flow.json` does, and it arrives
   * from the caller because nothing in `core/` may read a clock.
   */
  const recordedAt = list[0]?.timestamp;
  lines.push(
    [
      recordedAt ? `Recorded ${stamp(new Date(recordedAt))}` : null,
      options.now ? `Exported ${stamp(options.now)}` : null,
      `${list.length} steps`,
      host || null,
    ]
      .filter(Boolean)
      .join(' · '),
  );
  /*
   * A flow records the settings it was made under.
   *
   * Directly under the date and the step count, because it is the same kind of
   * fact — *what this document is* — and because a reader who meets a flow with
   * no screenshots needs it before the first step, not after it. Absent for a
   * recording made at the defaults, which is almost all of them.
   */
  /*
   * Above the settings, because it is the more consequential of the two: which
   * build this recording is about changes what every step below it is evidence
   * of, while a moved switch changes only how much of them was captured.
   */
  if (options.commit) {
    lines.push('');
    lines.push(`Recorded at ${options.commit}`);
  }
  if (options.settings?.length) {
    lines.push('');
    lines.push(`Recorded with non-default settings: ${options.settings.join(' · ')}`);
  }

  lines.push('');
  lines.push(
    strategy.kind === 'file'
      ? '> Each step is one user action; 📍 marks a page change. Screenshots are the ' +
          '`images/step-NN.*` files — attach them to Claude (vision reads image files, ' +
          'not base64 text). Full selectors/XPath for replay live in `flow.json`.'
      : '> A recorded UI flow. Each step is one user action; 📍 marks a page change.',
  );
  lines.push('');

  let prevPath = '';
  const opts: Partial<ExportOptions> = { network: options.network, logs: options.logs };
  const components = options.react?.components ?? {};
  list.forEach((step, i) => {
    const image = imageRef(step, i, strategy);
    prevPath = appendStep(lines, step, i + 1, prevPath, image, opts, components, options.limits);
  });

  if (options.react) appendComponents(lines, options.react, list);

  return lines.join('\n');
}
