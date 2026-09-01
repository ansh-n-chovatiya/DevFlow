// @vitest-environment jsdom
/**
 * What one interaction did to the document, from the records to the reply.
 *
 * Three things can go wrong here and only one of them looks like a bug:
 *
 *  1. **The observer reports DevFlow.** The recording indicator is removed and
 *     re-added around every screenshot, so a collector that does not know its
 *     own DOM opens every step with a `div` appearing and going in `<body>`.
 *     That is a working feature by every other measure — records arrive, groups
 *     fold, a line is printed — and it is wrong on every step of every flow.
 *  2. **The cap does not bite.** The reverted v3.2.0 attempt pushed every record
 *     into an unbounded array. A cap that is checked after a batch rather than
 *     before each record has already paid for the batch, and the batch is the
 *     page's size.
 *  3. **The budget is spent on noise.** A CSS transition writes one attribute
 *     sixty times; a dialog mounting is one record. Any ordering that prefers
 *     the busy thing spends the whole step on the transition, and does it worst
 *     on the steps somebody opened because something happened.
 *
 * The collector is driven with a **real** `MutationObserver` over a real jsdom
 * document rather than with hand-made record objects, because a hand-made
 * record is a fixture of what the author believes `MutationRecord` is: two of
 * the cases below (a text node swapped out, an attribute removed) arrive as a
 * different record type than one would write by hand.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe as suite, expect, it } from 'vitest';

import {
  collect,
  collectorFull,
  createCollector,
  describe,
  isDevFlowNode,
  planDomChanges,
  type DomObservation,
} from '../src/core/dom/index.js';
import { INDICATOR_ID } from '../src/shared/constants.js';
import { buildPayload, pruneSteps } from '../src/features/mcp/send.js';
import type { Step, StepDomChanges } from '../src/shared/types.js';

const NOW = 1_700_000_000_000;

/**
 * Run a mutation and hand the collector exactly what the browser saw.
 *
 * `takeRecords` rather than waiting for the callback: the delivery is a
 * microtask, and a test that awaits it is a test whose timing is the thing
 * being asserted. The recorder drains with `takeRecords` too, when its window
 * closes, so this is the same path.
 */
function watch(cap: number, mutate: () => void): ReturnType<typeof createCollector> {
  const collector = createCollector(cap);
  const observer = new MutationObserver(() => {});
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true,
  });
  mutate();
  collect(collector, observer.takeRecords());
  observer.disconnect();
  return collector;
}

/**
 * What a window would report, described under a budget wide enough not to bite.
 *
 * The budget is `describe`'s argument rather than a later filter, and that is
 * the point: only the groups that will be printed are ever handed to
 * `generateSelector`, which is a `querySelectorAll` per candidate and runs
 * inside the user's click. Passing a wide cap here keeps these cases about what
 * was *seen*; `budgeted()` below is where the cut itself is asserted.
 */
function seen(cap: number, mutate: () => void): DomObservation[] {
  return describe(watch(cap, mutate), 100).observed;
}

/** The same, under a real budget, so what `describe` refuses to describe shows. */
function budgeted(
  cap: number,
  maxChanges: number,
  mutate: () => void,
): { observed: DomObservation[]; more: number } {
  return describe(watch(cap, mutate), maxChanges);
}

function reset(html: string): void {
  document.body.innerHTML = html;
}

// ── What the collector sees ──────────────────────────────────────────────────

