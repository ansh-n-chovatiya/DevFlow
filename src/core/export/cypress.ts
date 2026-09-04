/**
 * A recorded flow, compiled to a Cypress spec.
 *
 * The Playwright generator's twin, and deliberately its mirror image line for
 * line: the two differ only where the runners differ, so a fix to the selector
 * hierarchy or the mock plan lands on both without being written twice. The
 * escaping and the mock decisions themselves live in `literals.ts` and
 * `mocks.ts` for the same reason.
 *
 * Pure, like everything under `src/core/`: steps in, source out.
 */

import type { Step } from '../../shared/types.js';
import { commentText, exactUrlRegex, jsLiteral, jsonLiteral } from './literals.js';
import { planMocks } from './mocks.js';
import { FRAGILE_WARNING, resilientSelector } from './selectors.js';
import { STATE_PREAMBLE, hasState, stateComments } from './state.js';
import {
  ACTION_FLOOR_MS,
  GAP_WORTH_STATING_MS,
  NAVIGATION_FLOOR_MS,
  budgetFor,
  gapsBefore,
  seconds,
} from './timing.js';

const DEFAULT_TEST_NAME = 'DevFlow recorded flow';

/**
 * How to run this file on a machine that has nothing on it.
 *
 * Playwright's generator carries the same block for the same reason: an
 * exported spec leaves the browser and lands in a downloads folder, often on
 * somebody else's laptop, and everything between that file and a run is a
 * handful of commands none of which are guessable from a `.cy.ts` alone.
 */
function setupHeader(): string[] {
  return [
    `/*`,
    ` * Recorded with DevFlow and compiled to a Cypress test.`,
    ` *`,
    ` * \u2500\u2500\u2500 RUNNING THIS, ON A COMPUTER WITH NOTHING SET UP \u2500\u2500\u2500`,
    ` *`,
    ` *  1. Install Node.js 20 or newer \u2014 the LTS download at https://nodejs.org`,
    ` *     Then check it took:  node --version`,
    ` *`,
    ` *  2. Put this file in a folder of its own, and go there:`,
    ` *`,
    ` *         mkdir devflow-replay`,
    ` *         cd devflow-replay`,
    ` *         mkdir -p cypress/e2e`,
    ` *`,
    ` *     Move this spec into cypress/e2e/.`,
    ` *`,
    ` *  3. Install Cypress. Once, and most of it is the download:`,
    ` *`,
    ` *         npm init -y`,
    ` *         npm install --save-dev cypress`,
    ` *`,
    ` *  4. Run it:`,
    ` *`,
    ` *         npx cypress run`,
    ` *`,
    ` *     Or watch it in a real browser, which is what to reach for when a`,
    ` *     step fails and the reason is not obvious:`,
    ` *`,
    ` *         npx cypress open`,
    ` *`,
    ` *  Cypress writes cypress.config.js on first run, and screenshots of any`,
    ` *  failure into cypress/screenshots/.`,
    ` *`,
    ` * \u2500\u2500\u2500 ABOUT THE WAITS \u2500\u2500\u2500`,
    ` *`,
    ` *  The timeouts below are sized from the time these steps actually took`,
    ` *  when they were recorded. Cypress retries until the element is there,`,
    ` *  then proceeds \u2014 so a generous timeout costs nothing on a step that`,
    ` *  works, and is only spent on one that does not.`,
    ` *`,
    ` *  There are no cy.wait(number) calls here, deliberately. A sleep long`,
    ` *  enough to be reliable is longer than the step needs every other time.`,
    ` */`,
    ``,
  ];
}

