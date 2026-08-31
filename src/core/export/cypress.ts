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

const DEFAULT_TEST_NAME = 'DevFlow recorded flow';

export function generateCypressTest(steps: Step[], testName = DEFAULT_TEST_NAME): string {
  const name = jsLiteral(commentText(testName) || DEFAULT_TEST_NAME);
  const lines: string[] = [];

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

  lines.push(`    // --- Flow ---`);

  if (steps[0].type !== 'navigate' && steps[0].url) {
    lines.push(`    cy.visit(${jsLiteral(steps[0].url)});`);
  }

  for (const step of steps) {
    lines.push(`    // Step ${step.stepNumber ?? '?'}: ${commentText(step.action)}`);

    if (step.type === 'navigate') {
      lines.push(`    cy.visit(${jsLiteral(step.url)});`);
      continue;
    }

    if (step.type === 'note') {
      lines.push(`    // Note: ${commentText(step.value)}`);
      continue;
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
  }

  lines.push(`  });`);
  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}
