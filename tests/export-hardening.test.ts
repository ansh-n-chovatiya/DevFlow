/**
 * The document has to survive the page it describes.
 *
 * Everything a step carries — its action, the value that was typed, a response
 * body, a console message — is text the recorded page chose. Interpolated into
 * Markdown unescaped, that text stops being *content* and becomes *structure*: a
 * fence closes the block it was pasted into, a newline starts a heading for a
 * step nobody performed. These are the assertions that keep page text as page
 * text, and they read the output the way a Markdown parser would rather than
 * grepping for substrings, because a substring cannot tell the two apart.
 */

import { describe, expect, it } from 'vitest';
import { exportToJSON } from '../src/core/export/json.js';
import { exportToMarkdown } from '../src/core/export/markdown.js';
import { CAPPED_ID } from '../src/core/react/table.js';
import type { ComponentSource, FlowReact, NetworkCall, Step } from '../src/shared/types.js';

const click = (over: Partial<Step> = {}): Step =>
  ({
    type: 'click',
    url: 'https://app.example.com/orders',
    timestamp: 1_000,
    action: 'Clicked "Save"',
    element: {
      tag: 'button',
      cssSelector: '#save',
      xpath: '/html[1]/body[1]/button[1]',
      boundingBox: null,
    },
    ...over,
  }) as Step;

const call = (over: Partial<NetworkCall> = {}): NetworkCall => ({
  method: 'POST',
  url: 'https://api.example.com/v2/submit',
  requestHeaders: {},
  requestBody: null,
  status: 200,
  responseHeaders: {},
  responseBody: null,
  durationMs: 12,
  timestamp: 1,
  ...over,
});

const react = (components: Record<string, ComponentSource>): FlowReact => ({
  detected: true,
  build: 'production',
  components,
});

/**
 * Which lines a Markdown reader sees as code, walked the way a parser walks it:
 * a run of three or more backticks opens a block, and only a run at least as
 * long — with nothing after it — closes one again.
 */
function fenced(md: string): boolean[] {
  let open: number | null = null;

  return md.split('\n').map((line) => {
    const match = /^ {0,3}(`{3,})(.*)$/.exec(line);

    if (open === null) {
      if (match && !match[2].includes('`')) {
        open = match[1].length;
        return true;
      }
      return false;
    }

    if (match && match[1].length >= open && match[2].trim() === '') {
      open = null;
      return true;
    }
    return true;
  });
}

/** Every heading the document actually renders — code blocks excluded. */
function headings(md: string): string[] {
  const code = fenced(md);
  return md.split('\n').filter((line, i) => !code[i] && line.startsWith('### '));
}

/** True when every fence the document opened was closed again. */
function balanced(md: string): boolean {
  const code = fenced(md);
  return code.length === 0 || code[code.length - 1] === false || !md.endsWith('\n');
}

describe('a response body cannot escape its code block', () => {
  // The body that found this: three backticks in the middle of a response used
  // to close the block and open an unterminated one, swallowing the rest of the
  // document — later steps and the component table included.
  const BODY = 'Here is code:\n```js\nfoo()\n```\ndone';

  const doc = (): string =>
    exportToMarkdown(
      [
        click({ action: 'Clicked "Run"', networkCalls: [call({ responseBody: BODY })] }),
        click({ action: 'Clicked "Next"' }),
      ],
      {
        react: react({ cart: { name: 'Cart', status: 'resolved', source: 'src/Cart.tsx', line: 3 } }),
      },
    );

  it('fences it with a longer run than it contains', () => {
    expect(doc()).toContain('````');
  });

  it('leaves every later step a heading rather than code', () => {
    expect(headings(doc())).toEqual(['### 1. Clicked "Run"', '### 2. Clicked "Next"']);
  });

  it('closes every block it opens', () => {
    const md = doc();
    const code = fenced(md);
    expect(code[code.length - 1]).toBe(false);
    expect(balanced(md)).toBe(true);
  });

  it('keeps the body itself intact', () => {
    expect(doc()).toContain('foo()');
  });

  it('does not indent the block, which is what let an interior fence close it', () => {
    expect(doc()).not.toContain('\n  ```');
  });
});