suite('what one window saw', () => {
  it('names a node that appeared, and the element it appeared in', () => {
    reset('<main id="page"></main>');

    const observed = seen(100, () => {
      const dialog = document.createElement('div');
      dialog.id = 'confirm';
      dialog.setAttribute('role', 'dialog');
      dialog.textContent = 'Delete this order?';
      document.getElementById('page')!.append(dialog);
    });

    expect(observed).toHaveLength(1);
    expect(observed[0].kind).toBe('added');
    // The parent, because that is the thing that still exists to be pointed at.
    expect(observed[0].where).toBe('#page');
    expect(observed[0].what).toContain('div#confirm[role=dialog]');
    expect(observed[0].what).toContain('Delete this order?');
  });

  it('folds many of one shape into one observation with a count', () => {
    reset('<table><tbody id="orders"></tbody></table>');

    const observed = seen(100, () => {
      const body = document.getElementById('orders')!;
      for (let i = 0; i < 10; i++) {
        const row = document.createElement('tr');
        row.textContent = `Order ${1180 + i}`;
        body.append(row);
      }
    });

    /*
     * One, not ten. Ten near-identical lines answer "what did this interaction
     * do" ten times, and the ten would be the whole of a twelve-change budget.
     */
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'added', where: '#orders', count: 10 });
  });

  it('reports the value an attribute settled at, not the ones it passed through', () => {
    reset('<button id="menu" aria-expanded="false">Menu</button>');

    const observed = seen(100, () => {
      const menu = document.getElementById('menu')!;
      menu.setAttribute('aria-expanded', 'true');
      menu.setAttribute('aria-expanded', 'false');
      menu.setAttribute('aria-expanded', 'true');
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'attribute', where: '#menu', count: 3 });
    // The window closes once. `true` is what is true at the end; `false` is a
    // state the step passed through, and printing it would read as where it
    // ended up.
    expect(observed[0].what).toBe('aria-expanded="true"');
  });

  it('distinguishes an attribute that is gone from one that is empty', () => {
    reset('<button id="save" disabled>Save</button>');

    const observed = seen(100, () => {
      document.getElementById('save')!.removeAttribute('disabled');
    });

    expect(observed[0].what).toBe('disabled removed');
  });

  it('calls a text node swapped out a text change, like a rewritten one', () => {
    reset('<span id="badge">3 items</span><span id="total">£42.00</span>');

    const swapped = seen(100, () => {
      const badge = document.getElementById('badge')!;
      badge.replaceChildren(document.createTextNode('4 items'));
    });
    const rewritten = seen(100, () => {
      document.getElementById('total')!.firstChild!.textContent = '£56.00';
    });

    /*
     * One framework replaces the text node and another writes through it. They
     * arrive as different record types and they are the same fact to a reader,
     * so they get the same answer — and the added/removed node is *not* also
     * reported as a node appearing, which would double-count one change.
     */
    expect(swapped).toHaveLength(1);
    expect(swapped[0]).toMatchObject({ kind: 'text', where: '#badge', what: '"4 items"' });
    expect(rewritten).toHaveLength(1);
    expect(rewritten[0]).toMatchObject({ kind: 'text', where: '#total', what: '"£56.00"' });
  });

  it('points at the parent when a node is removed, and still names what went', () => {
    reset('<div id="page"><div id="modal" role="dialog">Confirm</div></div>');

    const observed = seen(100, () => {
      document.getElementById('modal')!.remove();
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'removed', where: '#page' });
    expect(observed[0].what).toContain('div#modal[role=dialog]');
  });
});

// ── What it refuses ──────────────────────────────────────────────────────────

suite('what the collector refuses to report', () => {
  it('never reports DevFlow’s own indicator, which moves on every step', () => {
    reset('<main id="page"></main>');
    const indicator = document.createElement('div');
    indicator.id = INDICATOR_ID;
    document.body.append(indicator);

    const observed = seen(100, () => {
      // Exactly what `renderIndicator` does around every screenshot.
      indicator.remove();
      document.body.append(indicator);
      indicator.textContent = 'Paused';
      indicator.classList.toggle('paused', true);
    });

    /*
     * The failure this is here for is not a crash. Without the refusal every
     * step of every flow opens with a div appearing and going in `<body>` —
     * DevFlow reporting on DevFlow, at the top of a twelve-change budget, and
     * indistinguishable from a real change to anyone reading the recording.
     */
    expect(observed).toEqual([]);
  });

  it('recognises a node inside DevFlow’s own DOM, not only the node itself', () => {
    const host = document.createElement('div');
    host.id = INDICATOR_ID;
    const inner = document.createElement('span');
    inner.textContent = 'Recording';
    host.append(inner);
    document.body.append(host);

    expect(isDevFlowNode(host)).toBe(true);
    expect(isDevFlowNode(inner)).toBe(true);
    expect(isDevFlowNode(inner.firstChild)).toBe(true);
    expect(isDevFlowNode(document.body)).toBe(false);
  });

  it('drops stylesheets, scripts and indentation, which are the toolchain', () => {
    reset('<main id="page"></main>');

    const observed = seen(100, () => {
      const page = document.getElementById('page')!;
      page.append(document.createElement('style'));
      page.append(document.createElement('script'));
      // What a template's indentation looks like to an observer.
      page.append(document.createTextNode('\n    '));
    });

    expect(observed).toEqual([]);
  });
});

