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
 * It also answers the two questions the switches cannot. *What leaves whatever
 * you choose* — step URLs are behind no Include switch, so the credential scan
 * is behind none either. And *where it is going* — the address, and what the
 * health check found there, because a destination discovered after the upload
 * is a destination discovered too late.
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
import { isLoopback } from '../../features/mcp/port.js';
import { credentialParams } from '../../core/redact/index.js';
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
  /**
   * Where this send is going, and what the health probe has said about it.
   *
   * Optional because the byte accounting does not depend on it and the tests
   * that are about the byte accounting should not have to invent an address.
   * The dialog always passes it: a destination nobody can see before they
   * commit is the defect this field exists to close.
   */
  target?: { readonly url: string; readonly probe: SendProbe | null };
  /** True while the POST is in flight. */
  busy: boolean;
}

/**
 * What the health probe has said so far.
 *
 * The dialog owns the `fetch`; this module owns what each answer *means*, so
 * the failure copy is a tested fact rather than a sentence written at the call
 * site. `detail` is `FlowError.detail` — the raw reason `checkMcp` caught, not
 * the canned sentence, which is the same for all four causes and therefore
 * cannot tell them apart.
 */
export type SendProbe =
  | { readonly kind: 'checking' }
  | { readonly kind: 'ok'; readonly service: string; readonly mode: string }
  | { readonly kind: 'failed'; readonly detail: string | undefined };

export interface SendTarget {
  /** The address the POST goes to, written out in full — path included. */
  url: string;
  /** One line beside it, or `null` before the probe has been asked. */
  status: string | null;
  /** Set only when the probe failed: what is wrong, and the one thing to do. */
  problem: { readonly title: string; readonly text: string } | null;
}

/**
 * Step URLs that are still carrying something that looks like a credential.
 *
 * Its own field rather than a second `warnBodies`, because it is a different
 * claim: bodies travel only when the Network calls switch is on, and step URLs
 * travel always. Gating this on a switch — any switch — would mean the
 * reassuring copy is the one shown at the moment nothing is being held back.
 */
export interface CredentialUrls {
  /** How many step URLs carry at least one such parameter. */
  steps: number;
  /** The parameter names found, first spelling, deduplicated. */
  params: readonly string[];
  /** The sentence, built here so the count and the names cannot disagree. */
  text: string;
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
  /**
   * Credentials in the step URLs — `null` when there are none.
   *
   * Never gated on a switch. `warnBodies` is, correctly, because the bodies it
   * describes do not travel unless Network calls is on; step URLs are not
   * behind any switch at all, so a person who turns everything off to be
   * careful was previously shown the *most* reassuring line the dialog owns at
   * the one moment the payload still held a grant.
   */
  credentials: CredentialUrls | null;
  /**
   * Where the flow is going, and whether anything is listening.
   *
   * `null` only for a caller that did not pass a target — see `SendInput`.
   */
  target: SendTarget | null;
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

/** Beyond three names the list stops being readable and starts being a dump. */
const PARAMS_SHOWN = 3;

/**
 * The banner's sentence.
 *
 * "Look like", not "are": this is a match on parameter *names*, and a `?key=`
 * on a product page is a sort order rather than a secret. A warning that
 * overstates what it knows is one people learn to click past, and the whole
 * point of raising it is that this is the one it is worth reading.
 */
function credentialText(steps: number, params: readonly string[]): string {
  const shown = params.slice(0, PARAMS_SHOWN).map((name) => `?${name}=`);
  const rest = params.length - shown.length;
  const list = rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');

  const urls = steps === 1 ? '1 step URL carries' : `${steps} step URLs carry`;
  const what =
    params.length === 1
      ? 'a query parameter that looks like a credential'
      : 'query parameters that look like credentials';

  return `${urls} ${what} — ${list}. Step URLs are sent whatever the Include switches say.`;
}

function credentialsIn(steps: Step[]): CredentialUrls | null {
  const params: string[] = [];
  const seen = new Set<string>();
  let count = 0;

  for (const step of steps) {
    const found = credentialParams(step.url);
    if (found.length === 0) continue;

    count += 1;
    for (const name of found) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      params.push(name);
    }
  }

