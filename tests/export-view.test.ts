import { describe, expect, it } from 'vitest';
import type { FlowReact, NetworkCall, Step } from '../src/shared/types.js';
import { deriveExportView, measure, type ExportInput } from '../src/ui/viewer/export-view.js';

/** 300 base64 characters — 224 bytes decoded, once the header is discounted. */
const IMAGE = `data:image/jpeg;base64,${'A'.repeat(300)}`;

const call = (over: Partial<NetworkCall> = {}): NetworkCall => ({
  method: 'POST',
  url: 'https://example.com/api',
  requestHeaders: { 'content-type': 'application/json' },
  requestBody: '{"a":1}',
  status: 200,
  responseHeaders: {},
  responseBody: '{"b":2}',
  durationMs: 40,
  timestamp: 0,
  ...over,
});

const step = (over: Partial<Step> = {}): Step =>
  ({
    type: 'click',
    url: 'https://example.com/',
    timestamp: 0,
    action: 'Clicked "Save"',
    element: { tag: 'button', cssSelector: '#save', xpath: '/button', boundingBox: null },
    ...over,
  }) as Step;

function input(over: Partial<ExportInput> = {}): ExportInput {
  return {
    steps: [step({ screenshot: IMAGE, networkCalls: [call()] })],
    format: 'zip',
    options: { images: true, network: true, logs: true, react: true },
    filename: 'flowsnap-example-com-2026-08-15',
    busy: false,
    progress: null,
    ...over,
  };
}

describe('measure', () => {
  it('counts a screenshot at its decoded size, and again at its embedded size', () => {
    // A ZIP entry costs the decoded bytes; Markdown pastes the data URL in as
    // text and pays for every character of it. The dialog has to say both,
    // because that difference is why one format is 4 MB and the other is 5.8.
    const parts = measure([step({ screenshot: IMAGE })]);

    expect(parts.screenshots).toBe(225);
    expect(parts.screenshotsInline).toBe(IMAGE.length);
    expect(parts.screenshotsInline).toBeGreaterThan(parts.screenshots);
  });

  it('does not count the un-annotated original, which never leaves the extension', () => {
    const withOriginal = measure([step({ screenshot: IMAGE, screenshotOriginal: IMAGE })]);
    const without = measure([step({ screenshot: IMAGE })]);

    expect(withOriginal.base).toBe(without.base);
  });

  it('separates the parts a checkbox can remove', () => {
    const parts = measure([
      step({ networkCalls: [call()], consoleLogs: [{ level: 'log', args: ['x'], timestamp: 0 }] }),
    ]);

    expect(parts.network).toBeGreaterThan(0);
    expect(parts.logs).toBeGreaterThan(0);
    expect(parts.screenshots).toBe(0);
  });
});

describe('the total', () => {
  it('falls when a part is unchecked', () => {
    const all = deriveExportView(input()).total;
    const noImages = deriveExportView(
      input({ options: { images: false, network: true, logs: true, react: true } }),
    ).total;
    const nothing = deriveExportView(
      input({ options: { images: false, network: false, logs: false, react: false } }),
    ).total;

    expect(noImages).toBeLessThan(all);
    expect(nothing).toBeLessThan(noImages);
  });

  it('tracks the chosen format', () => {
    const zip = deriveExportView(input({ format: 'zip' })).total;
    const markdown = deriveExportView(input({ format: 'markdown' })).total;
    const json = deriveExportView(input({ format: 'json' })).total;

    // JSON carries no image data at all, so it is the smallest of the three.
    expect(json).toBeLessThan(zip);
    expect(json).toBeLessThan(markdown);
  });

  it('quotes every format at once, not just the selected one', () => {
    const view = deriveExportView(input());
    expect(view.formats.map((card) => card.id)).toEqual(['zip', 'markdown', 'json']);
    expect(view.formats.every((card) => card.bytes > 0)).toBe(true);
    expect(view.formats.find((card) => card.selected)?.id).toBe('zip');
    expect(view.formats.find((card) => card.recommended)?.id).toBe('zip');
  });
});

describe('include rows', () => {
  it('says when the chosen format ignores one, rather than letting it do nothing', () => {
    // `exportToJSON` writes a placeholder for every screenshot unless the ZIP
    // hands it filenames, so the checkbox genuinely has no effect there. A
    // checkbox that moves nothing is how a user learns to distrust the numbers.
    const view = deriveExportView(input({ format: 'json' }));
    const images = view.includes.find((row) => row.id === 'images');

    expect(images?.ignored).not.toBeNull();

    const checked = deriveExportView(
      input({ format: 'json', options: { images: true, network: true, logs: true, react: true } }),
    ).total;
    const unchecked = deriveExportView(
      input({ format: 'json', options: { images: false, network: true, logs: true, react: true } }),
    ).total;
    expect(checked).toBe(unchecked);
  });

  it('leaves network and console live in every format', () => {
    for (const format of ['zip', 'markdown', 'json'] as const) {
      const view = deriveExportView(input({ format }));
      expect(view.includes.find((row) => row.id === 'network')?.ignored).toBeNull();
      expect(view.includes.find((row) => row.id === 'logs')?.ignored).toBeNull();
    }
  });
});