suite('what is described, and what is not described at all', () => {
  it('describes only what fits the budget, and counts the rest', () => {
    reset('<div id="box"></div>');

    /*
     * The finding this case exists for. The group map is bounded by the
     * *record* cap and a step reports a dozen, so describing every group and
     * then keeping twelve built four hundred selectors and threw away three
     * hundred and eighty-eight — each one a `querySelectorAll` and a walk to
     * the root, synchronously inside the user's next click. That is not a
     * slower version of the feature; it is the cost profile the whole rewrite
     * exists to avoid, one function further along.
     *
     * A described observation is the evidence: nothing else in the pipeline
     * builds a selector, so counting them counts the work.
     */
    const box = document.getElementById('box')!;
    for (let i = 0; i < 40; i++) {
      const cell = document.createElement('div');
      cell.id = `cell-${i}`;
      box.append(cell);
    }

    // Forty *distinct* groups: one per parent. Appending forty children to one
    // parent is one group with a count of forty, which is the fold working and
    // not the budget being exercised.
    const { observed, more } = budgeted(200, 3, () => {
      for (let i = 0; i < 40; i++) {
        document.getElementById(`cell-${i}`)!.append(document.createElement('span'));
      }
    });

    expect(observed).toHaveLength(3);
    expect(more).toBe(37);
  });

  it('keeps first-seen order out of the collector, which the ranking rests on', () => {
    reset('<div id="a"></div><div id="b"></div><div id="c"></div>');

    /*
     * `planDomChanges` sorts stably *so that* first-seen order survives inside
     * a rank, and first-seen order is temporal order — the first structural
     * change after a click is the one most likely to be what the click did.
     * That property lives here, in `Map` iteration order, and reversing it
     * would leave every other case in this file green.
     */
    const { observed } = budgeted(200, 100, () => {
      for (const id of ['a', 'b', 'c']) {
        document.getElementById(id)!.append(document.createElement('span'));
      }
    });

    expect(observed.map((entry) => entry.where)).toEqual(['#a', '#b', '#c']);
  });

  it('refuses a stylesheet that is written through, not only one that appears', () => {
    reset('<style id="sheet">.a{}</style><button id="menu">Menu</button>');

    /*
     * The added/removed filter never sees this: a `<style>` appended once and
     * then rewritten arrives as `characterData` and `attributes` records on a
     * node that did not come or go during the window — which is exactly what
     * Vite's HMR and styled-components in development do on every render.
     * Reported, it ranks as a text change, which is *above every attribute
     * change*, so on a development build it takes the budget from the
     * `aria-expanded` the step was opened for.
     */
    const observed = seen(200, () => {
      const sheet = document.getElementById('sheet')!;
      sheet.firstChild!.textContent = '.a{color:blue}';
      sheet.setAttribute('media', 'screen');
      document.getElementById('menu')!.setAttribute('aria-expanded', 'true');
    });

    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ kind: 'attribute', where: '#menu' });
  });
});

// ── The cap ──────────────────────────────────────────────────────────────────

suite('the cap, which is the whole point of the rewrite', () => {
  it('stops at the record cap and says the window was cut', () => {
    reset('<div id="box"></div>');

    const collector = watch(3, () => {
      const box = document.getElementById('box')!;
      for (let i = 0; i < 40; i++) box.setAttribute('data-frame', String(i));
    });

    /*
     * Forty records delivered in one batch, three looked at. Checked before
     * each record rather than after the batch: the batch is the page's size,
     * and a page rebuilding a virtualised list delivers thousands in one call.
     */
    expect(collector.seen).toBe(3);
    expect(collector.capped).toBe(true);
    expect(collectorFull(collector)).toBe(true);
  });

  it('stops when one record opens more groups than the cap holds', () => {
    reset('<div id="box"></div>');

    /*
     * One `childList` record can carry hundreds of added nodes, so the record
     * count alone does not bound how many groups exist — the group map needs
     * its own check or the cap is not a bound at all.
     */
    const collector = watch(4, () => {
      const fragment = document.createDocumentFragment();
      for (const tag of ['p', 'span', 'em', 'b', 'i', 'u', 'code', 'small']) {
        fragment.append(document.createElement(tag));
      }
      document.getElementById('box')!.append(fragment);
    });

    expect(collector.seen).toBe(1);
    expect(collector.groups.size).toBeLessThanOrEqual(4);
    expect(collector.capped).toBe(true);
  });

  it('does not claim a cut on a window that finished', () => {
    reset('<div id="box"></div>');
    const collector = watch(100, () => {
      document.getElementById('box')!.setAttribute('data-state', 'open');
    });

    expect(collector.capped).toBe(false);
    expect(collectorFull(collector)).toBe(false);
  });
});

