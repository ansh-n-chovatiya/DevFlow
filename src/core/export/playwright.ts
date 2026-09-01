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

const DEFAULT_TEST_NAME = 'DevFlow recorded flow';

export function generatePlaywrightTest(steps: Step[], testName = DEFAULT_TEST_NAME): string {
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
      `import { test } from '@playwright/test';`,
      ``,
      `test(${name}, async () => {`,
      `  // This flow was exported with no steps, so there is nothing to replay.`,
      `});`,
      ``,
    ].join('\n');
  }

  const lines: string[] = [];
  lines.push(`import { test } from '@playwright/test';`);
  lines.push(``);
  lines.push(`test(${name}, async ({ page }) => {`);

  const { mocks, omitted } = planMocks(steps);

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
    lines.push(`  await page.goto(${jsLiteral(steps[0].url)});`);
  }

  for (const step of steps) {
    lines.push(`  // Step ${step.stepNumber ?? '?'}: ${commentText(step.action)}`);

    if (step.type === 'navigate') {
      lines.push(`  await page.goto(${jsLiteral(step.url)});`);
      for (const line of stateComments(step)) lines.push(`  // ${line}`);
      continue;
    }

    if (step.type === 'note') {
      lines.push(`  // Note: ${commentText(step.value)}`);
      for (const line of stateComments(step)) lines.push(`  // ${line}`);
      continue;
    }

    const selector = resilientSelector(step.element);
    if (selector.note) lines.push(`  // ${selector.note}`);
    if (selector.fragile) lines.push(`  // ${FRAGILE_WARNING}`);

    if (step.type === 'click') {
      lines.push(`  await page.${selector.playwright}.click();`);
    } else {
      lines.push(`  await page.${selector.playwright}.fill(${jsLiteral(step.value)});`);
    }

    // After the action, not before it: this is what the interaction *did*, and
    // a recording only ever attaches it to a step that had one.
    for (const line of stateComments(step)) lines.push(`  // ${line}`);
  }

  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}
