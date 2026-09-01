/**
 * A compiled flow has to be a program before it can be a test.
 *
 * Everything the compiler interpolates — a typed value, an aria-label, a URL, a
 * response body — is text the recorded page chose, and it lands in JavaScript
 * source. So these assertions do not grep the output for the substring they
 * hoped for: a substring cannot tell a closing quote from an escaped one. They
 * hand the generated script to the parser (`new Function` compiles without
 * running), and where a value matters they evaluate the literal back out and
 * compare it with what went in. That is the only check that would have caught
 * the escaper this compiler shipped with, which left the backslash alone and
 * turned a Windows path into a syntax error.
 */

/* The parser above is the assertion; nothing it compiles is ever called. */
/* eslint-disable @typescript-eslint/no-implied-eval, @typescript-eslint/no-unsafe-call */

import { describe, expect, it } from 'vitest';
import { generateCypressTest } from '../src/core/export/cypress.js';
import { jsLiteral } from '../src/core/export/literals.js';
import { planMocks } from '../src/core/export/mocks.js';
import { generatePlaywrightTest } from '../src/core/export/playwright.js';
import { resilientSelector } from '../src/core/export/selectors.js';
import type { ElementRef, NetworkCall, Step } from '../src/shared/types.js';

/** U+2028 and U+2029 end a JavaScript line and are invisible in a diff. */
const LS = String.fromCharCode(0x2028);
const PS = String.fromCharCode(0x2029);

const element = (over: Partial<ElementRef> = {}): ElementRef => ({
  tag: 'button',
  cssSelector: '#save',
  xpath: '/html[1]/body[1]/button[1]',
  boundingBox: null,
  ...over,
});

const click = (over: Partial<Step> = {}): Step =>
  ({
    type: 'click',
    url: 'https://app.example.com/orders',
    timestamp: 1_000,
    stepNumber: 1,
    action: 'Clicked "Save"',
    element: element(),
    ...over,
  }) as Step;

const input = (over: Partial<Step> = {}): Step =>
  ({
    type: 'input',
    url: 'https://app.example.com/orders',
    timestamp: 2_000,
    stepNumber: 2,
    action: 'Typed into Email',
    element: element({ tag: 'input', ariaLabel: 'Email' }),
    value: 'ada@example.com',
    ...over,
  }) as Step;

const call = (over: Partial<NetworkCall> = {}): NetworkCall => ({
  method: 'GET',
  url: 'https://api.example.com/v2/orders',
  requestHeaders: {},
  requestBody: null,
  status: 200,
  responseHeaders: {},
  responseBody: '{"ok":true}',
  durationMs: 12,
  timestamp: 1,
  ...over,
});

/**
 * Compile the script the way a runner would read it.
 *
 * `new Function` parses its body and throws on a syntax error without executing
 * anything, which is what makes it usable on a file full of `page`, `cy` and
 * `describe` that exist in neither this process nor any import here. The import
 * statements go first because a function body is not a module.
 */
function parses(source: string): void {
  const body = source.replace(/^import[^\n]*\n/gm, '');
  expect(() => new Function(body)).not.toThrow();
}

/** Evaluate one literal out of the generated source, the way the runner will. */
function evaluate<T>(literal: string): T {
  return new Function(`return (${literal});`)() as T;
}

/** The argument of the first `.fill(…)` or `.type(…)` in a generated script. */
function typedValue(source: string): string {
  const match = /\.(?:fill|type)\((.*)\);$/m.exec(source);
  expect(match).not.toBeNull();
  return evaluate<string>((match as RegExpExecArray)[1]);
}

