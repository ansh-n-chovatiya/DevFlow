/**
 * Recorded interactions, offered back as actions to perform again.
 *
 * Nothing in this module throws and nothing in it returns an obviously wrong
 * shape. Every defect it can have produces a plausible-looking list of
 * plausible-looking actions, which is exactly the failure the reverted v3.2.0
 * generator had: it returned a confident list of buttons that did not exist.
 * So these are the five things that go wrong in silence, and each has tests
 * below.
 *
 * **The signature is the promise.** The previous generator took a knowledge
 * graph, read nothing out of it, and returned the same hardcoded actions
 * whatever it was handed. A caller cannot see that from the outside — a graph
 * parameter *is* the claim that the graph was consulted. There is nothing to
 * assert about a graph that is not there, so what is asserted is the arity: a
 * fourth argument appearing is the moment to check whether it is read.
 *
 * **A fold that does not fold, or folds the wrong things together.** Four
 * recordings of one button are one action seen four times. Fold too little and
 * the list is four near-duplicates and every count reads as one; fold too much
 * and two different buttons merge into a `seen: 2` that outranks the real
 * answer. Both look like a list of actions.
 *
 * **`seen` and `flows` are the ranking.** They are the only reason to believe
 * one candidate over another, and a caller reads the top of the list. Drop the
 * flow ids or count steps instead of recordings and the order is still a list,
 * just no longer the list of what people actually do.
 *
 * **A skipped step that is not counted.** *This page has no recorded actions*
 * and *your filter removed all of them* are the same empty `actions` array and
 * opposite conclusions. So is *this recording has no React attribution at all*
 * against *your component was never touched*, which is why those two are
 * separate reasons rather than one.
 *
 * **A lost `fragile` flag, or a lost `more`.** Both are the caller being told
 * something is safe when it is not: a CSS-path selector replayed as if it were
 * an accessible name, and a truncated list read as the whole of it.
 *
 * The fixtures are written out by hand rather than produced by the recorder or
 * by `buildPayload`: a fixture built by the code under test agrees with it by
 * construction, and the question here is whether the planner agrees with steps
 * of the shape the extension actually records.
 */

import { describe, expect, it } from 'vitest';

import { planActions, type ObservedFlow } from '../src/core/actions/index.js';
import type {
  ClickStep,
  ElementRef,
  ElementReactRef,
  InputStep,
  NavigateStep,
  NoteStep,
  Step,
} from '../src/shared/types.js';

const ORDERS = 'https://shop.test/orders';
const SETTINGS = 'https://shop.test/settings';

/**
 * The `ElementRef` fields the type requires and no test here is about.
 *
 * `tag`, `xpath` and `boundingBox` are irrelevant to a planner that reads names
 * and selectors, and spelling them out on every element would bury the two
 * fields a test is actually varying.
 */
function el(over: Partial<ElementRef> & { cssSelector: string }): ElementRef {
  return { tag: 'button', xpath: '//button', boundingBox: null, ...over };
}

/** Nothing here reads a timestamp, so every step shares one. */
const WHEN = 0;

function click(url: string, element: ElementRef): ClickStep {
  return { type: 'click', url, timestamp: WHEN, action: 'Clicked', element };
}

function input(url: string, element: ElementRef, value: string): InputStep {
  return { type: 'input', url, timestamp: WHEN, action: 'Typed', element, value };
}

function navigate(url: string, title: string): NavigateStep {
  return { type: 'navigate', url, timestamp: WHEN, action: 'Went to', title };
}

function note(url: string, value: string): NoteStep {
  return { type: 'note', url, timestamp: WHEN, action: 'Note', value };
}

function flow(id: string, steps: Step[]): ObservedFlow {
  return { id, name: `flow ${id}`, steps };
}

function react(over: Partial<ElementReactRef> & { chain: string[] }): ElementReactRef {
  return { ...over };
}

/** An accessible name, so `resilientSelector` never falls through to the path. */
const SAVE = el({ cssSelector: '#save', label: 'Save', ariaLabel: 'Save' });
const CANCEL = el({ cssSelector: '#cancel', label: 'Cancel', ariaLabel: 'Cancel' });
const EMAIL = el({ tag: 'input', cssSelector: '#email', label: 'Email', ariaLabel: 'Email' });

/** No name of any kind, which is what makes it fragile. */
const ANON = el({ tag: 'div', cssSelector: 'main > div:nth-child(3)' });