// ── The budget ───────────────────────────────────────────────────────────────

const observation = (over: Partial<DomObservation>): DomObservation => ({
  kind: 'attribute',
  where: '#x',
  count: 1,
  ...over,
});

suite('what survives the budget', () => {
  it('keeps structure over text over attributes, and style last of all', () => {
    const observed: DomObservation[] = [
      observation({ kind: 'attribute', attribute: 'style', where: '#animating', count: 60 }),
      observation({ kind: 'attribute', attribute: 'aria-expanded', where: '#menu' }),
      observation({ kind: 'text', where: '#badge' }),
      observation({ kind: 'added', where: '#page' }),
    ];

    const { changes } = planDomChanges(observed, { maxChanges: 4 });

    /*
     * The ordering this feature lives or dies on. The busiest observation here
     * is a CSS transition writing `style` sixty times and the most interesting
     * is a dialog mounting, which is one record — so *any* ordering by count
     * puts the transition first and, at a real budget, drops the dialog.
     */
    expect(changes.map((change) => change.where)).toEqual([
      '#page',
      '#badge',
      '#menu',
      '#animating',
    ]);
  });

  it('drops the least of what was seen, and says how many', () => {
    const observed: DomObservation[] = [
      observation({ kind: 'attribute', attribute: 'style', where: '#a', count: 99 }),
      observation({ kind: 'attribute', attribute: 'style', where: '#b', count: 99 }),
      observation({ kind: 'added', where: '#page' }),
    ];

    const plan = planDomChanges(observed, { maxChanges: 1 });

    expect(plan.changes).toHaveLength(1);
    expect(plan.changes[0].where).toBe('#page');
    expect(plan.more).toBe(2);
  });

  it('keeps first-seen order inside one rank, which is the order things happened', () => {
    const observed: DomObservation[] = [
      observation({ kind: 'added', where: '#first' }),
      observation({ kind: 'added', where: '#second', count: 40 }),
      observation({ kind: 'added', where: '#third' }),
    ];

    const { changes } = planDomChanges(observed, { maxChanges: 3 });

    // Records arrive in the order the mutations happened, so the first
    // structural change after a click is the one most likely to be what the
    // click did. The busiest is not.
    expect(changes.map((change) => change.where)).toEqual(['#first', '#second', '#third']);
  });

  it('says nothing about a count of one, and says the count above it', () => {
    const { changes } = planDomChanges(
      [observation({ kind: 'added', where: '#a' }), observation({ kind: 'added', where: '#b', count: 4 })],
      { maxChanges: 10 },
    );

    expect('count' in changes[0]).toBe(false);
    expect(changes[1].count).toBe(4);
  });

  it('reports no changes and no overflow for a window that saw nothing', () => {
    expect(planDomChanges([], { maxChanges: 12 })).toEqual({ changes: [] });
  });
});

// ── The field, hop by hop ────────────────────────────────────────────────────

/**
 * Every hop between the page and the saved flow.
 *
 * `state` was captured correctly and a named-field copy in the save path did
 * not list it, so every real recording lost its stores while every fixture kept
 * them. There are now two such copies — `buildPayload` and the server's
 * `saveFlow` — and this walks the field rather than the layer. The two modules
 * that cannot be imported (a content script and a service worker both register
 * listeners at import) are read as source, exactly as `render-sampling` reads
 * them; the pure ones are called.
 */