describe('escaping page text into a script', () => {
  const hostile: [string, string][] = [
    ['a trailing backslash', 'C:\\Users\\ada\\'],
    ['a single quote', "it's a trap"],
    ['a quote after a backslash', "\\'; process.exit(1); //"],
    ['a newline', 'first\nsecond'],
    ['a carriage return', 'first\rsecond'],
    ['a tab', 'first\tsecond'],
    ['a NUL', 'first\u0000second'],
    ['a line separator', `first${LS}second`],
    ['a paragraph separator', `first${PS}second`],
  ];

  for (const [what, value] of hostile) {
    it(`survives ${what} in a typed value`, () => {
      const steps = [input({ value })];

      for (const source of [generatePlaywrightTest(steps), generateCypressTest(steps)]) {
        parses(source);
        expect(typedValue(source)).toBe(value);
      }
    });
  }

  it('escapes the backslash before anything that could be escaped by one', () => {
    // The shipped escaper was `replace(/'/g, "\\'")` with no backslash pass, so
    // a value ending in one produced `'foo\'` — the closing quote escaped, and
    // whatever the page wrote next running on as code.
    expect(evaluate<string>(jsLiteral('foo\\'))).toBe('foo\\');
    expect(() => new Function(`return ${jsLiteral("'; danger(); //")};`)).not.toThrow();
  });

  it('keeps a note step on its own comment line', () => {
    // A `//` comment ends at the first line break, so a note carrying one used
    // to publish the rest of itself as statements.
    const steps = [
      click(),
      { ...click(), type: 'note', value: 'stopped here\nawait danger();', stepNumber: 2 } as Step,
    ];

    parses(generatePlaywrightTest(steps));
    parses(generateCypressTest(steps));
    expect(generatePlaywrightTest(steps)).toContain('// Note: stopped here await danger();');
  });

  it('escapes a name the page chose for the test itself', () => {
    const steps = [click()];
    parses(generatePlaywrightTest(steps, "Ada's flow\n');danger();//"));
    parses(generateCypressTest(steps, "Ada's flow\n');danger();//"));
  });
});

describe('the selector hierarchy', () => {
  it('prefers the accessible name to everything below it', () => {
    const selector = resilientSelector(
      element({ ariaLabel: 'Save order', role: 'button', text: 'Save' }),
    );

    expect(selector.playwright).toBe("getByLabel('Save order')");
    expect(selector.cypress).toBe(`get('[aria-label="Save order"]')`);
    expect(selector.fragile).toBe(false);
  });

  it('falls to role and name next', () => {
    const selector = resilientSelector(element({ role: 'button', text: '  Save  ' }));

    expect(selector.playwright).toBe("getByRole('button', { name: 'Save' })");
    expect(selector.fragile).toBe(false);
  });

  it('falls to the text of a button or a link after that', () => {
    const selector = resilientSelector(element({ tag: 'a', text: 'Back to orders' }));

    expect(selector.playwright).toBe("getByText('Back to orders')");
    expect(selector.fragile).toBe(false);
  });

  it('falls to the CSS path last, and says so', () => {
    const selector = resilientSelector(element({ cssSelector: 'div.x > span:nth-child(3)' }));

    expect(selector.playwright).toBe("locator('div.x > span:nth-child(3)')");
    expect(selector.fragile).toBe(true);
  });

  it('warns on the line the fragile selector is used, not only in the flag', () => {
    // `fragile` was computed and read by nothing, so the developer holding the
    // spec still could not tell which four of forty lines would rot.
    const steps = [click({ element: element({ cssSelector: 'div.x > span' }) })];

    for (const source of [generatePlaywrightTest(steps), generateCypressTest(steps)]) {
      const lines = source.split('\n');
      const use = lines.findIndex((line) => line.includes('div.x > span'));
      expect(lines[use - 1]).toContain('FRAGILE');
    }
  });

  it('matches a role on the attribute as well as the native tag, for Cypress', () => {
    // `cy.contains('button', …)` treats the ARIA role as a tag name, and most
    // design systems' button is a `<div role="button">`, which it never matches.
    const selector = resilientSelector(element({ tag: 'div', role: 'button', text: 'Save' }));

    expect(selector.cypress).toBe(`contains('[role="button"], button', 'Save')`);
  });

  it('names the React component the step was attributed to', () => {
    const steps = [click({ element: element({ react: { chain: ['c1'], owner: 'CheckoutButton' } }) })];

    expect(generatePlaywrightTest(steps)).toContain('// React component: CheckoutButton');
  });

  it('carries a hostile label through both the CSS and the JS parser', () => {
    const label = `Say "hi"\\ '; danger(); //`;
    const steps = [click({ element: element({ ariaLabel: label }) })];
    const source = generateCypressTest(steps);

    parses(source);
    const match = /cy\.get\((.*)\)\.click\(\);$/m.exec(source);
    expect(match).not.toBeNull();
    // The JS layer unwraps to a CSS selector that still quotes the whole label.
    expect(evaluate<string>((match as RegExpExecArray)[1])).toBe(
      `[aria-label="Say \\"hi\\"\\\\ '; danger(); //"]`,
    );
  });
});