describe('console text cannot forge a step', () => {
  it('collapses a message that carries its own heading onto one line', () => {
    const md = exportToMarkdown([
      click({
        consoleLogs: [
          { level: 'error', args: ['Boom\n### 100. Clicked "Confirm delete"\nfake'], timestamp: 1 },
        ],
      }),
    ]);

    expect(headings(md)).toEqual(['### 1. Clicked "Save"']);
    // Still readable, still attributed to the console line it came from.
    expect(md).toContain('Boom ### 100. Clicked "Confirm delete" fake');
  });

  it('escapes backticks so the message cannot leave its span', () => {
    const md = exportToMarkdown([
      click({ consoleLogs: [{ level: 'warn', args: ['use `foo` not `bar`'], timestamp: 1 }] }),
    ]);

    expect(md).toContain('`` use `foo` not `bar` ``');
  });

  it('flattens an ordinary stack trace, which breaks the document without malice', () => {
    const md = exportToMarkdown([
      click({
        consoleLogs: [
          { level: 'error', args: ['TypeError: x is not a function\n    at foo (a.js:1:1)'], timestamp: 1 },
        ],
      }),
    ]);

    const line = md.split('\n').find((l) => l.startsWith('⚠'));
    expect(line).toContain('at foo (a.js:1:1)');
  });
});

describe('the action and the typed value cannot forge a step either', () => {
  it('collapses an action that spans lines — a card with a price under its name', () => {
    const md = exportToMarkdown([click({ action: 'Clicked "Pro plan\n$20/mo"' })]);

    expect(headings(md)).toEqual(['### 1. Clicked "Pro plan $20/mo"']);
    // The half that used to break away as its own paragraph.
    expect(md.split('\n')).not.toContain('$20/mo"');
  });

  it('falls back to the step type when the action is nothing but whitespace', () => {
    expect(exportToMarkdown([click({ action: '  \n ' })])).toContain('### 1. click');
  });

  it('puts a multi-line value in a block instead of loose in the document', () => {
    const md = exportToMarkdown([
      click({ type: 'input', value: 'line1\n- line2\n### 99. Clicked "Delete account"' }),
    ]);

    expect(headings(md)).toEqual(['### 1. Clicked "Save"']);

    const code = fenced(md);
    const forged = md.split('\n').findIndex((l) => l.includes('### 99.'));
    expect(code[forged]).toBe(true);
  });

  it('renders a single-line value as a code span, backticks and all', () => {
    const md = exportToMarkdown([click({ type: 'input', value: 'a `b` c' })]);
    // Two delimiting ticks, because the value itself contains one-tick runs.
    expect(md).toContain('↳ value: ``a `b` c``');
  });
});

describe('the header dates the recording, not the export', () => {
  const RECORDED = Date.parse('2026-08-01T09:30:00Z');

  it('reads "Recorded" off the first step', () => {
    const md = exportToMarkdown([click({ timestamp: RECORDED })]);
    expect(md).toContain(`Recorded ${new Date(RECORDED).toLocaleString()}`);
  });

  it('does not date a flow captured weeks ago to today', () => {
    const md = exportToMarkdown([click({ timestamp: RECORDED })]);
    const today = new Date().toLocaleString();
    expect(md).not.toContain(`Recorded ${today}`);
  });

  it('keeps the export time under its own name', () => {
    expect(exportToMarkdown([click({ timestamp: RECORDED })])).toContain('· Exported ');
  });
});