suite('the domChanges field, hop by hop', () => {
  const read = (relative: string): string =>
    readFileSync(path.join(process.cwd(), relative), 'utf8');
  const contentSource = read('src/content/index.ts');
  const workerSource = read('src/background/index.ts');
  const serverSource = read('mcp-server/server.js');

  const changes: StepDomChanges = {
    changes: [{ kind: 'added', where: '#page', what: 'div#toast[role=alert] "Failed"' }],
    capped: true,
    more: 3,
  };

  const step: Step = {
    type: 'click',
    url: 'https://app.example.com/checkout',
    timestamp: NOW,
    action: 'Clicked "Place order"',
    stepNumber: 1,
    element: {
      tag: 'button',
      cssSelector: '#place-order',
      xpath: '//button',
      boundingBox: null,
      react: { chain: ['cmp_1'], owner: 'cmp_1' },
    },
    domChanges: changes,
  };

  /**
   * Two behaviours the design calls the point of the feature, asserted on the
   * source because the module that holds them cannot be imported — a content
   * script registers listeners and reaches for `chrome` at import.
   *
   * A source assertion is a weak test and these are deliberately written as
   * strongly as one can be: they name the *exact expression*, so deleting it or
   * loosening it fails, and only a rewrite that preserves the text passes. An
   * adversarial review of this work stream deleted both and found every suite
   * still green, which is what a source test that greps for a nearby phrase
   * buys you.
   */
  it('opens no window at all when the setting is off', () => {
    // `recording.domMutations` is `wired: true` in the field table and the
    // changelog says the feature is refusable. Without this line the observer
    // attaches on every recorded page whatever the setting says.
    expect(contentSource).toContain("if (!frozen['recording.domMutations']) return;");
  });

  it('still speaks when the observer was cut and nothing survived', () => {
    /*
     * The one thing this feature must be able to say. An empty list under
     * `capped` is the difference between a step where nothing happened and one
     * where nobody was still looking, and a "nothing to attach" shortcut is
     * exactly where it would be lost — the code comment, `StepDomChangesMessage`
     * and `attachDomChanges` all say so, and none of them is executable.
     */
    expect(contentSource).toContain(
      'if (!plan.changes.length && !open.collector.capped) return;',
    );
  });

  it('never lets a description failure take the step with it', () => {
    // `closeDomWindow` runs before the step is sent, and describing a group is
    // the only work in it that touches a page DevFlow did not write.
    const start = contentSource.indexOf('function closeDomWindow(');
    expect(start).toBeGreaterThan(-1);
    const body = contentSource.slice(start, start + 2600);
    expect(body).toContain('try {');
    expect(body).toContain('} catch {');
  });

  it('opens a window on every step that has an element, beside the region read', () => {
    expect(contentSource).toContain('watchDomMutations(stepKey(step))');
    // One window at a time: the previous step's is closed as the next opens, so
    // a mutation belongs to exactly one step.
    expect(contentSource).toContain('closeDomWindow(true);');
    expect(contentSource).toContain("type: 'STEP_DOM_CHANGES'");
  });

  it('disconnects the observer when a recording stops, rather than reporting', () => {
    /*
     * The half that must happen either way. A window still open when a
     * recording ends belongs to a step already in a finished flow, so nothing
     * is attached — but an observer left attached to a page nobody is recording
     * is exactly the thing this feature exists not to be.
     */
    const start = contentSource.indexOf('function clearBuffers()');
    expect(start).toBeGreaterThan(-1);
    expect(contentSource.slice(start, start + 900)).toContain('closeDomWindow(false)');
  });

  it('merges the summary onto the step in the worker', () => {
    expect(workerSource).toContain("case 'STEP_DOM_CHANGES':");
    const start = workerSource.indexOf('async function attachDomChanges(');
    expect(start).toBeGreaterThan(-1);
    const attach = workerSource.slice(start, start + 1400);
    expect(attach).toMatch(/\.\.\.recordedSteps\[index\],\s*\n?\s*domChanges/);
    // An empty list under `capped` is the one thing this feature must be able
    // to say, and a "nothing to attach" shortcut is where it would be lost.
    expect(attach).toContain('if (!changes.length && !capped) return;');
  });

  it('survives the send path, including with React switched off', () => {
    const kept = pruneSteps([step], { images: false, network: false, logs: false, react: false });

    /*
     * Unlike `renders`, which is keyed by component id and has to go when the
     * component table does. A DOM change names an element, so it stays readable
     * in a payload with no React in it at all.
     */
    expect(kept[0].domChanges).toEqual(changes);

    const payload = buildPayload('flow-1', 'Checkout', [step], NOW);
    expect(payload.steps[0].domChanges).toEqual(changes);
  });

  it('is printed by the tool that answers for a step, cap and overflow included', () => {
    /*
     * A field no tool prints does not exist from outside. Asserted against the
     * server's source because the rendering itself is covered end to end in
     * `mcp-step-detail`, and what is checked here is that the three facts each
     * reach a line of their own: the change, the overflow, and the cut.
     */
    expect(serverSource).toContain('function domChangeLine(');
    expect(serverSource).toContain('step.domChanges');
    expect(serverSource).toContain('The observer stopped early on this step');
    expect(serverSource).toContain('more change');
  });
});