describe('the mocks a script can honestly replay', () => {
  it('keeps every method, not only GET', () => {
    // The shipped filter dropped everything but GET, which is every request a
    // checkout or a login bug is actually about.
    const steps = [
      click({
        networkCalls: [
          call({ method: 'POST', url: 'https://api.example.com/orders' }),
          call({ method: 'PUT', url: 'https://api.example.com/orders/1' }),
          call({ method: 'DELETE', url: 'https://api.example.com/orders/1' }),
        ],
      }),
    ];

    const plan = planMocks(steps);
    expect(plan.mocks.map((mock) => mock.method)).toEqual(['POST', 'PUT', 'DELETE']);

    const source = generateCypressTest(steps);
    for (const method of ['POST', 'PUT', 'DELETE']) {
      expect(source).toContain(`cy.intercept('${method}',`);
    }
  });

  it('keys the dedup on method and URL together', () => {
    // Two calls to one URL are two different responses; keying on the URL threw
    // the second — usually the one the step was recorded for — away.
    const steps = [
      click({
        networkCalls: [
          call({ method: 'GET', url: 'https://api.example.com/cart', responseBody: '{"items":0}' }),
          call({ method: 'POST', url: 'https://api.example.com/cart', responseBody: '{"items":1}' }),
          call({ method: 'GET', url: 'https://api.example.com/cart', responseBody: '{"items":9}' }),
        ],
      }),
    ];

    const plan = planMocks(steps);
    expect(plan.mocks.map((mock) => `${mock.method} ${mock.body}`)).toEqual([
      'GET {"items":0}',
      'POST {"items":1}',
    ]);
  });

  it('refuses to mock a truncated body, and says why in the script', () => {
    // A body cut at the capture cap is not the response the page received, and
    // a mock built from it fails the spec somewhere the developer cannot see.
    const steps = [
      click({
        networkCalls: [
          call({
            method: 'POST',
            url: 'https://api.example.com/checkout',
            responseBody: '{"order":{"id":42,"lines":[{"sk',
            responseBodyTruncated: true,
            responseBodyBytes: 91_402,
          }),
        ],
      }),
    ];

    const plan = planMocks(steps);
    expect(plan.mocks).toHaveLength(0);
    expect(plan.omitted[0].reason).toContain('cut at the capture cap');

    for (const source of [generatePlaywrightTest(steps), generateCypressTest(steps)]) {
      parses(source);
      expect(source).not.toContain('{"order"');
      expect(source).toContain('Not mocked — POST https://api.example.com/checkout');
      expect(source).toContain('91402 characters');
    }
  });

  it('says so too when the request never came back', () => {
    const steps = [click({ networkCalls: [call({ status: null, responseBody: null })] })];
    const plan = planMocks(steps);

    expect(plan.mocks).toHaveLength(0);
    expect(plan.omitted[0].reason).toContain('never completed');
  });

  it('drops the headers that describe the transfer rather than the response', () => {
    // A recorded `content-length` counts the compressed bytes, and the fetch
    // fails inside the app rather than anywhere the developer is looking.
    const steps = [
      click({
        networkCalls: [
          call({
            responseHeaders: {
              'Content-Type': 'application/json',
              'Content-Encoding': 'gzip',
              'content-length': '20',
            },
          }),
        ],
      }),
    ];

    expect(planMocks(steps).mocks[0].headers).toEqual({ 'Content-Type': 'application/json' });
  });

  it('escapes a response body that would otherwise end the literal holding it', () => {
    const body = `{"note":"line${LS}break"}`;
    const steps = [click({ networkCalls: [call({ responseBody: body })] })];

    for (const source of [generatePlaywrightTest(steps), generateCypressTest(steps)]) {
      parses(source);
      const match = /body: (.*),$/m.exec(source);
      expect(evaluate<string>((match as RegExpExecArray)[1])).toBe(body);
    }
  });
});