/** Same label as `SAVE`, reached by a different handle — the selector tiebreak. */
const SAVE_BY_ROLE = el({ cssSelector: '.save', label: 'Save', role: 'button', text: 'Save' });

/** A label and a visible text that disagree, which is the common case for a field. */
const RENAMED = el({ tag: 'input', cssSelector: '#renamed', label: 'Email address', role: 'textbox', text: 'Email' });

/** Nothing but an aria-label: the third rung of the fallback, below label and text. */
const CLOSE = el({ cssSelector: '#close', ariaLabel: 'Close' });

const NO_TARGET = {};

describe('the signature', () => {
  it('takes flows, a target and a limit, and nothing else', () => {
    // A fourth parameter is how the last generator claimed to read a knowledge
    // graph it ignored. If this fails, the question is not "update the number".
    expect(planActions.length).toBe(3);
  });

  it('plans nothing from no recordings, and says nothing was skipped', () => {
    expect(planActions([], NO_TARGET, 10)).toStrictEqual({ actions: [], skipped: [] });
  });
});

describe('folding repeats', () => {
  it('counts one action across two recordings and names both flows', () => {
    const plan = planActions(
      [
        flow('a', [click(ORDERS, SAVE), click(ORDERS, SAVE)]),
        flow('b', [click(ORDERS, SAVE)]),
      ],
      NO_TARGET,
      10,
    );

    expect(plan.actions).toStrictEqual([
      {
        kind: 'click',
        selector: "getByLabel('Save')",
        label: 'Save',
        url: ORDERS,
        seen: 3,
        flows: ['a', 'b'],
      },
    ]);
  });

  it('keeps flow ids in first-seen order and does not repeat one', () => {
    const plan = planActions(
      [
        flow('b', [click(ORDERS, SAVE)]),
        flow('a', [click(ORDERS, SAVE), click(ORDERS, SAVE)]),
        flow('b', [click(ORDERS, SAVE)]),
      ],
      NO_TARGET,
      10,
    );

    expect(plan.actions[0]?.flows).toStrictEqual(['b', 'a']);
    expect(plan.actions[0]?.seen).toBe(4);
  });

  it('does not fold two different elements together', () => {
    const plan = planActions([flow('a', [click(ORDERS, SAVE), click(ORDERS, CANCEL)])], NO_TARGET, 10);

    expect(plan.actions.map((action) => action.selector)).toStrictEqual([
      "getByLabel('Cancel')",
      "getByLabel('Save')",
    ]);
    expect(plan.actions.every((action) => action.seen === 1)).toBe(true);
  });

  it('does not fold the same element on two different pages', () => {
    const plan = planActions(
      [flow('a', [click(ORDERS, SAVE), click(SETTINGS, SAVE)])],
      NO_TARGET,
      10,
    );

    expect(plan.actions.map((action) => action.url)).toStrictEqual([ORDERS, SETTINGS]);
  });

  it('does not fold a click and an input on one element into one action', () => {
    const plan = planActions([flow('a', [click(ORDERS, EMAIL), input(ORDERS, EMAIL, 'ada@')])], NO_TARGET, 10);

    expect(plan.actions.map((action) => action.kind)).toStrictEqual(['click', 'input']);
  });
});

describe('the page a step was performed on', () => {
  it('folds one action across two query strings and reports the page without them', () => {
    const plan = planActions(
      [
        flow('a', [
          click(`${ORDERS}?page=2`, SAVE),
          click(`${ORDERS}?page=3`, SAVE),
          click(`${ORDERS}#top`, SAVE),
        ]),
      ],
      NO_TARGET,
      10,
    );

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.url).toBe(ORDERS);
    expect(plan.actions[0]?.seen).toBe(3);
  });

  it('keeps two different paths apart', () => {
    const plan = planActions(
      [flow('a', [click(`${ORDERS}/1`, SAVE), click(`${ORDERS}/2`, SAVE)])],
      NO_TARGET,
      10,
    );

    expect(plan.actions.map((action) => action.url)).toStrictEqual([
      `${ORDERS}/1`,
      `${ORDERS}/2`,
    ]);
  });

  it('does not throw on a URL the parser will not take, and still drops its query', () => {
    // A recorder that captured a relative URL, or a page with an opaque origin,
    // still wrote down the only name that page has. Losing the whole plan to it
    // would be the worst possible reading of one bad field.
    const plan = planActions(
      [flow('a', [click('not a url at all?page=2', SAVE), click('not a url at all?page=9', CANCEL)])],
      NO_TARGET,
      10,
    );

    expect(plan.actions.map((action) => action.url)).toStrictEqual([
      'not a url at all',
      'not a url at all',
    ]);
  });

  it('matches a malformed target URL against a malformed step URL', () => {
    const plan = planActions(
      [flow('a', [click('about:blank', SAVE), click(ORDERS, CANCEL)])],
      { url: 'about:blank' },
      10,
    );

    expect(plan.actions.map((action) => action.label)).toStrictEqual(['Save']);
  });
});