export function generateCypressTest(steps: Step[], testName = DEFAULT_TEST_NAME): string {
  const name = jsLiteral(commentText(testName) || DEFAULT_TEST_NAME);
  const lines: string[] = [];

  lines.push(...setupHeader());
  lines.push(`describe(${jsLiteral(DEFAULT_TEST_NAME)}, () => {`);
  lines.push(`  it(${name}, () => {`);

  /*
   * An empty flow compiles to an empty test, not to an empty string — a
   * zero-byte spec reads as a broken toolchain rather than as a flow with
   * nothing in it.
   */
  if (steps.length === 0) {
    lines.push(`    // This flow was exported with no steps, so there is nothing to replay.`);
    lines.push(`  });`);
    lines.push(`});`);
    lines.push(``);
    return lines.join('\n');
  }

  const gaps = gapsBefore(steps);

  /*
   * Cypress takes its waits as configuration, not as an argument per action.
   *
   * `defaultCommandTimeout` governs the query that finds the element, which is
   * the wait that matters and the one an option on `.click()` does not extend.
   * There is one knob and it is spec-wide, so each gets the widest budget any
   * step of its kind earned rather than a per-step number it has nowhere to
   * put. Per-step timings are still stated in the comments below, and a longer
   * setting is only ever spent on a step that fails.
   *
   * The two are counted separately because `pageLoadTimeout` is spent per page
   * load, not per test: handing it the sum of every step would let one hung
   * navigation consume the time the rest of the flow was going to need.
   */
  const widest = (kind: 'navigate' | 'action', floor: number): number =>
    steps.reduce(
      (most, step, index) =>
        (step.type === 'navigate') === (kind === 'navigate')
          ? Math.max(most, budgetFor(step, gaps[index]))
          : most,
      floor,
    );

  lines.push(`    Cypress.config('defaultCommandTimeout', ${widest('action', ACTION_FLOOR_MS)});`);
  lines.push(`    Cypress.config('pageLoadTimeout', ${widest('navigate', NAVIGATION_FLOOR_MS)});`);
  lines.push(``);

  const { mocks, omitted } = planMocks(steps);

  if (mocks.length > 0 || omitted.length > 0) {
    lines.push(`    // --- Recorded responses ---`);
  }

  for (const mock of mocks) {
    // An anchored RegExp rather than the recorded URL: a url string here is
    // glob-matched, so a query string's `?` and `[` are pattern syntax and the
    // intercept quietly matches nothing.
    lines.push(`    cy.intercept(${jsLiteral(mock.method)}, ${exactUrlRegex(mock.url)}, {`);
    lines.push(`      statusCode: ${mock.status},`);
    if (Object.keys(mock.headers).length > 0) {
      lines.push(`      headers: ${jsonLiteral(mock.headers)},`);
    }
    lines.push(`      body: ${jsonLiteral(mock.body)},`);
    lines.push(`    });`);
  }

  for (const skip of omitted) {
    lines.push(`    // Not mocked — ${commentText(`${skip.method} ${skip.url}`)}:`);
    lines.push(`    //   ${commentText(skip.reason)}.`);
  }

  if (mocks.length > 0 || omitted.length > 0) lines.push(``);

  // The Playwright generator's block, two spaces further in — see there for why
  // it is said once and only when there is state to explain.
  if (hasState(steps)) {
    lines.push(`    // --- State ---`);
    for (const line of STATE_PREAMBLE) lines.push(line ? `    // ${line}` : `    //`);
    lines.push(``);
  }

  lines.push(`    // --- Flow ---`);

  if (steps[0].type !== 'navigate' && steps[0].url) {
    lines.push(`    cy.visit(${jsLiteral(steps[0].url)});`);
  }

  steps.forEach((step, index) => {
    lines.push(`    // Step ${step.stepNumber ?? '?'}: ${commentText(step.action)}`);

    // The one number a reader needs to judge whether the setting above is
    // wrong, and the thing this generator used to throw away.
    if (gaps[index] >= GAP_WORTH_STATING_MS) {
      lines.push(`    // ${seconds(gaps[index])} after the previous step when recorded.`);
    }

    if (step.type === 'navigate') {
      lines.push(`    cy.visit(${jsLiteral(step.url)});`);
      for (const line of stateComments(step)) lines.push(`    // ${line}`);
      return;
    }

    if (step.type === 'note') {
      lines.push(`    // Note: ${commentText(step.value)}`);
      for (const line of stateComments(step)) lines.push(`    // ${line}`);
      return;
    }

    const selector = resilientSelector(step.element);
    if (selector.note) lines.push(`    // ${selector.note}`);
    if (selector.fragile) lines.push(`    // ${FRAGILE_WARNING}`);

    if (step.type === 'click') {
      lines.push(`    cy.${selector.cypress}.click();`);
    } else if (step.value === '') {
      // `cy.type('')` throws rather than clearing the field, so the one step
      // that empties an input would fail the whole spec on its own runner.
      lines.push(`    cy.${selector.cypress}.clear();`);
    } else {
      lines.push(`    cy.${selector.cypress}.type(${jsLiteral(step.value)});`);
    }

    // After the action, for the Playwright generator's reason.
    for (const line of stateComments(step)) lines.push(`    // ${line}`);
  });

  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}
