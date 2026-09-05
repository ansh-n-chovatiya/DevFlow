/**
 * Handing a flow to Claude.
 *
 * The flow is POSTed to the local MCP server, which writes it to disk and
 * answers with the id Claude will fetch it by. What comes back to the user is a
 * prompt on the clipboard: the server cannot start a conversation, so the last
 * step is always a paste, and pretending otherwise was the old toast's mistake.
 */

import { callFailed, renumber, startUrl } from '../../core/flow/index.js';
import { exportToMarkdown } from '../../core/export/markdown.js';
import { attributeSteps, pruneComponents, stripReactRef } from '../../core/react/attribution.js';
import { compactBody, type BodyLimits } from '../../core/schema/index.js';
import { describeStamp } from '../settings/stamp.js';
import { renderLimits, type RenderLimits } from '../settings/render.js';
import { load as loadSettings, resolve } from '../settings/index.js';
import { readRecordingStamp, renderedOverrides } from '../settings/recording.js';
import {
  readCurrentFrameworks,
  readCurrentReact,
  readCurrentRenders,
  readCurrentState,
} from '../flows/store.js';
import type { Framework } from '../../core/locate/adapter.js';
import { sendToWorker } from '../../shared/messages.js';
import {
  FLOW_SCHEMA_VERSION,
} from '../../shared/constants.js';
import { flowError } from '../../shared/errors.js';
import { err, ok, type Result } from '../../shared/result.js';
import type {
  ExportOptions,
  FlowPayload,
  FlowComponents,
  FlowReact,
  FlowState,
  FlowRenders,
  Overrides,
  Step,
} from '../../shared/types.js';

/**
 * What a send carries when nobody has chosen otherwise.
 *
 * Everything, because that is what every send did before the choice existed —
 * a default that quietly dropped screenshots would be a data loss disguised as
 * a feature.
 */
export const SEND_EVERYTHING: ExportOptions = {
  images: true,
  network: true,
  logs: true,
  react: true,
};

/**
 * Drop the parts of a flow the user chose not to hand over.
 *
 * Applied here rather than asked of the server: the point of the choice is that
 * the unwanted data never leaves the machine, and a flag the server honours is
 * not the same promise. Pure — see tests/send-view.test.ts.
 *
 * React is stripped from the step rather than from the payload, and that is what
 * makes the guarantee hold end to end: `buildPayload` prunes the component table
 * to the ids the steps still reference, so a step with no `react` ref keeps its
 * component out of the table without any second switch to forget.
 */
export function pruneSteps(steps: Step[], include: ExportOptions): Step[] {
  if (include.images && include.network && include.logs && include.react) return steps;

  return steps.map((step) => {
    const next = { ...step };

    if (!include.images) {
      delete next.screenshot;
      delete next.screenshotOriginal;
    }
    if (!include.network) delete next.networkCalls;
    if (!include.logs) delete next.consoleLogs;
    /*
     * `renders` goes with the React ref, and has to.
     *
     * Every entry in it is keyed by a component id, and with React switched off
     * `buildPayload` prunes the component table to the ids the steps still
     * reference — which is none. What would survive is a list of components
     * named only by an id that resolves to nothing anywhere in the payload:
     * unreadable to the reader and, worse, still a claim that those components
     * re-rendered. The same reasoning `stripReactRef` exists for, one field
     * over.
     */
    if (!include.react) delete next.renders;
    // `stripReactRef` copies rather than mutates, for the same reason `next`
    // does: the element is shared with the stored recording.
    return include.react ? next : stripReactRef(next);
  });
}

/**
 * Response headers worth the tokens on a call that failed.
 *
 * Everything else is dropped outright — see `leanCalls`. These five earn their
 * place because each one *is* the bug in some flow: a 401 whose
 * `www-authenticate` names the scheme, a CORS failure whose whole story is that
 * `access-control-allow-origin` is absent, a 429 with a `retry-after`, a
 * redirect loop readable only from `location`, and `content-type` because an
 * endpoint answering a fetch with an HTML error page is a class of bug that
 * looks like malformed JSON until you see the header.
 *
 * Lower-cased: `Headers` normalises on the way in for `fetch`, but the XHR path
 * splits raw response lines, so the case is whatever the server sent.
 */
const DIAGNOSTIC_HEADERS = new Set([
  'content-type',
  'www-authenticate',
  'access-control-allow-origin',
  'retry-after',
  'location',
]);

