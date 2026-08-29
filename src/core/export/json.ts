/**
 * JSON export — the replay artifact.
 *
 * Unlike the Markdown, this keeps the full selectors and XPaths: it is what a
 * future playback feature would drive from, and what the MCP server persists.
 */

import { compactBody, type BodyLimits } from '../schema/index.js';
import { attributeSteps, pruneComponents, stripReactRef } from '../react/attribution.js';
import { CAPPED_ID } from '../react/table.js';
import type { ExportOptions, FlowReact, Overrides, Step } from '../../shared/types.js';

export const EXPORT_SCHEMA_VERSION = '1.0';

export interface JsonExportOptions extends Omit<Partial<ExportOptions>, 'react'> {
  /**
   * Per-step relative image path, for the ZIP export. When given, `screenshot`
   * becomes the filename rather than a placeholder string.
   */
  imageNames?: (string | null)[];
  /**
   * The flow's component table, when it was recorded on a React page.
   *
   * Pruned to the steps being written, for the same reason the payload is: a
   * flow with half its steps deleted must not still carry the source paths of
   * the code behind them.
   *
   * This stands in for the `react` switch the other parts have, because it is
   * strictly stronger: the caller that turns React off simply does not hand the
   * table over, and a step's component ids are dropped along with it below. A
   * flag *and* a table would be two things to keep in agreement, and the ids
   * are worthless without the table that says what they mean.
   */
  react?: FlowReact;
  /**
   * The flow's name — the same string that titles the Markdown.
   *
   * Written down because a `flow.json` that does not name itself is one of three
   * indistinguishable files once three exports are unzipped side by side.
   */
  title?: string;
  /**
   * The settings the flow was made under — the stamp, sparse.
   *
   * On the JSON as well as in the Markdown header, because this is the file a
   * tool reads: a `flow.json` full of steps with `screenshot: null` is a
   * question, and `settings: { "screenshots.capture": false }` is the answer.
   */
  settings?: Overrides;
  /** The flow's `network.summariseBodies` / `network.schemaThreshold`. */
  bodies?: BodyLimits;
}

/** Serialise recorded steps to the on-disk flow format. */
export function exportToJSON(steps: Step[], options: JsonExportOptions = {}): string {
  const { imageNames, images, network, logs, react, title, settings, bodies } = options;
  const components = react ? pruneComponents(steps, react.components) : {};
  /*
   * The cap marker is not a component.
   *
   * `pruneComponents` keeps `__capped__` whatever happens, so a flow that hit the
   * cap and then had the steps behind its components deleted comes back holding
   * nothing else. Counting it as an entry wrote `react: { components: {
   * __capped__ } }` alongside every surviving step's `element.react.chain` — the
   * ids-with-no-table this file's comment below says it prevents.
   */
  const carries = react !== undefined && Object.keys(components).some((id) => id !== CAPPED_ID);
  // Stamped here rather than left for the reader to derive: a flow.json is read
  // by whatever opens it, and the choice of component must not depend on that.
  const list = carries ? attributeSteps(steps, components) : steps;

  return JSON.stringify(
    {
      version: EXPORT_SCHEMA_VERSION,
      ...(title ? { name: title } : {}),
      exportedAt: new Date().toISOString(),
      stepCount: steps.length,
      // Absent when the recording used the defaults — the same rule the payload
      // and the index follow, so "no stamp" means one thing everywhere.
      ...(settings && Object.keys(settings).length ? { settings } : {}),
      // Absent rather than empty, so a flow from a page that is not React reads
      // the same as one exported before this existed.
      ...(carries ? { react: { ...react, components } } : {}),
      steps: list.map((step, i) => {
        const out: Record<string, unknown> = { ...step };

        if (images === false) {
          out.screenshot = null;
        } else if (imageNames) {
          out.screenshot = imageNames[i] ?? null;
        } else {
          out.screenshot = step.screenshot ? '[base64 image data]' : null;
        }

        // Editor state, not flow data — never leaves the extension.
        delete out.screenshotOriginal;
        delete out.highlightBox;

        // Component ids with no table to read them against are bytes that
        // answer nothing, whether React was switched off for this export or the
        // resolver never found anything worth keeping.
        if (!carries) out.element = stripReactRef(step).element;

        if (network === false) {
          delete out.networkCalls;
        } else if (step.networkCalls) {
          out.networkCalls = step.networkCalls.map((call) => ({
            ...call,
            // The flags travel with the call, so a body the capture cut short is
            // read as truncated JSON rather than mislabelled as non-JSON.
            requestBody: call.requestBody
              ? compactBody(
                  call.requestBody,
                  { truncated: call.requestBodyTruncated, bytes: call.requestBodyBytes },
                  bodies,
                )
              : call.requestBody,
            responseBody: call.responseBody
              ? compactBody(
                  call.responseBody,
                  { truncated: call.responseBodyTruncated, bytes: call.responseBodyBytes },
                  bodies,
                )
              : call.responseBody,
          }));
        }

        if (logs === false) delete out.consoleLogs;

        return out;
      }),
    },
    null,
    2,
  );
}
