import type { Step, NetworkCall } from '../../shared/types.js';
import { generateSelector } from './selectors.js';

/**
 * Compiles a recorded flow into a Playwright test script.
 * 
 * Features:
 * - Resilient selectors via `generateSelector`
 * - Automatic network mocking via `page.route`
 */
export function generatePlaywrightTest(steps: Step[], testName = 'DevFlow Recorded Test'): string {
  if (steps.length === 0) return '';

  const lines: string[] = [];
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push(``);
  lines.push(`test('${escapeQuotes(testName)}', async ({ page }) => {`);

  // Gather all network mocks across all steps
  const networkMocks = gatherNetworkMocks(steps);
  if (networkMocks.length > 0) {
    lines.push(`  // --- Network Mocks ---`);
    for (const call of networkMocks) {
      if (call.status && call.responseBody) {
        // Strip origin from URL for mocking if it's absolute, or keep as is
        const url = escapeQuotes(call.url);
        lines.push(`  await page.route('${url}', async route => {`);
        lines.push(`    await route.fulfill({`);
        lines.push(`      status: ${call.status},`);
        if (Object.keys(call.responseHeaders).length > 0) {
          lines.push(`      headers: ${JSON.stringify(call.responseHeaders)},`);
        }
        lines.push(`      body: ${JSON.stringify(call.responseBody)}`);
        lines.push(`    });`);
        lines.push(`  });`);
      }
    }
    lines.push(``);
  }

  // Generate actions
  lines.push(`  // --- Flow Actions ---`);
  
  // Always start with navigation if the first step isn't explicitly a navigate step
  if (steps[0].type !== 'navigate') {
    lines.push(`  await page.goto('${escapeQuotes(steps[0].url)}');`);
  }

  for (const step of steps) {
    lines.push(`  // Step ${step.stepNumber || '?'}: ${escapeQuotes(step.action)}`);
    
    if (step.type === 'navigate') {
      lines.push(`  await page.goto('${escapeQuotes(step.url)}');`);
    } else if (step.type === 'click' && step.element) {
      const sel = generateSelector(step.element);
      if (sel.note) lines.push(`  // ${sel.note}`);
      lines.push(`  await page.${sel.playwright}.click();`);
    } else if (step.type === 'input' && step.element) {
      const sel = generateSelector(step.element);
      if (sel.note) lines.push(`  // ${sel.note}`);
      lines.push(`  await page.${sel.playwright}.fill('${escapeQuotes(step.value || '')}');`);
    } else if (step.type === 'note') {
      lines.push(`  // Note: ${escapeQuotes(step.value || '')}`);
    }
  }

  lines.push(`});`);
  lines.push(``);

  return lines.join('\n');
}

function gatherNetworkMocks(steps: Step[]): NetworkCall[] {
  const mocks: NetworkCall[] = [];
  const seenUrls = new Set<string>();

  for (const step of steps) {
    for (const call of step.networkCalls || []) {
      if (call.method === 'GET' && !seenUrls.has(call.url)) {
        seenUrls.add(call.url);
        mocks.push(call);
      }
    }
  }
  
  return mocks;
}

function escapeQuotes(str: string): string {
  return str.replace(/'/g, "\\'").replace(/\n/g, ' ');
}