/**
 * Headers kept on *every* call, not only a failed one.
 *
 * `DIAGNOSTIC_HEADERS` above answers "what went wrong", so it rides only on
 * failures and everything else is dropped to nothing. This set answers a
 * different question — *which code ran* — and a server action that worked is
 * exactly the case where that matters.
 *
 * `next-action` is Next.js's id for the server action a request invoked, and
 * `mcp-server/rsc.js` maps it to the file and export it came from through
 * `server-reference-manifest.json`. Without it here the manifest reader is
 * reachable only for actions that failed, which is the opposite of useful. It
 * is an opaque hash naming a function in the user's own code — not a
 * credential, and not a body — so keeping it costs a few tokens and no privacy.
 * Widening `DIAGNOSTIC_HEADERS` instead would have made one set mean two
 * things, and the next reader would have had to guess which.
 */
const ATTRIBUTION_HEADERS = new Set(['next-action']);

function keepHeaders(
  headers: Record<string, string> | undefined,
  failed: boolean,
): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    const name = key.toLowerCase();
    if (ATTRIBUTION_HEADERS.has(name) || (failed && DIAGNOSTIC_HEADERS.has(name))) {
      kept[key] = value;
    }
  }
  return kept;
}

/**
 * What the network half of a step costs Claude, cut to what it answers.
 *
 * Two things happen here, and both used to happen only on the *download* path —
 * `exportToJSON` has compacted bodies since it was written, and the flow the
 * agent actually reads never did. A modest 15-step recording with three calls a
 * step measured 93k tokens through `get_flow`; past the client's MCP output cap
 * it is not merely expensive but silently cut mid-JSON, which is the one
 * failure this codebase refuses everywhere else.
 *
 * - **Bodies are compacted**, exactly as the ZIP export compacts them, except
 *   that a *failed* call keeps its body verbatim (`diagnostic`). A schema of a
 *   500 is a description of the error's grammar with the error removed.
 * - **Headers are dropped**, except the handful above on a call that failed.
 *   They are already redacted at capture, they repeat per call, and no question
 *   an agent asks of a successful request is answered by its `date` or `vary`.
 *
 * The extension's own storage is untouched: the viewer still shows every header
 * and offers "Show raw" on every body. This is what leaves the machine.
 */
export function leanCalls(step: Step, bodies?: BodyLimits): Step {
  if (!step.networkCalls?.length) return step;

  return {
    ...step,
    networkCalls: step.networkCalls.map((call) => {
      const failed = callFailed(call);
      return {
        ...call,
        requestHeaders: keepHeaders(call.requestHeaders, failed),
        responseHeaders: keepHeaders(call.responseHeaders, failed),
        // The truncation flags travel with the body, so a body the capture cut
        // short is read as truncated JSON rather than mislabelled non-JSON.
        requestBody: call.requestBody
          ? (compactBody(
              call.requestBody,
              {
                truncated: call.requestBodyTruncated,
                bytes: call.requestBodyBytes,
                diagnostic: failed,
              },
              bodies,
            ) ?? null)
          : call.requestBody,
        responseBody: call.responseBody
          ? (compactBody(
              call.responseBody,
              {
                truncated: call.responseBodyTruncated,
                bytes: call.responseBodyBytes,
                diagnostic: failed,
              },
              bodies,
            ) ?? null)
          : call.responseBody,
      };
    }),
  };
}

/*
 * A stand-in for the absolute path the server writes beside each step.
 *
 * `get_flow` names every screenshot by its path on disk — that is the whole
 * reason an image costs nothing until it is opened — and those paths are text
 * in the document like any other. Nine of them is about a hundred and fifty
 * tokens, which is the difference the Screenshots switch makes to what Claude
 * reads, and the difference a user is entitled to see move when they touch it.
 *
 * The real path is `<home>/.devflow/flows/<id>/screenshots/step-NN.jpg` and the
 * home directory is the server's, not something the browser can know. This is
 * that shape at a representative length, which is what an estimate prefixed
 * with `~` is allowed to be.
 */
const SCREENSHOT_DIR = '/Users/you/.devflow/flows/flow-1700000000000/screenshots';

const screenshotPath = (index: number): string =>
  `${SCREENSHOT_DIR}/step-${String(index + 1).padStart(2, '0')}.jpg`;