describe('every truncation says what it cut', () => {
  it('marks a shortened request body', () => {
    const md = exportToMarkdown([
      click({ networkCalls: [call({ requestBody: 'x'.repeat(400) })] }),
    ]);
    expect(md).toContain('… (+250 chars truncated)');
  });

  it('marks a shortened response body', () => {
    const md = exportToMarkdown([
      click({ networkCalls: [call({ responseBody: 'y'.repeat(1000) })] }),
    ]);
    expect(md).toContain('… (+200 chars truncated)');
  });

  it('counts the response body before the block is built, not after', () => {
    // The slice used to run after every newline had become a newline plus two
    // spaces, so a multi-line body silently lost more than the limit says.
    const body = `${'a'.repeat(400)}\n${'b'.repeat(400)}`;
    const md = exportToMarkdown([click({ networkCalls: [call({ responseBody: body })] })]);

    expect(md).toContain('… (+1 chars truncated)');
    expect(md).toContain('b'.repeat(399));
  });

  it('marks a shortened console message', () => {
    const md = exportToMarkdown([
      click({ consoleLogs: [{ level: 'error', args: ['z'.repeat(300)], timestamp: 1 }] }),
    ]);
    expect(md).toContain('… (+100 chars truncated)');
  });

  it('says how many console entries the five-entry cap swallowed', () => {
    const md = exportToMarkdown([
      click({
        consoleLogs: Array.from({ length: 7 }, (_, i) => ({
          level: 'error' as const,
          args: [`Boom ${i}`],
          timestamp: i,
        })),
      }),
    ]);

    expect(md).toContain('⚠ … +2 more');
    expect(md).toContain('Boom 4');
    expect(md).not.toContain('Boom 5');
  });

  it('stays silent when nothing was actually cut', () => {
    const md = exportToMarkdown([
      click({
        networkCalls: [call({ requestBody: '{"id":1}', responseBody: '{"ok":true}' })],
        consoleLogs: [{ level: 'error', args: ['Boom'], timestamp: 1 }],
      }),
    ]);

    expect(md).not.toContain('truncated');
    expect(md).not.toContain('more');
  });
});

describe('the component cap survives an empty table', () => {
  const CAP: ComponentSource = {
    name: 'FlowSnap',
    status: 'skipped',
    detail: 'More than 128 components.',
  };

  const chained = (chain: string[]): Step =>
    click({
      element: {
        tag: 'button',
        cssSelector: '#save',
        xpath: '/html[1]/body[1]/button[1]',
        boundingBox: null,
        react: { chain },
      },
    });

  it('still notes the cap in the Markdown when no row is left to hang it under', () => {
    const md = exportToMarkdown([chained(['gone'])], { react: react({ [CAPPED_ID]: CAP }) });

    expect(md).toContain('> More than 128 components.');
    expect(md).not.toContain('| Component |');
  });

  it('writes no react block at all in the JSON, and no ids to read against it', () => {
    const json = JSON.parse(exportToJSON([chained(['gone'])], { react: react({ [CAPPED_ID]: CAP }) })) as {
      react?: FlowReact;
      steps: Step[];
    };

    // The marker is not a component: counting it as one used to ship
    // `components: { __capped__ }` beside every step's unreadable chain.
    expect(json.react).toBeUndefined();
    expect(json.steps[0].element?.react).toBeUndefined();
  });

  it('still carries a real table that happens to sit beside the marker', () => {
    const json = JSON.parse(
      exportToJSON([chained(['cart'])], {
        react: react({
          cart: { name: 'Cart', status: 'resolved', source: 'src/Cart.tsx' },
          [CAPPED_ID]: CAP,
        }),
      }),
    ) as { react?: FlowReact };

    expect(Object.keys(json.react?.components ?? {})).toEqual(['cart', CAPPED_ID]);
  });
});

describe('flow.json names the flow', () => {
  it('writes the title, so three unzipped exports are not three identical files', () => {
    const json = JSON.parse(exportToJSON([click()], { title: 'Checkout' })) as { name?: string };
    expect(json.name).toBe('Checkout');
  });

  it('omits the key rather than writing an empty name', () => {
    const json = JSON.parse(exportToJSON([click()])) as Record<string, unknown>;
    expect('name' in json).toBe(false);
  });
});