describe('the redaction warning', () => {
  it('appears exactly when captured bodies are about to be written', () => {
    // Headers are redacted at capture; bodies are not. The moment that matters
    // is this one, not a settings page nobody opened.
    expect(deriveExportView(input()).warnBodies).toBe(true);
    expect(
      deriveExportView(input({ options: { images: true, network: false, logs: true, react: true } })).warnBodies,
    ).toBe(false);
    // Nothing to warn about when the flow captured no network at all.
    expect(deriveExportView(input({ steps: [step()] })).warnBodies).toBe(false);
  });
});

describe('the filename', () => {
  it('strips what no filesystem will take', () => {
    expect(deriveExportView(input({ filename: 'my:flow/2026' })).filename).toBe('myflow2026');
  });

  it('falls back rather than producing a file called ".zip"', () => {
    expect(deriveExportView(input({ filename: '   ' })).filename).toMatch(/^flowsnap-flow-/);
    expect(deriveExportView(input({ filename: '///' })).filename).toBe('flowsnap-flow');
  });

  it('carries the extension the format requires', () => {
    expect(deriveExportView(input({ format: 'zip' })).extension).toBe('.zip');
    expect(deriveExportView(input({ format: 'markdown' })).extension).toBe('.md');
    expect(deriveExportView(input({ format: 'json' })).extension).toBe('.json');
  });
});

describe('while it is running', () => {
  it('will not start a second export, and says which image it is on', () => {
    const view = deriveExportView(input({ busy: true, progress: { done: 12, total: 18 } }));

    expect(view.canExport).toBe(false);
    expect(view.caption).toBe('Packaging screenshot 12 of 18');
  });

  it('refuses to export an empty flow', () => {
    expect(deriveExportView(input({ steps: [] })).canExport).toBe(false);
  });
});

/**
 * React is a part of a flow like any other, and is priced like one.
 *
 * The component ids live inside the step objects rather than beside them, so
 * without this they would be counted as step text and the checkbox would move
 * a total that never changed — which is how a user learns to distrust the
 * numbers, and the reason the ignored-format note exists two describes above.
 */
describe('the React row', () => {
  const table: FlowReact = {
    detected: true,
    components: {
      cart: {
        name: 'Cart',
        status: 'resolved',
        source: 'src/components/Cart.tsx',
        line: 34,
      },
    },
  };

  const attributed = [
    step({ element: { tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null, react: { chain: ['cart'] } } }),
  ];

  it('sits beside the other parts of a recording', () => {
    const rows = deriveExportView(input()).includes.map((row) => row.id);
    expect(rows).toEqual(['images', 'network', 'logs', 'react']);
  });

  it('costs what the ids and the table together weigh', () => {
    const view = deriveExportView(input({ steps: attributed, react: table }));
    const row = view.includes.find((one) => one.id === 'react');

    expect(row?.bytes).toBeGreaterThan(0);
    // The path is in the table, so the table is most of it.
    expect(row?.bytes).toBeGreaterThan(JSON.stringify(table.components.cart).length);
  });

  it('moves the total when it is unchecked, in every format', () => {
    for (const format of ['zip', 'markdown', 'json'] as const) {
      const on = deriveExportView(input({ steps: attributed, react: table, format })).total;
      const off = deriveExportView(
        input({
          steps: attributed,
          react: table,
          format,
          options: { images: true, network: true, logs: true, react: false },
        }),
      ).total;

      expect(off).toBeLessThan(on);
    }
  });

  it('says so rather than offering a switch over nothing', () => {
    // The flow in `input()` was not recorded on a React page.
    expect(deriveExportView(input()).includes.find((row) => row.id === 'react')?.ignored)
      .not.toBeNull();
  });
});

/**
 * The progress caption is written in two places: derived here, and typed out by
 * hand in `export-dialog.ts`'s `paintProgress`, which exists to avoid paying for
 * this whole derivation once per packed screenshot. If the wording here moves,
 * that one has to move with it.
 */
describe('the progress caption', () => {
  it('matches the string the dialog paints directly', () => {
    const view = deriveExportView({
      steps: [{ type: 'click', url: 'https://x/', timestamp: 1 } as never],
      options: { images: true, network: false, logs: false, react: false },
      react: undefined,
      busy: true,
      filename: 'flow',
      progress: { done: 12, total: 200 },
    } as never);

    expect(view.caption).toBe('Packaging screenshot 12 of 200');
  });
});