/**
 * The document `get_flow` will hand back for this send.
 *
 * Rendered rather than estimated, by the same `exportToMarkdown` the MCP server
 * calls on the flow it stores — so the number under the Send button is the size
 * of the actual walkthrough, not the size of the JSON that produced it.
 *
 * It used to be a sum of byte counts: step JSON, plus network JSON if that
 * switch was on, plus console JSON if that one was. Every term of it was wrong
 * in a different direction. Network arrived pre-compaction, when `leanCalls`
 * turns a response body into its schema and drops every header — the change
 * that made a 15-step flow 93k tokens instead of 9k, counted here at the 93k.
 * The walkthrough quotes a bounded slice of a body and prints at most
 * `mcp.maxConsoleEntries` lines a step, so the caps in the flow's own stamp
 * moved the real figure and not this one. And screenshots were left out
 * entirely on the grounds that an image costs nothing until it is opened, which
 * is true of the image and not of the path printed next to it — so the one
 * switch that changes a flow's weight by megabytes moved the token figure by
 * exactly zero, which is how a user learns the number is decorative.
 *
 * Pure, and every step of it is the send's own path: prune, attribute, compact,
 * render. What the dialog prices and what the wire carries cannot drift,
 * because they are the same three functions in the same order.
 */
export function walkthroughFor(
  steps: Step[],
  include: ExportOptions,
  react?: FlowReact | null,
  settings: Overrides = {},
  name = 'Flow Recording',
): string {
  const limits = bodyLimits(settings);
  const sending = pruneSteps(renumber(steps), include);
  const components = react ? pruneComponents(sending, react.components) : {};
  const carries = react !== null && react !== undefined && Object.keys(components).length > 0;
  const attributed = carries ? attributeSteps(sending, components) : sending;

  return exportToMarkdown(
    attributed.map((step) => leanCalls(step, limits)),
    {
      title: name,
      images: {
        kind: 'file',
        names: attributed.map((step, index) => (step.screenshot ? screenshotPath(index) : null)),
      },
      ...(carries && react ? { react: { ...react, components } } : {}),
      settings: describeStamp(settings),
      limits,
      /*
       * Read here rather than in `core/export/markdown.ts`, which is bundled
       * into `mcp-server/core.js` and may not have a clock. `features/` is
       * where the clock lives, so this is the nearest caller entitled to one.
       *
       * Left absent, the writer omits the `Exported` line rather than inventing
       * a time — which is the right default and the wrong answer here, since
       * the walkthrough is the thing a person reads next to a bug report.
       */
      now: new Date(),
    },
  );
}

export interface SendResult {
  /** The id the server stored the flow under. */
  id: string;
  /** The prompt written to the clipboard, or `null` if the write was refused. */
  prompt: string | null;
}

/**
 * The body of the POST. Pure, so the wire format is testable without a server.
 *
 * The component table is pruned to what the steps being sent actually point at:
 * a user who dropped half the flow in the review tab, or turned a section off in
 * the send dialog, must not still hand over the source paths of the code behind
 * it. `react` is omitted entirely rather than sent empty, because the server and
 * the reader both take its absence to mean "not a React page".
 *
 * A needle never appears here, and there is a test that says so. Needles live in
 * their own storage key and are deleted the moment a component has an answer, so
 * this is a guarantee about the shape of `ComponentSource` rather than a filter —
 * which is the strong kind, and the assertion is what keeps it that way.
 */
