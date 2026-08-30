/**
 * The three shapes a flow can leave in.
 *
 * Here rather than beside the dialog because both the dialog and the writer need
 * them, and the writer must not depend on the UI to know what a `.zip` is called.
 */

export type ExportFormat = 'zip' | 'markdown' | 'json' | 'playwright' | 'cypress';

export const EXTENSION: Record<ExportFormat, string> = {
  zip: '.zip',
  markdown: '.md',
  json: '.json',
  playwright: '.spec.ts',
  cypress: '.cy.ts',
};

export const FORMAT_NAME: Record<ExportFormat, string> = {
  zip: 'ZIP',
  markdown: 'Markdown',
  json: 'JSON',
  playwright: 'Playwright',
  cypress: 'Cypress',
};