describe('matching the URL that was actually recorded', () => {
  const url = 'https://api.example.com/search?q=a[b]*&page=1';

  it('matches Playwright on the href, because page.route reads a string as a glob', () => {
    const steps = [click({ networkCalls: [call({ url })] })];
    const source = generatePlaywrightTest(steps);

    parses(source);
    const match = /url\.href === (.*),$/m.exec(source);
    expect(match).not.toBeNull();
    expect(evaluate<string>((match as RegExpExecArray)[1])).toBe(url);
    // The literal URL is never handed to route() as a pattern.
    expect(source).not.toContain(`page.route('${url}'`);
  });

  it('anchors the Cypress intercept, because a url string there is glob-matched too', () => {
    const steps = [click({ networkCalls: [call({ url })] })];
    const source = generateCypressTest(steps);

    parses(source);
    const match = /cy\.intercept\('GET', (\/.*\/), \{$/m.exec(source);
    expect(match).not.toBeNull();

    const pattern = evaluate<RegExp>((match as RegExpExecArray)[1]);
    expect(pattern.test(url)).toBe(true);
    // Every metacharacter is a literal, so nothing else in the world matches.
    expect(pattern.test('https://api.example.com/search?q=axb_&page=1')).toBe(false);
    expect(pattern.test(`${url}&extra=1`)).toBe(false);
  });

  it('keeps a GET and a POST to one URL apart in the generated Playwright', () => {
    const steps = [
      click({
        networkCalls: [
          call({ method: 'GET', url: 'https://api.example.com/cart' }),
          call({ method: 'POST', url: 'https://api.example.com/cart' }),
        ],
      }),
    ];
    const source = generatePlaywrightTest(steps);

    parses(source);
    expect(source).toContain(`if (request.method() !== 'GET') return route.fallback();`);
    expect(source).toContain(`if (request.method() !== 'POST') return route.fallback();`);
  });
});

describe('the shape of the script', () => {
  it('compiles an empty flow to an empty test rather than an empty file', () => {
    // `''` reaches the developer as a zero-byte spec their runner reports as
    // "no tests found", which reads as a broken toolchain.
    for (const source of [generatePlaywrightTest([]), generateCypressTest([])]) {
      expect(source.trim()).not.toBe('');
      parses(source);
      expect(source).toContain('nothing to replay');
      expect(source).not.toContain('goto');
      expect(source).not.toContain('cy.visit');
    }
  });

  it('opens the page the flow started on when the first step is not a navigation', () => {
    const steps = [click({ url: 'https://app.example.com/orders' })];

    expect(generatePlaywrightTest(steps)).toContain(
      `await page.goto('https://app.example.com/orders');`,
    );
    expect(generateCypressTest(steps)).toContain(`cy.visit('https://app.example.com/orders');`);
  });

  it('does not open the page twice when the first step already navigates', () => {
    const steps: Step[] = [
      {
        type: 'navigate',
        url: 'https://app.example.com/',
        title: 'Orders',
        timestamp: 1,
        stepNumber: 1,
        action: 'Navigated to /',
      },
      click({ stepNumber: 2 }),
    ];

    const gotos = generatePlaywrightTest(steps).match(/page\.goto\(/g) ?? [];
    expect(gotos).toHaveLength(1);
  });

  it('clears rather than types when the recorded value was empty', () => {
    // `cy.type('')` throws, so the one step that empties a field would fail the
    // whole spec.
    expect(generateCypressTest([input({ value: '' })])).toContain('.clear();');
  });

  it('compiles a realistic flow to something a runner can parse', () => {
    const steps: Step[] = [
      {
        type: 'navigate',
        url: 'https://shop.example.com/cart?ref=email[1]',
        title: 'Cart',
        timestamp: 1,
        stepNumber: 1,
        action: 'Navigated to /cart',
      },
      input({
        stepNumber: 2,
        element: element({ tag: 'input', ariaLabel: "Promo code (it's optional)" }),
        value: "SAVE'10\\",
        networkCalls: [
          call({
            method: 'POST',
            url: 'https://api.shop.example.com/promo?code=SAVE*10',
            status: 422,
            responseHeaders: { 'Content-Type': 'application/json', 'Content-Length': '31' },
            responseBody: '{"error":"expired","retry":false}',
          }),
        ],
      }),
      click({
        stepNumber: 3,
        element: element({ tag: 'div', role: 'button', text: 'Check out' }),
        action: 'Clicked "Check out"',
        networkCalls: [
          call({
            method: 'POST',
            url: 'https://api.shop.example.com/checkout',
            responseBody: '{"truncated"',
            responseBodyTruncated: true,
          }),
        ],
      }),
      click({
        stepNumber: 4,
        element: element({ cssSelector: 'main > div:nth-child(2) .row' }),
        action: 'Clicked a row',
      }),
      { ...click({ stepNumber: 5 }), type: 'note', value: 'Step limit reached' },
    ];

    const playwright = generatePlaywrightTest(steps, 'Checkout rejects an expired promo');
    const cypress = generateCypressTest(steps, 'Checkout rejects an expired promo');

    parses(playwright);
    parses(cypress);

    for (const source of [playwright, cypress]) {
      expect(source).toContain('FRAGILE');
      expect(source).toContain('Not mocked');
      // The 422 is replayed; its Content-Length, measured on other bytes, is not.
      expect(source).toContain('422');
      expect(source).not.toContain('Content-Length');
    }

    expect(cypress).toContain(`contains('[role="button"], button', 'Check out')`);
    expect(typedValue(playwright)).toBe("SAVE'10\\");
  });
});

/**
 * The state a recording read, carried into the spec as comments.
 *
 * The roadmap item is "state assertions from before/after store diffs" and an
 * assertion is deliberately not what ships — `core/export/state.ts` says why at
 * length. What is asserted here is the two halves of the honest version: the
 * observation reaches the file beside the step that caused it, and it reaches
 * it as a *comment*, which means every one of the page's own strings in it has
 * to go through the escaper. A store's key is text the app chose, and a patch
 * path that ends a comment line early is the same class of bug the rest of this
 * file exists for — one line further down, where nobody is looking for it.
 */
describe('what the stores did, beside the step that did it', () => {
  const withState = (over: Partial<Step> = {}): Step =>
    click({
      state: [
        {
          store: 'redux:0',
          patch: [
            { op: 'replace', path: '/checkout/status', value: 'error' },
            { op: 'add', path: '/checkout/errors/0', value: { code: 'CARD_DECLINED' } },
          ],
        },
      ],
      ...over,
    });

  it('writes each operation beside the step, and says why it is not an assertion', () => {
    const steps = [withState()];

    for (const source of [generatePlaywrightTest(steps), generateCypressTest(steps)]) {
      parses(source);
      expect(source).toContain('State observed here');
      expect(source).toContain('redux:0  replace /checkout/status = "error"');
      expect(source).toContain('redux:0  add /checkout/errors/0 = {"code":"CARD_DECLINED"}');
      /*
       * The reason, in the file. A developer who finds comments where they
       * expected assertions and no explanation concludes the exporter is
       * unfinished; the explanation is what turns it into a decision they can
       * disagree with.
       */
      expect(source).toContain('This runner has no handle on that');
    }
  });

  it('says it once, however many steps carried state', () => {
    const source = generatePlaywrightTest([
      withState(),
      withState({ stepNumber: 2, timestamp: 2_000 }),
    ]);

    parses(source);
    expect(source.match(/--- State ---/g)).toHaveLength(1);
    expect(source.match(/State observed here/g)).toHaveLength(2);
  });

  it('says nothing at all about state on a flow that read none', () => {
    // A spec for a recording with no stores should not carry a paragraph
    // explaining why it has no assertions for them.
    for (const source of [generatePlaywrightTest([click()]), generateCypressTest([click()])]) {
      expect(source).not.toContain('--- State ---');
      expect(source).not.toContain('State observed here');
    }
  });

  it('stays a program when the app names a key the way the page chose', () => {
    /*
     * A store id and a patch path are text the recorded application chose, and
     * they land after `//`. A comment ends at the first line terminator, so a
     * newline in either does not make an ugly comment — it makes whatever
     * follows the newline into code. U+2028 does the same thing while being
     * invisible in a diff.
     */
    const steps = [
      withState({
        state: [
          {
            store: `redux:0\nawait danger();`,
            patch: [
              { op: 'replace', path: `/a${LS}await danger();`, value: `x${PS}await danger();` },
            ],
          },
        ],
      }),
    ];

    for (const source of [generatePlaywrightTest(steps), generateCypressTest(steps)]) {
      parses(source);
      expect(source).not.toMatch(/^\s*await danger\(\);/m);
    }
  });

  it('caps the operations and says how many it did not print', () => {
    const steps = [
      withState({
        state: [
          {
            store: 'redux:0',
            patch: Array.from({ length: 9 }, (_, i) => ({
              op: 'replace' as const,
              path: `/items/${i}/qty`,
              value: i,
            })),
          },
        ],
      }),
    ];

    const source = generatePlaywrightTest(steps);
    parses(source);
    // Six printed, three named — and the tool that has all of them is named
    // too, because a truncated list with nowhere to go is a dead end.
    expect(source).toContain('/items/5/qty');
    expect(source).not.toContain('/items/6/qty');
    expect(source).toContain('… 3 more operations — get_state_patch has all of them');
  });

  it('carries the two flags that change what the list means', () => {
    /*
     * Neither is decoration. Under `bounded` a path that is absent may have
     * changed below the snapshot cut, and under `collapsed` the operations are
     * coarser than the ones the app actually made — a developer writing an
     * assertion off either without being told is asserting on something the
     * recording never claimed.
     */
    const steps = [
      withState({
        state: [
          {
            store: 'redux:0',
            patch: [{ op: 'replace', path: '/cart', value: {} }],
            bounded: true,
            collapsed: 4,
          },
        ],
      }),
    ];

    const source = generatePlaywrightTest(steps);
    parses(source);
    expect(source).toContain('bounded view of the store');
    expect(source).toContain('4 finer operations were folded into coarser replaces');
  });
});

/**
 * The step types the state block reaches, which are all of them.
 *
 * `hasState` counts every step when it decides whether to print the eleven-line
 * preamble, so a compiler that emitted the comments only for clicks and inputs
 * would, on a flow whose only state landed elsewhere, print the whole
 * explanation and then not a single comment it explains. Unreachable today —
 * the recorder attaches state only to steps with an interaction — which is
 * exactly why it needs a test rather than an argument.
 */
describe('state comments on the steps that compile to something else', () => {
  const withState = (over: Partial<Step>): Step =>
    ({
      ...over,
      state: [
        { store: 'redux:0', patch: [{ op: 'replace', path: '/route', value: '/orders' }] },
      ],
    }) as Step;

  it('reaches a navigation', () => {
    const steps = [
      withState({
        type: 'navigate',
        url: 'https://app.example.com/orders',
        timestamp: 1_000,
        stepNumber: 1,
        action: 'Went to Orders',
        title: 'Orders',
      }),
    ];

    for (const source of [generatePlaywrightTest(steps), generateCypressTest(steps)]) {
      parses(source);
      expect(source).toContain('--- State ---');
      expect(source).toContain('redux:0  replace /route = "/orders"');
    }
  });

  it('reaches a note', () => {
    const steps = [
      click(),
      withState({
        type: 'note',
        url: 'https://app.example.com/orders',
        timestamp: 2_000,
        stepNumber: 2,
        action: 'Recording stopped',
        value: 'Step limit reached',
      }),
    ];

    for (const source of [generatePlaywrightTest(steps), generateCypressTest(steps)]) {
      parses(source);
      expect(source).toContain('redux:0  replace /route = "/orders"');
    }
  });
});
