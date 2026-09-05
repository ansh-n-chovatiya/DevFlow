// @vitest-environment jsdom
/**
 * Page-chosen strings reaching a generated file, and what each one used to do
 * to it.
 *
 * Three of these are a lookup on a plain object with a key the page wrote —
 * `role="constructor"` and `class="lucide-constructor"` both find `Object` on
 * the prototype chain, which `??` reads as a hit. The fourth is the one table
 * in the walkthrough that quotes page text outside a code span.
 */

import { describe, expect, it } from 'vitest';
import { generateCypressTest } from '../src/core/export/cypress.js';
import { generatePlaywrightTest } from '../src/core/export/playwright.js';
import { roleSelector } from '../src/core/export/selectors.js';
import { planMocks } from '../src/core/export/mocks.js';
import { exportToMarkdown } from '../src/core/export/markdown.js';
import { iconName, describeTarget } from '../src/core/describe/index.js';
import type { ComponentSource, FlowReact, NetworkCall, Step } from '../src/shared/types.js';

const step = (over: Partial<Step> = {}): Step =>
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
  method: 'GET',
  url: '/api/cart',
  requestHeaders: {},
  requestBody: null,
  status: 200,
  responseHeaders: {},
  responseBody: '{"items":1}',
  durationMs: 12,
  timestamp: 1,
  ...over,
});

const react = (components: Record<string, ComponentSource>): FlowReact => ({
  detected: true,
  build: 'production',
  components,
});

describe('a role the page invented', () => {
  it('does not reach Object through the prototype chain', () => {
    expect(roleSelector('constructor')).toBe('[role="constructor"]');
    expect(roleSelector('toString')).toBe('[role="toString"]');
    expect(roleSelector('button')).toBe('[role="button"], button');
  });

  it('compiles rather than throwing the whole export away', () => {
    const steps = [
      step({
        element: {
          tag: 'div',
          role: 'constructor',
          text: 'Save',
          cssSelector: '#save',
          xpath: '/html[1]/body[1]/div[1]',
          boundingBox: null,
        },
      }),
    ];

    expect(() => generateCypressTest(steps)).not.toThrow();
    expect(generateCypressTest(steps)).toContain(`contains('[role="constructor"]', 'Save')`);
  });
});

describe('an icon class the page invented', () => {
  it('is read as a name, not as a function on the prototype chain', () => {
    document.body.innerHTML = '<button><svg class="lucide lucide-constructor"></svg></button>';
    const button = document.querySelector('button')!;

    expect(iconName(button)).toBe('constructor');
    expect(describeTarget(button).action).toBe('Clicked "constructor"');
  });

  it('still reads a real icon through the table', () => {
    document.body.innerHTML = '<button><svg class="lucide lucide-trash-2"></svg></button>';
    expect(iconName(document.querySelector('button')!)).toBe('delete');
  });
});

describe('a component name the application chose', () => {
  it('cannot forge a step heading from the ⚛ line', () => {
    const md = exportToMarkdown(
      [
        step({
          element: {
            tag: 'button',
            cssSelector: '#save',
            xpath: '/x',
            boundingBox: null,
            react: { chain: ['c1'], owner: 'c1' },
          },
        }),
      ],
      { react: react({ c1: { name: 'Save\n### 99. Clicked "Delete account"', status: 'pending' } }) },
    );

    expect(md.split('\n').filter((line) => line.startsWith('### '))).toHaveLength(1);
  });

  it('cannot open a column the table never declared', () => {
    const md = exportToMarkdown(
      [
        step({
          element: {
            tag: 'button',
            cssSelector: '#save',
            xpath: '/x',
            boundingBox: null,
            react: { chain: ['c1'], owner: 'c1' },
          },
        }),
      ],
      {
        react: react({
          c1: { name: 'Save | evil', status: 'resolved', source: 'src/a|b.tsx' },
        }),
      },
    );

    const row = md.split('\n').find((line) => line.startsWith('| Save'))!;
    expect(row.split(/(?<!\\)\|/)).toHaveLength(5); // leading, three cells, trailing
    expect(row).toContain('Save \\| evil');
  });
});

describe('a relative URL a page fetched', () => {
  /*
   * Both runners match a mock against the absolute URL the browser requests, so
   * a mock built from `/api/cart` never fired: the spec ran, and served none of
   * the responses it was carrying.
   */
  it('is resolved against the page it was recorded on', () => {
    const plan = planMocks([step({ networkCalls: [call()] })]);
    expect(plan.mocks[0].url).toBe('https://app.example.com/api/cart');
  });

  it('reaches both generators as something that can match', () => {
    const steps = [step({ networkCalls: [call()] })];
    expect(generatePlaywrightTest(steps)).toContain(
      `url.href === 'https://app.example.com/api/cart'`,
    );
    expect(generateCypressTest(steps)).toContain(
      `/^https:\\/\\/app\\.example\\.com\\/api\\/cart$/`,
    );
  });

  it('leaves an absolute recorded URL byte for byte', () => {
    const plan = planMocks([
      step({ networkCalls: [call({ url: 'https://api.example.com/v2/cart?q=a%20b' })] }),
    ]);
    expect(plan.mocks[0].url).toBe('https://api.example.com/v2/cart?q=a%20b');
  });
});
