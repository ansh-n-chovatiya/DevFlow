/**
 * What the "Send to Claude" dialog should show, derived from the flow and the
 * choices.
 *
 * The export dialog already answers "which parts of this flow do you want?" —
 * sending answered it for you, with everything, and a thirty-step recording of
 * a page that talks to an API is mostly network bodies nobody asked to read.
 * So the same switches, measured the way *this* destination charges for them:
 * an upload in bytes, and a context cost in tokens.
 *
 * Deliberately no format cards and no filename. The wire format is fixed by the
 * server and the id is assigned by it, so a choice there would be a decoration.
 *
 * Pure — see tests/send-view.test.ts.
 */

import {
  SEND_DEFAULT_IMAGES,
  SEND_DEFAULT_LOGS,
  SEND_DEFAULT_NETWORK,
  SEND_DEFAULT_REACT,
  VISION_TOKENS_PER_IMAGE,
} from '../../shared/constants.js';
import { walkthroughFor } from '../../features/mcp/send.js';
import type { ExportOptions, FlowReact, Overrides, Step } from '../../shared/types.js';
import {
  INCLUDE_LABEL,
  measure,
  NO_REACT_NOTE,
  type IncludeRow,
  type Parts,
} from './export-view.js';

/**
 * What a send carries before anyone touches the switches.
 *
 * Not a second copy of the four booleans: they are `SEND_DEFAULT_*` in
 * `shared/constants.ts`, which is where `export.send*` in the field table takes
 * its own defaults from, and where the reasoning for the asymmetry with the
 * export dialog is written down. Phase 4 made this a derivation rather than a
 * literal — the dialog reads the *setting* now, and a second hardcoded answer
 * here would be the one that disagreed with the Settings screen.
 *
 * Kept, rather than deleted with its last product caller, because the shipped
 * default is worth being a tested fact in the module that documents what a send
 * costs.
 */
export const SEND_DEFAULTS: ExportOptions = {
  images: SEND_DEFAULT_IMAGES,
  network: SEND_DEFAULT_NETWORK,
  logs: SEND_DEFAULT_LOGS,
  react: SEND_DEFAULT_REACT,
};

export interface SendInput {
  steps: Step[];
  options: ExportOptions;
  /** The flow's component table, so the React row can price itself. */
  react?: FlowReact;
  /**
   * The flow's stamp, so the context estimate is rendered under the same body
   * and walkthrough caps the server will render it under. Absent for the live
   * recording, whose stamp `sendFlow` reads at send time — `{}` then means this
   * build's defaults, which is what an unstamped flow is rendered at anyway.
   */
  settings?: Overrides;
  /** The flow's name: the walkthrough's title, and its `#` line. */
  name?: string;
  /** True while the POST is in flight. */
  busy: boolean;
}

export interface SendView {
  includes: IncludeRow[];
  /** Bytes on the wire — what the POST body will weigh. */
  total: number;
  /** Characters of the walkthrough `get_flow` returns — the token estimate. */
  context: number;
  /**
   * The flow's screenshots, and what opening all of them would cost.
   *
   * A property of the recording, not of the switches — the same thing
   * `IncludeRow.bytes` is, and for the same reason: a row has to be able to say
   * what turning it *on* would cost, or the switch is a decision made blind.
   * `null` only when the recording has no screenshots at all.
   *
   * Separate from `context` because it is a different kind of number. The
   * walkthrough is paid the moment Claude reads the flow; an image is paid only
   * if it is opened, and a flow is often answered without opening one. It exists
   * because leaving it out made the headline wrong by thirty times: a nine-shot
   * send is a few hundred tokens of text and about fourteen thousand of
   * pictures, and the dialog showed the few hundred.
   */
  vision: { readonly images: number; readonly tokens: number } | null;
  /** Bodies are not redacted, and this is the moment that matters. */
  warnBodies: boolean;
  /** Set when every switch is off, because a flow can still be sent that way. */
  note: string | null;
  canSend: boolean;
  busy: boolean;
}

/**
 * What the POST body weighs.
 *
 * Screenshots travel as the data URLs they are stored as, so they cost their
 * full string length here rather than the decoded size a ZIP entry costs.
 */
function uploadBytes(parts: Parts, options: ExportOptions): number {
  return (
    parts.base +
    (options.images ? parts.screenshotsInline : 0) +
    (options.network ? parts.network : 0) +
    (options.logs ? parts.logs : 0) +
    (options.react ? parts.react : 0)
  );
}

export function deriveSendView(input: SendInput): SendView {
  const { steps, options, busy } = input;
  const parts = measure(steps, input.react);

  const includes: IncludeRow[] = [
    {
      id: 'images',
      label: INCLUDE_LABEL.images,
      checked: options.images,
      bytes: parts.screenshotsInline,
      // Never ignored: unlike the JSON export, the server keeps every image it
      // is given. The note says where they go, since that is what decides
      // whether leaving them on is expensive.
      ignored: null,
    },
    {
      id: 'network',
      label: INCLUDE_LABEL.network,
      checked: options.network,
      bytes: parts.network,
      ignored: null,
    },
    {
      id: 'logs',
      label: INCLUDE_LABEL.logs,
      checked: options.logs,
      bytes: parts.logs,
      ignored: null,
    },
    {
      id: 'react',
      label: INCLUDE_LABEL.react,
      checked: options.react,
      bytes: parts.react,
      ignored: parts.react === 0 ? NO_REACT_NOTE : null,
    },
  ];

  const images = steps.filter((step) => step.screenshot).length;

  // A React switch left on over a flow that recorded none is still a bare send:
  // the note describes what Claude will get, not which boxes are ticked.
  const bare =
    !options.images && !options.network && !options.logs && (!options.react || parts.react === 0);

  return {
    includes,
    total: uploadBytes(parts, options),
    /*
     * Rendered, not summed. `walkthroughFor` runs the send's own pipeline —
     * prune, attribute, compact, render — and measures the document that comes
     * out, which is the one `get_flow` will return. The arithmetic it replaces
     * added up the raw JSON and was wrong in three directions at once; that
     * function says which.
     */
    context: walkthroughFor(steps, options, input.react, input.settings, input.name).length,
    vision: images > 0 ? { images, tokens: images * VISION_TOKENS_PER_IMAGE } : null,
    // Headers are redacted at capture; bodies are not. Saying so belongs at the
    // moment the bodies are about to leave the machine.
    warnBodies: options.network && parts.network > 0,
    note: bare ? 'Claude will get the steps and their URLs, and nothing else.' : null,
    canSend: steps.length > 0 && !busy,
    busy,
  };
}