describe('the target filter', () => {
  const twoPages = [flow('a', [click(ORDERS, SAVE), click(SETTINGS, CANCEL), click(SETTINGS, SAVE)])];

  it('keeps only the steps performed on the page asked about', () => {
    const plan = planActions(twoPages, { url: SETTINGS }, 10);

    expect(plan.actions.map((action) => action.label)).toStrictEqual(['Cancel', 'Save']);
  });

  it('matches the page whatever query string the caller pasted in', () => {
    const plan = planActions(twoPages, { url: `${SETTINGS}?tab=billing#x` }, 10);

    expect(plan.actions).toHaveLength(2);
  });

  const attributed = [
    flow('a', [
      click(ORDERS, el({ cssSelector: '#a', ariaLabel: 'Owned', react: react({ chain: ['Page', 'CartBadge'], owner: 'CartBadge' }) })),
      click(ORDERS, el({ cssSelector: '#b', ariaLabel: 'InChain', react: react({ chain: ['Page', 'CartBadge', 'Icon'], owner: 'Icon' }) })),
      click(ORDERS, el({ cssSelector: '#c', ariaLabel: 'Elsewhere', react: react({ chain: ['Page', 'Header'], owner: 'Header' }) })),
      click(ORDERS, SAVE),
    ]),
  ];

  it('keeps a step whose owner is the component and one that only has it in the chain', () => {
    const plan = planActions(attributed, { component: 'CartBadge' }, 10);

    expect(plan.actions.map((action) => action.label)).toStrictEqual(['InChain', 'Owned']);
  });

  it('separates a step attributed elsewhere from one with no attribution at all', () => {
    // Two different answers for the caller: the first says the component was
    // idle, the second says this recording never resolved React.
    const plan = planActions(attributed, { component: 'CartBadge' }, 10);

    expect(plan.skipped).toStrictEqual([
      { reason: 'Attributed to a different component.', count: 1 },
      { reason: 'Carries no component attribution to match against.', count: 1 },
    ]);
  });

  it('keeps a step whose owner is the component even when the chain no longer lists it', () => {
    // The owner is normally one of the chain, so this is the case a match on the
    // chain alone would pass by accident. A walk that hit its cap is where the
    // two come apart, and the contract is owner *or* chain.
    const truncated = el({
      cssSelector: '#owned',
      ariaLabel: 'Owned',
      react: react({ chain: [], owner: 'CartBadge', truncated: true }),
    });
    const plan = planActions([flow('a', [click(ORDERS, truncated)])], { component: 'CartBadge' }, 10);

    expect(plan.actions.map((action) => action.label)).toStrictEqual(['Owned']);
  });

  it('requires both filters to hold when both are given', () => {
    const owned = el({
      cssSelector: '#a',
      ariaLabel: 'Owned',
      react: react({ chain: ['CartBadge'], owner: 'CartBadge' }),
    });
    const elsewhere = el({
      cssSelector: '#h',
      ariaLabel: 'Header',
      react: react({ chain: ['Header'], owner: 'Header' }),
    });
    const plan = planActions(
      [flow('a', [click(ORDERS, owned), click(SETTINGS, owned), click(ORDERS, elsewhere), click(ORDERS, SAVE)])],
      { url: ORDERS, component: 'CartBadge' },
      10,
    );

    expect(plan.actions.map((action) => action.label)).toStrictEqual(['Owned']);
    expect(plan.actions[0]?.seen).toBe(1);
    // Also the reported order of the first three reasons: it comes from the
    // module's table, not from whichever step happened to be skipped first.
    expect(plan.skipped).toStrictEqual([
      { reason: 'Performed on a different page.', count: 1 },
      { reason: 'Attributed to a different component.', count: 1 },
      { reason: 'Carries no component attribution to match against.', count: 1 },
    ]);
  });

  it('reports every reason in one fixed order however the steps were recorded', () => {
    const lossy = { type: 'click', url: ORDERS, timestamp: WHEN, action: 'Clicked' } as unknown as Step;
    const steps = [lossy, note(ORDERS, 'Step limit reached'), click(SETTINGS, SAVE)];
    const expected = [
      { reason: 'Performed on a different page.', count: 1 },
      { reason: 'A note records what happened; there is nothing to perform.', count: 1 },
      { reason: 'No element was recorded, so there is nothing to point at.', count: 1 },
    ];

    expect(planActions([flow('a', steps)], { url: ORDERS }, 10).skipped).toStrictEqual(expected);
    expect(planActions([flow('a', [...steps].reverse())], { url: ORDERS }, 10).skipped).toStrictEqual(expected);
  });

  it('plans everything when neither filter is given', () => {
    expect(planActions(twoPages, NO_TARGET, 10).actions).toHaveLength(3);
    expect(planActions(twoPages, NO_TARGET, 10).skipped).toStrictEqual([]);
  });
});

