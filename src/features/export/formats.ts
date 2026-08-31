/**
 * The shapes a flow can leave in.
 *
 * Here rather than beside the dialog because both the dialog and the writer need
 * them, and the writer must not depend on the UI to know what a `.zip` is called.
 *
 * The last two are not documents at all — they are the recording compiled to a
 * runnable spec. They sit in the same table because everything downstream of the
 * choice (the extension, the name, the size estimate, the download) is the same
 * mechanism, and a second export path beside this one is how the ZIP grew an
 * image-naming scheme the other two never got.
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