  return count === 0 ? null : { steps: count, params, text: credentialText(count, params) };
}

/** `127.0.0.1:4321` — the half of the address a person checks against a port. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

/**
 * Why the health check failed, from what it actually reported.
 *
 * Four causes reach the same `MCP_UNREACHABLE` sentence — wrong port, no server
 * installed, a program squatting the port, an address on another machine — and
 * that sentence names one of them. Naming the wrong cause is worse than naming
 * none: it sends somebody to open an editor that was already open. `detail` is
 * the only thing that separates them, so it is what this switches on, and the
 * host answers the one question `detail` cannot.
 *
 * The remote case is checked before the transport ones on purpose. `port.ts`
 * refuses to rewrite a non-loopback address because that address is not the
 * server `mcp.port` describes; the same fact makes every local remedy — start
 * it, install it, free the port — the wrong advice.
 */
function problemFor(url: string, detail: string | undefined): { title: string; text: string } {
  const raw = detail ?? '';
  const host = hostOf(url);

  if (host === null || /^not a URL/i.test(raw)) {
    return {
      title: 'That address is not a URL',
      text: `The MCP address reads “${url}”, which is not somewhere a flow can be sent. Fix mcpServerUrl in Settings.`,
    };
  }

  if (!isLoopback(url)) {
    return {
      title: `${host} is not this machine`,
      text: `Nothing answered at ${host}, and that address is not loopback — so it is not the server mcp.port describes, and nothing here can start it or check it for you. Only that host can say why it is quiet.`,
    };
  }

  const http = /^HTTP (\d+)/.exec(raw);
  if (http) {
    return {
      title: 'Something else is on that port',
      text: `${host} answered ${raw} instead of a health check, so whatever is listening there is not the MCP server. Change mcp.port, or stop the program holding it.`,
    };
  }

  if (/abort/i.test(raw)) {
    return {
      title: 'The server did not answer in time',
      text: `${host} took the connection and then said nothing before the check timed out. It may still be starting — check again in a moment — or raise mcp.healthTimeoutMs.`,
    };
  }

  return {
    title: 'Nothing is listening on that port',
    text: `${host} refused the connection, so no MCP server is running there. Open Claude Code, or run npx devflow-mcp-server install if this machine has never been set up, then check again. Sending now will fail.`,
  };
}

function targetFor(url: string, probe: SendProbe | null): SendTarget {
  if (probe === null) return { url, status: null, problem: null };

  switch (probe.kind) {
    case 'checking':
      return { url, status: 'Checking…', problem: null };
    case 'ok':
      // The Settings screen's wording, verbatim. One health check with two
      // readers should not have two ways of reporting the same success.
      return { url, status: `Connected · ${probe.service} (${probe.mode})`, problem: null };
    case 'failed':
      return { url, status: null, problem: problemFor(url, probe.detail) };
  }
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

  const credentials = credentialsIn(steps);

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
    credentials,
    target: input.target ? targetFor(input.target.url, input.target.probe) : null,
    /*
     * "And nothing else" is true about the *parts*, and it was the most
     * reassuring line in the dialog at the one moment it should not have been:
     * every switch off, and a recorded OAuth callback still carrying its grant
     * in the one thing no switch controls. So the bare note stops short of
     * reassurance whenever the URLs have something in them.
     */
    note: bare
      ? credentials
        ? 'Claude will get the steps and their URLs. Turning everything off does not strip the URLs — see below.'
        : 'Claude will get the steps and their URLs, and nothing else.'
      : null,
    canSend: steps.length > 0 && !busy,
    busy,
  };
}