export function buildPayload(
  id: string,
  name: string,
  steps: Step[],
  at: number,
  react?: FlowReact | null,
  include: ExportOptions = SEND_EVERYTHING,
  /**
   * The flow's settings stamp — the "a flow records the settings it was made
   * under". Sparse; `{}` for a recording made entirely at the defaults, and
   * then absent from the payload rather than sent as an empty object.
   */
  settings: Overrides = {},
  /**
   * What the recording saw of the app's state. `null` for a flow archived
   * before state capture existed, which is not the same as "nothing changed"
   * and is the one case the payload has nothing to say about.
   */
  state: FlowState | null = null,
  /**
   * What the recording saw of the app's renders. `null` for a flow archived
   * before render sampling existed, which is not the same as "nothing
   * re-rendered" — see `FlowRenders`.
   */
  renders: FlowRenders | null = null,
  /**
   * The non-React frameworks' tables, already pruned to `steps` by
   * `buildFlowFrameworks`. Empty rather than null: a page with none simply has
   * no keys, and the payload spreads it either way.
   */
  frameworks: Partial<Record<Framework, FlowComponents>> = {},
): FlowPayload {
  const components = react ? pruneComponents(steps, react.components) : {};
  const carries = react !== null && react !== undefined && Object.keys(components).length > 0;
  const omitted = (['images', 'network', 'logs', 'react'] as const).filter((key) => !include[key]);

  // The owner is stamped here so the server does not have to know the rules
  // that pick it — see `attributeSteps`.
  const attributed = carries ? attributeSteps(steps, components) : steps;

  return {
    schemaVersion: FLOW_SCHEMA_VERSION,
    id,
    name,
    timestamp: at,
    startUrl: startUrl(steps),
    ...(omitted.length ? { omitted } : {}),
    // Absent when there is nothing to say, for the same reason `react` and
    // `omitted` are: a flow recorded at the defaults should read as one, and an
    // empty object in every payload is a field readers learn to skip.
    ...(Object.keys(settings).length ? { settings } : {}),
    // Last, so it sees whatever the steps ended up being. `pruneSteps` may have
    // deleted `networkCalls` outright, in which case this is a no-op.
    //
    // The compaction rules come from the stamp rather than from this build's
    // constants, so the document says what was done to it: `network.*` in the
    // stamp is what shaped the bodies below.
    steps: attributed.map((step) => leanCalls(step, bodyLimits(settings))),
    ...(carries ? { react: { ...react, components } } : {}),
    // Siblings of `react`, on exactly its terms — see `Flow` in shared/types.
    ...frameworks,
    // Sent whole, including when it says nothing was read. That is the whole
    // point of `FlowState.read` and `FlowState.note`: on the receiving side,
    // "state capture was off" and "no store changed" are indistinguishable
    // without them, and a reader that cannot tell picks the worse one.
    ...(state ? { state } : {}),
    // On `state`'s terms exactly: absent when the recording has nothing to say
    // about renders, present — including with `read: false` — the moment it
    // does, because "sampling was off" is an answer and silence is not.
    ...(renders ? { renders } : {}),
  };
}

/**
 * The rules a stamp names, as the renderers want them.
 *
 * A stamp holds overrides only, so `resolve()` supplies this build's default
 * for every key it does not carry — which is the ordinary case, since a flow
 * recorded and rendered at the defaults carries no keys at all. Going through
 * `resolve` rather than reading the two fields directly is what makes a
 * hand-edited `flow.json` harmless: this path is reached for archived flows and
 * for anything that arrived over the wire.
 *
 * Phase 4 widened it from two `network.*` keys to four, because the walkthrough
 * caps travel in the same stamp and are applied by the same renderer. The name
 * followed. See `features/settings/render.ts`.
 */
export function bodyLimits(settings: Overrides): RenderLimits {
  return renderLimits(resolve(settings));
}

/** What to paste into Claude. Pure, so the wording is one place. */
export function buildPrompt(id: string, steps: Step[], first: string | undefined): string {
  return (
    `Call get_flow("${id}") now (devflow MCP) — ${steps.length}-step recording` +
    `${first ? ` @ ${first}` : ''}. Read the steps, identify what the user did or what broke, then help.`
  );
}