describe('what did not become an action', () => {
  it('counts a note as having nothing to perform', () => {
    const plan = planActions(
      [flow('a', [note(ORDERS, 'Step limit reached'), note(ORDERS, 'Recording stopped'), click(ORDERS, SAVE)])],
      NO_TARGET,
      10,
    );

    expect(plan.actions).toHaveLength(1);
    expect(plan.skipped).toStrictEqual([
      { reason: 'A note records what happened; there is nothing to perform.', count: 2 },
    ]);
  });

  it('counts a click with no element, which a navigation is not', () => {
    // `ClickStep` requires an element, and a flow written by an older DevFlow
    // and read back off disk is not obliged to have one. The cast is the point
    // of the test: this is the shape that arrives, not the shape that compiles.
    const lossy = { type: 'click', url: ORDERS, timestamp: WHEN, action: 'Clicked' } as unknown as Step;
    const plan = planActions([flow('a', [lossy, navigate(ORDERS, 'Orders')])], NO_TARGET, 10);

    expect(plan.actions.map((action) => action.kind)).toStrictEqual(['navigate']);
    expect(plan.skipped).toStrictEqual([
      { reason: 'No element was recorded, so there is nothing to point at.', count: 1 },
    ]);
  });

  it('tells an empty page apart from a page that was filtered away', () => {
    const empty = planActions([flow('a', [note(ORDERS, 'nothing here')])], { url: ORDERS }, 10);
    const filtered = planActions([flow('a', [click(SETTINGS, SAVE)])], { url: ORDERS }, 10);

    expect(empty.actions).toStrictEqual([]);
    expect(filtered.actions).toStrictEqual([]);
    expect(empty.skipped).not.toStrictEqual(filtered.skipped);
    expect(filtered.skipped).toStrictEqual([{ reason: 'Performed on a different page.', count: 1 }]);
  });
});

describe('ordering', () => {
  it('puts the action several recordings performed above the one done once', () => {
    const plan = planActions(
      [
        flow('a', [click(ORDERS, CANCEL), click(ORDERS, SAVE)]),
        flow('b', [click(ORDERS, SAVE)]),
      ],
      NO_TARGET,
      10,
    );

    expect(plan.actions.map((action) => [action.label, action.seen])).toStrictEqual([
      ['Save', 2],
      ['Cancel', 1],
    ]);
  });

  it('breaks a tie on the label before it looks at the selector', () => {
    // The two orders are deliberately opposed here: by label this is Alpha then
    // Beta, by selector it is `getByLabel` then `getByRole`, which is Beta then
    // Alpha. A tiebreak that reads only the selector agrees with the right
    // answer on every fixture where the two happen to line up.
    const alpha = el({ cssSelector: '#alpha', label: 'Alpha', role: 'button', text: 'Alpha' });
    const beta = el({ cssSelector: '#beta', label: 'Beta', ariaLabel: 'Beta' });
    const plan = planActions([flow('a', [click(ORDERS, beta), click(ORDERS, alpha)])], NO_TARGET, 10);

    expect(plan.actions.map((action) => [action.label, action.selector])).toStrictEqual([
      ['Alpha', "getByRole('button', { name: 'Alpha' })"],
      ['Beta', "getByLabel('Beta')"],
    ]);
  });

  it('breaks a tie on label, then on selector, so two runs agree', () => {
    const steps = [click(ORDERS, SAVE_BY_ROLE), click(ORDERS, CANCEL), click(ORDERS, SAVE)];
    const forwards = planActions([flow('a', steps)], NO_TARGET, 10);
    const backwards = planActions([flow('a', [...steps].reverse())], NO_TARGET, 10);

    expect(forwards.actions.map((action) => [action.label, action.selector])).toStrictEqual([
      ['Cancel', "getByLabel('Cancel')"],
      ['Save', "getByLabel('Save')"],
      ['Save', "getByRole('button', { name: 'Save' })"],
    ]);
    expect(backwards.actions).toStrictEqual(forwards.actions);
  });
});

