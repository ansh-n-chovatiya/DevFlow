/**
 * Which recorded responses a compiled test can actually replay, and why the
 * rest cannot.
 *
 * Both generators used to carry their own copy of this walk, and both copies
 * filtered `call.method === 'GET'` — which drops the POST that submitted the
 * order and the DELETE that emptied the basket, the two calls a checkout bug is
 * usually about. `cypress.ts` then emitted `cy.intercept('${call.method}', …)`
 * as though every method were supported, which is what makes it a bug rather
 * than a decision: the code downstream already believed the filter was not
 * there.
 *
 * The other half of the job is saying *nothing* rather than saying something
 * false. A response body that was cut at the capture cap is not JSON any more,
 * and a mock built from it fails the generated test somewhere the developer
 * cannot see the cause. Those calls come back as `omitted`, and the generators
 * print the reason where the mock would have been.
 */

import type { NetworkCall, Step } from '../../shared/types.js';

/** A recorded response complete enough to stand in for the real one. */
export interface FlowMock {
  method: string;
  url: string;
  status: number;
  headers: Record<string, string>;
  body: string;
}

/** A recorded call the generated script deliberately does not mock. */
export interface OmittedMock {
  method: string;
  url: string;
  /** Written into the script, as a sentence, so nothing is dropped in silence. */
  reason: string;
}

export interface MockPlan {
  mocks: FlowMock[];
  omitted: OmittedMock[];
}

/**
 * Method and URL together, because they are two different mocks.
 *
 * The old dedup keyed on the URL alone, so a `GET /cart` recorded before the
 * `POST /cart` that changed it kept the first response and threw the second
 * away — the one interaction the test was recorded to reproduce.
 */
function key(call: NetworkCall): string {
  return `${call.method} ${call.url}`;
}

/**
 * Headers that described the *transfer*, not the response.
 *
 * A recorded `content-encoding: gzip` or a `content-length` measured against
 * the compressed bytes is a lie about the body the mock is about to serve, and
 * both Playwright and Cypress hand it to the page unchanged — so the fetch
 * fails inside the app, several frames from anything the developer is looking
 * at. The header the mock does need, `content-type`, is not in this list.
 */
const TRANSFER_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding']);

function replayableHeaders(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!TRANSFER_HEADERS.has(name.toLowerCase())) kept[name] = value;
  }
  return kept;
}

function omission(call: NetworkCall): string | null {
  if (call.status === null) {
    return 'the request never completed, so there is no response to replay';
  }
  if (call.responseBodyTruncated) {
    const size = call.responseBodyBytes;
    return `the recorded body was cut at the capture cap${size ? ` (${size} characters)` : ''}, and a truncated body is not the response the page received`;
  }
  if (call.responseBody === null) {
    return 'no response body was recorded for this call';
  }
  return null;
}

/**
 * Every distinct call in the flow, sorted into what can be replayed and what
 * cannot. Order follows the recording, so the script reads in the order the
 * page made the requests.
 */
export function planMocks(steps: Step[]): MockPlan {
  const mocks: FlowMock[] = [];
  const omitted: OmittedMock[] = [];
  const seen = new Set<string>();

  for (const step of steps) {
    for (const call of step.networkCalls ?? []) {
      const id = key(call);
      if (seen.has(id)) continue;
      seen.add(id);

      const reason = omission(call);
      if (reason !== null) {
        omitted.push({ method: call.method, url: call.url, reason });
        continue;
      }

      mocks.push({
        method: call.method,
        url: call.url,
        status: call.status as number,
        headers: replayableHeaders(call.responseHeaders),
        body: call.responseBody as string,
      });
    }
  }

  return { mocks, omitted };
}