export async function sendFlow(
  name: string,
  steps: Step[],
  id = `flow-${Date.now()}`,
  include: ExportOptions = SEND_EVERYTHING,
  /**
   * An archived flow's frozen table.
   *
   * Undefined and `null` are different answers, and every `archived*` argument
   * below reads them the same way: undefined is "the caller has nothing to say,
   * this is the live recording", and the value is read back here so it includes
   * whatever the resolve above found; `null` is an archived flow saying it has
   * no table of its own. Collapsing the two — which `??` does — hands an
   * archived flow the *current* recording's components, so a flow from last
   * week arrives at Claude naming source files nothing in it ever touched.
   * Silently wrong context is worse for this product than absent context.
   */
  archivedReact?: FlowReact | null,
  /** When the flow was *recorded*. Defaults to now, which is only right for the
   *  live recording — an archived flow has its own, older, `createdAt`. */
  recordedAt?: number,
  /** An archived flow's frozen stamp. Omitted for the live recording, whose
   *  stamp is read back here — the same split as `archivedReact`. */
  archivedSettings?: Overrides | null,
  /** An archived flow's frozen state, on `archivedReact`'s undefined/null split. */
  archivedState?: FlowState | null,
  /** An archived flow's frozen render summary, on the same split again. */
  archivedRenders?: FlowRenders | null,
  /**
   * An archived flow's frozen framework tables, on the same split again.
   *
   * Undefined rather than `{}` for the live recording, so "the caller had none
   * to give" stays distinguishable from "this archived flow genuinely had
   * none" — the live path reads its own back below, and an empty object from an
   * archive must not trigger that read.
   */
  archivedFrameworks?: Partial<Record<Framework, FlowComponents>>,
): Promise<Result<SendResult>> {
  if (steps.length === 0) return err(flowError('MCP_UNREACHABLE', 'nothing to send'));

  // Last chance to resolve React components while the recorded tab may still be
  // open and its bundles still cached. It resolves nothing when there is nothing
  // pending, and a worker that never answers costs the send nothing.
  //
  // `final` is safe to ask for even though this path also sends archived flows:
  // the worker downgrades it whenever a recording is still running, which is the
  // only case where writing pending components off as skipped would be a lie.
  //
  // Skipped outright when React is not being sent: resolution reads the page's
  // bundles, and doing that work to build a table this send is about to throw
  // away would be the one cost the switch exists to avoid.
  if (include.react) await sendToWorker({ type: 'RESOLVE_COMPONENTS', final: true });

  const settings = await loadSettings();
  const url = settings.mcpServerUrl;

  /*
   * The stamp: what the recording was frozen at, plus what this hand-over is
   * being rendered under.
   *
   * Two moments, one object, because they are one claim about the document the
   * reader ends up with. `recorded` was decided when Record was pressed and
   * cannot change; `rendered` is decided now, which is why somebody who
   * switches summarising off can re-send a week-old flow and get the bytes.
   * `features/settings/fields.ts` says which keys are which.
   */
  const stamp: Overrides = {
    ...(archivedSettings ?? (await readRecordingStamp())),
    ...renderedOverrides(settings),
  };

  // Renumbered first, so `stepNumber` agrees with the position the server files
  // the step at. A flow with a step deleted in the review tab was sent carrying
  // its original numbers, so the JSON said "step 5" where the markdown said
  // "Step 4" and `get_flow_screenshots({steps:[5]})` answered that step 5 does
  // not exist. Every other export path already renumbers; this one did not.
  const sending = pruneSteps(renumber(steps), include);
  // Read after the resolve, so the table carries what that last pass found.
  // Not read at all when React is switched off for this send — `sending` has no
  // refs left, so the table would prune to nothing, but not touching storage is
  // the clearer promise.
  //
  // `=== undefined` rather than `??` throughout, because `null` is an archived
  // flow's own answer and not an absent one — see `archivedReact`.
  const react = include.react
    ? (archivedReact === undefined ? await readCurrentReact(sending) : archivedReact)
    : null;
  const state = archivedState === undefined ? await readCurrentState() : archivedState;
  /*
   * Not behind an include switch, for the reason `state` is not: what is sent
   * is bounded by `recording.renders`, which is the switch that decides whether
   * it was ever sampled, and a `FlowRenders` saying it was not is a few dozen
   * bytes. It is dropped along with the steps' own lists when React is switched
   * off, because without the component table it names nothing.
   */
  const renders = include.react
    ? (archivedRenders === undefined ? await readCurrentRenders() : archivedRenders)
    : null;
  // The recording's own time, not the moment Send was pressed. The server
  // prints this as "Recorded" and orders `list_flows` by it, so stamping now
  // dated a week-old flow to this afternoon and pushed it above the recording
  // the user actually just made.
  const payload = buildPayload(
    id,
    name,
    sending,
    recordedAt ?? Date.now(),
    react,
    include,
    stamp,
    state,
    renders,
    include.react
      ? (archivedFrameworks ?? (await readCurrentFrameworks(sending)))
      : {},
  );
  const first = payload.startUrl;

  const abort = new AbortController();
  // The setting, from the same `load()` the address came from — a send of a
  // long recording legitimately takes seconds, and how many is a preference.
  const timer = setTimeout(() => abort.abort(), settings['mcp.sendTimeoutMs']);

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abort.signal,
    });

    if (!response.ok) return err(flowError('MCP_UNREACHABLE', `HTTP ${response.status}`));

    const body = (await response.json()) as { id?: string };
    const savedId = body.id ?? id;
    const prompt = buildPrompt(savedId, sending, first);

    // The clipboard needs the document to be focused, which it is not if the
    // user clicked away while a large flow uploaded. The send still worked, so
    // that is reported as a success with the prompt shown to copy by hand.
    const copied = await navigator.clipboard
      .writeText(prompt)
      .then(() => true)
      .catch(() => false);

    return ok({ id: savedId, prompt: copied ? prompt : null });
  } catch (error) {
    return err(flowError('MCP_UNREACHABLE', error instanceof Error ? error.message : error));
  } finally {
    clearTimeout(timer);
  }
}