describe('the budget', () => {
  const many = [flow('a', [click(ORDERS, SAVE), click(ORDERS, SAVE), click(ORDERS, CANCEL), click(ORDERS, EMAIL)])];

  it('caps the actions and counts the rest', () => {
    const plan = planActions(many, NO_TARGET, 2);

    expect(plan.actions.map((action) => action.label)).toStrictEqual(['Save', 'Cancel']);
    expect(plan.more).toBe(1);
  });

  it('says nothing about more when the limit fits everything', () => {
    expect(planActions(many, NO_TARGET, 10)).toStrictEqual({
      actions: expect.any(Array) as unknown[],
      skipped: [],
    });
  });

  it('counts everything as more at a limit of zero or below', () => {
    for (const limit of [0, -1]) {
      const plan = planActions(many, NO_TARGET, limit);
      expect(plan.actions).toStrictEqual([]);
      expect(plan.more).toBe(3);
    }
  });
});

describe('what a candidate carries', () => {
  it('flags a selector that fell through to the CSS path, and labels it with that path', () => {
    const plan = planActions([flow('a', [click(ORDERS, ANON)])], NO_TARGET, 10);

    expect(plan.actions).toStrictEqual([
      {
        kind: 'click',
        selector: "locator('main > div:nth-child(3)')",
        label: 'main > div:nth-child(3)',
        url: ORDERS,
        seen: 1,
        flows: ['a'],
        fragile: true,
      },
    ]);
  });

  it('leaves the flag off an element that has an accessible name', () => {
    const plan = planActions([flow('a', [click(ORDERS, SAVE)])], NO_TARGET, 10);

    expect(Object.hasOwn(plan.actions[0] ?? {}, 'fragile')).toBe(false);
  });

  it('calls an element what its label calls it, not what it happens to say', () => {
    // `<label>Email address</label>` on a field whose placeholder reads "Email"
    // is the ordinary case, and the two are not interchangeable to a reader
    // scanning the plan for the field they mean.
    const plan = planActions([flow('a', [click(ORDERS, RENAMED)])], NO_TARGET, 10);

    expect(plan.actions[0]?.label).toBe('Email address');
    expect(plan.actions[0]?.selector).toBe("getByRole('textbox', { name: 'Email' })");
  });

  it('falls back to the aria-label before it falls back to the CSS path', () => {
    const plan = planActions([flow('a', [click(ORDERS, CLOSE)])], NO_TARGET, 10);

    expect(plan.actions[0]?.label).toBe('Close');
  });

  it('carries the value that was actually typed, and none for a click', () => {
    const plan = planActions(
      [flow('a', [input(ORDERS, EMAIL, 'ada@example.test'), click(ORDERS, SAVE)])],
      NO_TARGET,
      10,
    );

    const [typed, clicked] = plan.actions;
    expect(typed).toStrictEqual({
      kind: 'input',
      selector: "getByLabel('Email')",
      label: 'Email',
      value: 'ada@example.test',
      url: ORDERS,
      seen: 1,
      flows: ['a'],
    });
    expect(Object.hasOwn(clicked ?? {}, 'value')).toBe(false);
  });

  it('keeps one of the values typed into a field two people filled in differently', () => {
    const plan = planActions(
      [
        flow('a', [input(ORDERS, EMAIL, 'ada@example.test')]),
        flow('b', [input(ORDERS, EMAIL, 'grace@example.test')]),
      ],
      NO_TARGET,
      10,
    );

    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]?.seen).toBe(2);
    expect(plan.actions[0]?.value).toBe('ada@example.test');
  });

  it('gives a navigation the page it went to as its handle, and its title as its name', () => {
    const plan = planActions([flow('a', [navigate(`${ORDERS}?from=email`, 'Orders')])], NO_TARGET, 10);

    expect(plan.actions).toStrictEqual([
      { kind: 'navigate', selector: ORDERS, label: 'Orders', url: ORDERS, seen: 1, flows: ['a'] },
    ]);
  });

  it('falls back to the page when a navigation was recorded without a title', () => {
    const plan = planActions([flow('a', [navigate(ORDERS, '')])], NO_TARGET, 10);

    expect(plan.actions[0]?.label).toBe(ORDERS);
  });
});
