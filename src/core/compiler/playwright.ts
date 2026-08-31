import { FlowPayload, Step } from '../../shared/types.js';

export function compileToPlaywright(flow: FlowPayload): string {
  const lines: string[] = [];
  
  lines.push(`import { test, expect } from '@playwright/test';`);
  lines.push(``);
  lines.push(`test('Replay Flow: ${flow.name}', async ({ page }) => {`);
  
  if (flow.startUrl) {
    lines.push(`  await page.goto('${flow.startUrl}');`);
  }
  
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    lines.push(`  // Step ${i + 1}: ${step.action}`);
    
    if (step.type === 'click' && step.element) {
      const selector = getBestSelector(step.element);
      lines.push(`  await page.locator('${selector}').click();`);
    } else if (step.type === 'input' && step.element) {
      const selector = getBestSelector(step.element);
      lines.push(`  await page.locator('${selector}').fill('${escapeString(step.value || '')}');`);
    } else if (step.type === 'navigate') {
      lines.push(`  await page.goto('${step.url}');`);
    }
    
    if (step.networkCalls && step.networkCalls.length > 0) {
      lines.push(`  // Recorded ${step.networkCalls.length} network calls in this step`);
      // Future: Generate fixtures here
    }
  }
  
  lines.push(`});`);
  return lines.join('\n');
}

function getBestSelector(element: any): string {
  // Fiber-based resilient selectors priority as per Phase 2.1 specs
  if (element.ariaLabel) {
    return \`[aria-label="\${element.ariaLabel}"]\`;
  }
  if (element.cssSelector && element.cssSelector.includes('data-testid')) {
    return element.cssSelector;
  }
  if (element.text) {
    return \`text="\${element.text}"\`;
  }
  return element.cssSelector || element.xpath || '*';
}

function escapeString(str: string): string {
  return str.replace(/'/g, "\\'").replace(/\n/g, '\\n');
}
