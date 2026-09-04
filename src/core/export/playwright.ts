/**
 * A recorded flow, compiled to a Playwright spec.
 *
 * The point of the compiler is that the reproduction a developer was handed as
 * prose becomes a thing that runs. That only holds if the file it writes is
 * *valid JavaScript whatever the page contained* — every value in it is text the
 * recorded page chose — so nothing here interpolates a string without going
 * through `literals.ts`, and nothing writes a comment without `commentText`.
 *
 * Pure, like everything under `src/core/`: steps in, source out.
 */

import type { Step } from '../../shared/types.js';
import { commentText, jsLiteral, jsonLiteral } from './literals.js';
import { planMocks } from './mocks.js';
import { FRAGILE_WARNING, resilientSelector } from './selectors.js';
import { STATE_PREAMBLE, hasState, stateComments } from './state.js';
import {
  ACTION_CEILING_MS,
  ACTION_FLOOR_MS,
  GAP_WORTH_STATING_MS,
  NAVIGATION_CEILING_MS,
  NAVIGATION_FLOOR_MS,
  gapsBefore,
  seconds,
  stepBudget,
  testBudget,
} from './timing.js';

const DEFAULT_TEST_NAME = 'DevFlow recorded flow';

/** What a generated spec does about the responses the recording captured. */
export interface PlaywrightOptions {
  /**
   * Serve the recorded responses (the default), or let the run talk to the app.
   *
   * Default true, because that is what this has always done and what a
   * one-click export from Flow review should keep doing: a spec somebody runs
   * on their laptop against a dev server they have not started should still
   * exercise the journey.
   *
   * False is what a CI regression check in `live` mode needs, and the two are
   * never blended — with mocks in place every status and latency the run sees
   * is the recording's own played back, so a wire comparison would be measuring
   * its own fixtures. `core/regression` refuses to compare the wire at all in
   * mocked mode for exactly this reason.
   */
  mocks?: boolean;
}

/**
 * How to run this file on a machine that has nothing on it.
 *
 * An exported spec leaves the browser and lands in a downloads folder, often on
 * somebody else's laptop — a QA engineer, a colleague reproducing a bug report,
 * the person who will fix it. Everything they need to go from that file to a
 * passing or failing run is four commands, and none of them are guessable from
 * a `.spec.ts` alone. So the file carries them.
 *
 * The commands name no filename on purpose. `npx playwright test` runs every
 * spec in the folder, which is right when the folder holds this one, and cannot
 * go stale when the file is renamed on the way out of the browser.
 */
function setupHeader(): string[] {
  return [
    `/*`,
    ` * Recorded with DevFlow and compiled to a Playwright test.`,
    ` *`,
    ` * ─────────────────────────────────────────────────────────────────────────`,
    ` *  RUNNING THIS, ON A COMPUTER WITH NOTHING SET UP`,
    ` * ─────────────────────────────────────────────────────────────────────────`,
    ` *`,
    ` *  1. Install Node.js 20 or newer — the LTS download at https://nodejs.org`,
    ` *`,
    ` *     Then open a terminal and check it took:`,
    ` *`,
    ` *         node --version`,
    ` *`,
    ` *  2. Put this file in a folder of its own, and go there:`,
    ` *`,
    ` *         mkdir devflow-replay`,
    ` *         cd devflow-replay`,
    ` *`,
    ` *     Move this .spec.ts file into that folder.`,
    ` *`,
    ` *  3. Install Playwright and the browsers it drives. Once, about two`,
    ` *     minutes, and most of that is the browser download:`,
    ` *`,
    ` *         npm init -y`,
    ` *         npm install --save-dev @playwright/test`,
    ` *         npx playwright install`,
    ` *`,
    ` *     On Linux, also run:  npx playwright install-deps`,
    ` *`,
    ` *     There is no TypeScript setup to do. Playwright compiles .spec.ts`,
    ` *     itself, so no tsconfig.json and no build step.`,
    ` *`,
    ` *  4. Run it:`,
    ` *`,
    ` *         npx playwright test`,
    ` *`,
    ` *     Watch it happen in a real browser window instead:`,
    ` *`,
    ` *         npx playwright test --headed`,
    ` *`,
    ` *     Or step through it one action at a time, which is what to reach for`,
    ` *     when a step fails and the reason is not obvious:`,
    ` *`,
    ` *         npx playwright test --debug`,
    ` *`,
    ` *  5. Read what happened — screenshots, the DOM at each step, the failure:`,
    ` *`,
    ` *         npx playwright show-report`,
    ` *`,
    ` * ─────────────────────────────────────────────────────────────────────────`,
    ` *  ABOUT THE WAITS`,
    ` * ─────────────────────────────────────────────────────────────────────────`,
    ` *`,
    ` *  Every action carries a timeout sized from the time that step actually`,
    ` *  took when it was recorded. Playwright waits for the element to be there`,
    ` *  and clickable, then proceeds immediately — so a generous timeout costs`,
    ` *  nothing on a step that works, and is only spent on one that does not.`,
    ` *`,
    ` *  There are no fixed sleeps here, deliberately. A sleep long enough to be`,
    ` *  reliable is longer than the step needs every other time, and a run that`,
    ` *  is mostly sleeping is a run nobody keeps in CI.`,
    ` *`,
    ` *  If a step still times out, the app is genuinely slower than it was when`,
    ` *  recorded, or the page changed and the selector no longer matches. The`,
    ` *  HTML report tells you which — it holds a screenshot from the moment it`,
    ` *  gave up.`,
    ` */`,
    ``,
  ];
}

