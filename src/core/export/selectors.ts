import type { ElementRef } from '../../shared/types.js';

export interface Selector {
  /** The string used in Playwright page.locator() or page.getBy... */
  playwright: string;
  /** The string used in Cypress cy.get() or cy.contains() */
  cypress: string;
  /** Whether the selector is considered fragile (e.g., a raw CSS path) */
  fragile: boolean;
  /** Notes about the selector (e.g., component name) */
  note?: string;
}

/**
 * Generates resilient selectors based on the fallback hierarchy:
 * aria-label -> role+name -> data-testid -> cssSelector
 */
export function generateSelector(element: ElementRef): Selector {
  const note = element.react?.owner ? `React Component: ${element.react.owner}` : undefined;

  // 1. Aria Label
  if (element.ariaLabel) {
    return {
      playwright: `getByLabel('${escapeQuotes(element.ariaLabel)}')`,
      cypress: `get('[aria-label="${escapeQuotes(element.ariaLabel)}"]')`,
      fragile: false,
      note
    };
  }

  // 2. Role + Name
  if (element.role && element.text) {
    const safeName = escapeQuotes(element.text.trim());
    return {
      playwright: `getByRole('${element.role}', { name: '${safeName}' })`,
      cypress: `contains('${element.role}', '${safeName}')`, // Cypress doesn't have exact getByRole natively without testing-library
      fragile: false,
      note
    };
  }

  // 3. Fallback to just text if it's a button or link
  if (element.text && (element.tag === 'button' || element.tag === 'a')) {
    const safeName = escapeQuotes(element.text.trim());
    return {
      playwright: `getByText('${safeName}')`,
      cypress: `contains('${safeName}')`,
      fragile: false,
      note
    };
  }

  // 4. CSS Selector (Fragile)
  return {
    playwright: `locator('${escapeQuotes(element.cssSelector)}')`,
    cypress: `get('${escapeQuotes(element.cssSelector)}')`,
    fragile: true,
    note
  };
}

function escapeQuotes(str: string): string {
  return str.replace(/'/g, "\\'").replace(/\n/g, ' ');
}