export function generatePlaywrightTest(
  steps: Step[],
  testName = DEFAULT_TEST_NAME,
  options: PlaywrightOptions = {},
): string {
  const name = jsLiteral(commentText(testName) || DEFAULT_TEST_NAME);

  /*
   * An empty flow compiles to an empty test, not to an empty string.
   *
   * The old version returned `''`, which reaches the developer as a zero-byte
   * `.spec.ts` their runner reports as "no tests found" — a failure mode that
   * looks like a broken toolchain rather than a flow with nothing in it.
   */
  if (steps.length === 0) {
    return [
      ...setupHeader(),
      `import { test } from '@playwright/test';`,
      ``,
      `test(${name}, async () => {`,
      `  // This flow was exported with no steps, so there is nothing to replay.`,
      `});`,
      ``,
    ].join('\n');
  }

  const gaps = gapsBefore(steps);

  const testTimeout = testBudget(steps, gaps);

  const lines: string[] = [];
  lines.push(...setupHeader());
  lines.push(`import { test } from '@playwright/test';`);
  lines.push(``);
  lines.push(`test(${name}, async ({ page }) => {`);
  lines.push(`  // Long enough for every step below to spend its own timeout.`);
  lines.push(`  test.setTimeout(${testTimeout});`);
  lines.push(``);

  /*
   * An unmocked spec plans no mocks at all rather than planning them and
   * skipping the emit: `omitted` exists to tell a reader which recorded
   * responses were *not* turned into fixtures, and printing that list above a
   * spec that deliberately uses none of them would be a paragraph about a
   * decision nobody made.
   */
  const { mocks, omitted } =
    options.mocks === false ? { mocks: [], omitted: [] } : planMocks(steps);

  if (options.mocks === false) {
    lines.push(
      `  // Recorded responses are NOT served: this spec talks to whatever is running.`,
      `  // Statuses and latencies observed here are the application's own.`,
      `  //`,
      `  // The run collects its own wire, because nothing outside the browser can.`,
      `  // Without this a live comparison would hold the recording's calls against an`,
      `  // empty set and report every endpoint as never called, which is the most`,
      `  // confident possible way to be wrong.`,
      `  const __devflowCalls = [];`,
      `  page.on('response', (response) => {`,
      `    const request = response.request();`,
      `    const timing = request.timing();`,
      `    __devflowCalls.push({`,
      `      method: request.method(),`,
      `      url: response.url(),`,
      `      status: response.status(),`,
      `      durationMs: Math.max(0, Math.round(timing.responseEnd - timing.startTime)),`,
      `    });`,
      `  });`,
    );
  }

  if (mocks.length > 0 || omitted.length > 0) {
    lines.push(`  // --- Recorded responses ---`);
  }

  for (const mock of mocks) {
    /*
     * A predicate, not the recorded URL.
     *
     * `page.route(url)` reads a string as a glob, so `?`, `*` and `[` in a
     * recorded URL — which is to say the query string of almost any real one —
     * are pattern syntax, and the mock silently never matches. Comparing
     * `url.href` has no pattern semantics to get wrong. The method check inside
     * the handler is what keeps a GET and a POST to one URL two mocks.
     */
    lines.push(`  await page.route(`);
    lines.push(`    (url) => url.href === ${jsLiteral(mock.url)},`);
    lines.push(`    async (route, request) => {`);
    lines.push(`      if (request.method() !== ${jsLiteral(mock.method)}) return route.fallback();`);
    lines.push(`      await route.fulfill({`);
    lines.push(`        status: ${mock.status},`);
    if (Object.keys(mock.headers).length > 0) {
      lines.push(`        headers: ${jsonLiteral(mock.headers)},`);
    }
    lines.push(`        body: ${jsonLiteral(mock.body)},`);
    lines.push(`      });`);
    lines.push(`    },`);
    lines.push(`  );`);
  }

  for (const skip of omitted) {
    lines.push(`  // Not mocked — ${commentText(`${skip.method} ${skip.url}`)}:`);
    lines.push(`  //   ${commentText(skip.reason)}.`);
  }

  if (mocks.length > 0 || omitted.length > 0) lines.push(``);

  /*
   * Said once, before the flow, and only when there is state to explain.
   *
   * A spec for a recording that read no stores should not carry a paragraph
   * about why it carries no assertions for them — see `state.ts` for why the
   * assertions themselves are refused.
   */
  if (hasState(steps)) {
    lines.push(`  // --- State ---`);
    for (const line of STATE_PREAMBLE) lines.push(line ? `  // ${line}` : `  //`);
    lines.push(``);
  }

  lines.push(`  // --- Flow ---`);

  // The recorder does not always open with a navigation — a flow can start on
  // the page the user was already looking at — and a spec that starts clicking
  // before it has opened anything fails on `about:blank`.
  if (steps[0].type !== 'navigate' && steps[0].url) {
    lines.push(`  await page.goto(${jsLiteral(steps[0].url)}, { timeout: ${NAVIGATION_FLOOR_MS} });`);
  }

  steps.forEach((step, index) => {
    lines.push(`  // Step ${step.stepNumber ?? '?'}: ${commentText(step.action)}`);

    /*
     * The recorded gap, stated rather than slept.
     *
     * It is the one number a reader needs to judge whether a timeout below is
     * wrong, and it is the thing the exported spec used to throw away — a step
     * that took eleven seconds to become possible was emitted next to one that
     * took eighty milliseconds, with nothing to tell them apart.
     */
    if (gaps[index] >= GAP_WORTH_STATING_MS) {
      lines.push(`  // ${seconds(gaps[index])} after the previous step when recorded.`);
    }

    if (step.type === 'navigate') {
      const timeout = stepBudget(gaps[index], NAVIGATION_FLOOR_MS, NAVIGATION_CEILING_MS);
      lines.push(`  await page.goto(${jsLiteral(step.url)}, { timeout: ${timeout} });`);
      for (const line of stateComments(step)) lines.push(`  // ${line}`);
      return;
    }

    if (step.type === 'note') {
      lines.push(`  // Note: ${commentText(step.value)}`);
      for (const line of stateComments(step)) lines.push(`  // ${line}`);
      return;
    }

    const selector = resilientSelector(step.element);
    if (selector.note) lines.push(`  // ${selector.note}`);
    if (selector.fragile) lines.push(`  // ${FRAGILE_WARNING}`);

    /*
     * The timeout goes on the action, not into a `waitForSelector` before it.
     *
     * Playwright's actionability check is strictly stronger than a visibility
     * wait — it also holds out for the element to be enabled, stable and not
     * covered by something else — and it is checked against the element the
     * action will actually use, rather than against a second lookup that can
     * resolve differently a tick later. One statement, and the failure names
     * the step rather than a wait that preceded it.
     */
    const timeout = stepBudget(gaps[index], ACTION_FLOOR_MS, ACTION_CEILING_MS);

    if (step.type === 'click') {
      lines.push(`  await page.${selector.playwright}.click({ timeout: ${timeout} });`);
    } else {
      lines.push(
        `  await page.${selector.playwright}.fill(${jsLiteral(step.value)}, { timeout: ${timeout} });`,
      );
    }

    // After the action, not before it: this is what the interaction *did*, and
    // a recording only ever attaches it to a step that had one.
    for (const line of stateComments(step)) lines.push(`  // ${line}`);
  });

  if (options.mocks === false) {
    /*
     * The wire leaves as a Playwright *attachment* rather than as a file this
     * spec writes, and the reason is a rule about this module rather than a
     * preference. `core/` is bundled into `mcp-server/core.js` and
     * `tests/react-server-guard.test.ts` asserts that the bundle contains no
     * filesystem access at all — a generated string holding `node:fs` trips it,
     * and rightly: the way that guard stops being useful is somebody deciding
     * their occurrence is the harmless one.
     *
     * Attaching is better on the merits too. Playwright writes the body itself
     * and records the path in the JSON report the runner already parses, so
     * there is one artefact per run instead of a file beside the spec that
     * nothing cleans up, and no path built out of `test.info().file`.
     */
    lines.push(``);
    lines.push(`  await test.info().attach('devflow-calls', {`);
    lines.push(`    body: JSON.stringify(__devflowCalls),`);
    lines.push(`    contentType: 'application/json',`);
    lines.push(`  });`);
  }

  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}
