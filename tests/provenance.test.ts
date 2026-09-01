/**
 * Finding one value in four independent readings of one recording.
 *
 * Everything this module can get wrong is quiet. Nothing throws, every failure
 * still returns a well-formed `ProvenanceResult`, and four of the five are only
 * visible to a reader who already knows the answer:
 *
 *  1. **A layer that was never captured reads as a layer that came back empty.**
 *     "The value is not in any response" and "this flow was sent without its
 *     network calls" are the same shape on the wire and opposite answers. A
 *     reader told the first when the second is true concludes the server never
 *     sent the value and goes looking in the client. This is the behaviour the
 *     module exists to protect and it is the one with no visible symptom.
 *  2. **A `where` that cannot be used.** A hit is only worth the pointer beside
 *     it: an endpoint with no JSON pointer, a pointer with no store, a component
 *     with no prop name are all still "found it", and none of them can be acted
 *     on. Worse, a pointer that is *present but unescaped* looks correct and
 *     resolves to nothing — `/flags/checkout/v2` addresses a node that does not
 *     exist when the key was literally `checkout/v2`.
 *  3. **A raw substring scan leaking into a body that parsed.** `"Order total
 *     £42.00 paid"` is a sentence that mentions the value, not the server
 *     sending the value, and the difference is the whole claim.
 *  4. **A cap that drops instead of counting.** Eight of twelve sightings with
 *     nothing saying so reads as twelve of twelve.
 *  5. **Layer order read as causation.** Nothing here can be asserted about that
 *     — see the order test below, which deliberately asserts the ordering and
 *     deliberately asserts nothing about why.
 *
 * The fixtures are written out by hand rather than produced by `buildPayload`
 * or by a recorder: a fixture built by the code under test agrees with the code
 * under test by construction, and what is being checked here is whether the
 * search agrees with a payload of the shape the extension actually posts.
 */

import { describe as suite, expect, it } from 'vitest';

import { traceValue, valueOfStep } from '../src/core/provenance/index.js';
import type { ElementRef, FlowPayload, NetworkCall, Step } from '../src/shared/types.js';

const BASE = Date.UTC(2026, 7, 20, 9, 30);

/** The value that travels through `CHECKOUT`, long enough not to collide. */
const PRICE = '£42.00';

/**
 * The fields every `ElementRef` must carry and no test here is about.
 *
 * `tag`, `xpath` and `boundingBox` are required by the type and irrelevant to a
 * search over text and selectors; spelling them out on every element would bury
 * the two fields that matter under the six that do not.
 */
const el = (over: Partial<ElementRef> & { cssSelector: string }): ElementRef => ({
  tag: 'div',
  xpath: '//div',
  boundingBox: null,
  ...over,
});

/** Likewise for a call: the search reads the method, the url, the body and the status. */
const call = (
  over: Partial<NetworkCall> & { url: string; responseBody: string | null },
): NetworkCall => ({
  method: 'GET',
  requestHeaders: {},
  requestBody: null,
  status: 200,
  responseHeaders: { 'content-type': 'application/json' },
  durationMs: 40,
  timestamp: BASE,
  ...over,
});

// ── One recording in which a price genuinely travels ─────────────────────────

/**
 * A cart, priced by the server, written to a store, handed to a component and
 * shown on the page — with the same string at each stop.
 *
 * Four steps rather than one, because the layers do not line up in a real
 * recording: the response and the store write land on the click that added the
 * item, the page catches up on the click after it, and the value is typed back
 * in at the end. A one-step fixture would let a hit be attributed to the wrong
 * step without any test noticing.
 */
const CHECKOUT: FlowPayload = {
  schemaVersion: 1,
  id: 'flow-checkout',
  name: 'Checkout',
  timestamp: BASE,
  startUrl: 'https://shop.example.com/cart',
  react: {
    detected: true,
    build: 'development',
    components: {
      cmp_total: {
        name: 'OrderTotal',
        status: 'resolved',
        source: 'src/checkout/OrderTotal.tsx',
      },
    },
  },
  state: { read: true, stores: [{ id: 'redux:0', kind: 'redux', label: 'CartStore' }] },
  renders: { read: true },
  steps: [
    {
      type: 'click',
      url: 'https://shop.example.com/cart',
      timestamp: BASE + 1_000,
      action: 'Clicked "Add to cart"',
      stepNumber: 1,
      element: el({ tag: 'button', cssSelector: '#add-to-cart', text: 'Add to cart' }),
      networkCalls: [
        call({
          method: 'POST',
          url: 'https://shop.example.com/api/cart',
          // The price at two paths, which is what a real cart response looks
          // like — a line and a total that happen to agree.
          responseBody: JSON.stringify({
            cart: { lines: [{ sku: 'W-1', price: PRICE }], total: PRICE },
          }),
        }),
      ],
      state: [
        {
          store: 'redux:0',
          patch: [
            { op: 'replace', path: '/cart/total', value: PRICE },
            { op: 'add', path: '/cart/lines/-', value: { sku: 'W-1', price: PRICE } },
          ],
        },
      ],
      renders: [{ component: 'cmp_total', props: [{ key: 'total', before: '£0.00', after: PRICE }] }],
    },
    {
      type: 'click',
      url: 'https://shop.example.com/cart',
      timestamp: BASE + 2_000,
      action: 'Clicked "Checkout"',
      stepNumber: 2,
      element: el({ tag: 'button', cssSelector: '#checkout', text: 'Checkout' }),
      domDelta: { before: 'Subtotal £0.00 Checkout', after: 'Subtotal £42.00 Checkout' },
      domChanges: { changes: [{ kind: 'text', where: '#order-total', what: '"Total £42.00"' }] },
    },
    {
      type: 'click',
      url: 'https://shop.example.com/checkout',
      timestamp: BASE + 3_000,
      action: 'Clicked "£42.00"',
      stepNumber: 3,
      // Padded on purpose: a page's own indentation is not part of what it
      // said, so this must still read as the element saying *exactly* this.
      element: el({ tag: 'span', cssSelector: '#order-total', text: '  £42.00\n' }),
    },
    {
      type: 'input',
      url: 'https://shop.example.com/checkout',
      timestamp: BASE + 4_000,
      action: 'Typed "£42.00" into Gift amount',
      stepNumber: 4,
      element: el({ tag: 'input', cssSelector: '#gift-amount', text: null, label: 'Gift amount' }),
      value: PRICE,
    },
  ],
};

// ── What a value that travelled looks like ───────────────────────────────────

suite('a value that travels', () => {
  it('is found in all four readings, and listed response → store → render → dom', () => {
    const result = traceValue(CHECKOUT, PRICE);

    /*
     * The order is the direction data moves through a React app, so the answer
     * reads top to bottom as a journey. It is presentation and nothing else:
     * this asserts the *sequence* and deliberately asserts nothing about the
     * response having caused the render. Four sightings of one string are four
     * sightings — `get_causal_chain` is the tool that makes causal claims, out
     * of evidence about events rather than the equality of two strings.
     */
    expect(result.hits.map((hit) => hit.layer)).toEqual([
      'response',
      'store',
      'store',
      'render',
      'dom',
      'dom',
      'dom',
      'dom',
    ]);

    // Nothing was cut, and — the point of the next suite — no layer is claimed
    // unsearched on a recording that carries all four.
    expect(result.more).toEqual({});
    expect(result.unsearched).toEqual([]);
    expect(result.value).toBe(PRICE);
    expect(result.collides).toBe(false);
  });

  it('attributes each sighting to the step it happened on', () => {
    const result = traceValue(CHECKOUT, PRICE);

    // Response, store, store, render all landed on step 1; the page caught up
    // on step 2 and 3, and the value was typed back in on step 4.
    expect(result.hits.map((hit) => hit.step)).toEqual([1, 1, 1, 1, 2, 2, 3, 4]);
  });

  it('numbers steps by position when the recording did not number them', () => {
    /*
     * `stepNumber` is stamped at capture and goes stale after a deletion, so a
     * step can arrive without one. Falling back to the index is right; falling
     * back to the index *without* adding one would report a hit against the
     * step before the one it happened on, which is unfalsifiable from outside.
     */
    const unnumbered: FlowPayload = {
      ...CHECKOUT,
      steps: CHECKOUT.steps.map((step) => ({ ...step, stepNumber: undefined })),
    };

    expect(traceValue(unnumbered, PRICE).hits.map((hit) => hit.step)).toEqual([
      1, 1, 1, 1, 2, 2, 3, 4,
    ]);
  });
});

// ── Whether a hit can be acted on ────────────────────────────────────────────

suite('every hit says where, in terms a reader can use', () => {
  const hits = traceValue(CHECKOUT, PRICE).hits;
  const of = (layer: string) => hits.filter((hit) => hit.layer === layer);

  it('names the call and the JSON pointer inside its body', () => {
    const [response] = of('response');

    // Method, url and pointer together: any one of the three missing leaves a
    // reader who has to re-find the value by hand, which is the work the tool
    // was called to do.
    expect(response.where).toBe('POST https://shop.example.com/api/cart  /cart/lines/0/price');
    expect(response.match).toBe('exact');
    // The first path, the count of the rest, and the status — a 200 and a 500
    // carrying the same price are not the same sighting.
    expect(response.detail).toBe(
      'The response carried it at /cart/lines/0/price, and at 1 other path (200).',
    );
  });

  it('names the store and the pointer into it, the operation’s path included', () => {
    const [total, line] = of('store');

    expect(total.where).toBe('redux:0  /cart/total');
    /*
     * The operation wrote an object and the value sits inside it, so neither
     * half addresses it alone: `/cart/lines/-` is where the write went and
     * `/price` is where the value is within what was written.
     */
    expect(line.where).toBe('redux:0  /cart/lines/-/price');
    expect(total.detail).toContain('replace /cart/total');
    expect(total.detail).toContain('"£42.00"');
  });

  it('names the component and which prop, hook or context carried it', () => {
    const [render] = of('render');

    // The component *id*, because that is what `FlowReact.components` is keyed
    // by and what every other tool in this project takes as an argument.
    expect(render.where).toBe('cmp_total  prop total');
    expect(render.detail).toContain('prop "total"');
    expect(render.detail).toContain('£42.00');
  });

  it('names a selector for every DOM sighting, including changes elsewhere', () => {
    expect(of('dom').map((hit) => hit.where)).toEqual([
      // The element the step touched, for the settled text around it…
      '#checkout',
      // …and the element the change actually happened to, which is a different
      // one: a click on the checkout button rewrote the total in the header.
      '#order-total',
      '#order-total',
      '#gift-amount',
    ]);
  });

  it('reads an element as saying exactly the value despite the page’s whitespace', () => {
    const exact = of('dom').find((hit) => hit.where === '#order-total' && hit.match === 'exact');

    // `#order-total`'s text is `"  £42.00\n"`. Without collapsing it is a
    // `within` match on a string that is, to a reader, precisely the value.
    expect(exact?.detail).toBe('The element interacted with said exactly this.');
  });

  it('marks a value the user typed as where it entered the app', () => {
    const typed = of('dom').find((hit) => hit.where === '#gift-amount');

    // Not one more sighting among four: a value a person typed is the end of
    // the search rather than a stop along it, and the sentence has to say so.
    expect(typed?.match).toBe('exact');
    expect(typed?.detail).toContain('typed');
  });
});

// ── Pointers that address what they name ─────────────────────────────────────

/** One recording, one call, one body — for the cases that are about the body. */
function responseFlow(body: string | null, over: Partial<NetworkCall> = {}): FlowPayload {
  return {
    schemaVersion: 1,
    id: 'flow-body',
    name: 'One call',
    timestamp: BASE,
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/checkout',
        timestamp: BASE,
        action: 'Clicked "Pay"',
        stepNumber: 1,
        element: el({ tag: 'button', cssSelector: '#pay', text: 'Pay' }),
        networkCalls: [
          call({ url: 'https://shop.example.com/api/checkout', responseBody: body, ...over }),
        ],
      },
    ],
  };
}

suite('the pointer is an RFC 6901 pointer, not a path with slashes in it', () => {
  it('escapes `/` as ~1 and `~` as ~0 in a key', () => {
    const flow = responseFlow(
      JSON.stringify({ flags: { 'checkout/v2': { 'price~variant': PRICE } } }),
    );

    /*
     * The bug nobody notices. `/flags/checkout/v2/price~variant` looks like a
     * pointer, is accepted by every eye that reads it, and resolves to nothing
     * — `checkout/v2` is one key, not two, and `~v` is an invalid escape. A
     * reader pastes it into `jq`, gets null, and concludes the tool was wrong
     * about the sighting rather than about the pointer.
     */
    const [hit] = traceValue(flow, PRICE).hits;
    expect(hit.where).toContain('/flags/checkout~1v2/price~0variant');
  });

  it('escapes `~` before `/`, so an escape is not escaped twice', () => {
    // `a/b` naively escaped `/`-first is `a~1b`, and escaping `~` after that
    // turns it into `a~01b` — a pointer to a key that does not exist. Order is
    // the whole of the correctness here.
    const flow = responseFlow(JSON.stringify({ 'a/b': PRICE }));

    expect(traceValue(flow, PRICE).hits[0].where).toContain('/a~1b');
    expect(traceValue(flow, PRICE).hits[0].where).not.toContain('~01');
  });

  it('counts the other paths it did not print, and pluralises the count', () => {
    const flow = responseFlow(JSON.stringify({ a: PRICE, b: PRICE, c: PRICE }));

    // Three sightings in one body is one fact about the body; three pointers is
    // the same fact at three times the price. The count is what is left of the
    // other two, so an off-by-one here overstates or hides a path.
    expect(traceValue(flow, PRICE).hits[0].detail).toBe(
      'The response carried it at /a, and at 2 other paths (200).',
    );
  });
});

// ── Text, not types ──────────────────────────────────────────────────────────

suite('values are compared as text', () => {
  it('finds a JSON number when the reader typed a string', () => {
    const flow = responseFlow(JSON.stringify({ cart: { quantity: 42 } }));
    const result = traceValue(flow, '42');

    // A person asking about a value on a page has a string, and the server sent
    // a number. Comparing types would answer "not found" to a question whose
    // answer is on line one of the body.
    expect(result.hits[0].where).toContain('/cart/quantity');
    expect(result.hits[0].match).toBe('exact');
  });

  it('says a short value collides, and searches anyway', () => {
    const flow = responseFlow(JSON.stringify({ cart: { quantity: 42 } }));
    const result = traceValue(flow, '42');

    /*
     * `"42"` turns up in an ordinary recording by the dozen with no
     * relationship between the sightings. Refusing the search would be deciding
     * for the reader; running it without the warning would let a coincidence
     * read as a journey. Both halves are the behaviour.
     */
    expect(result.collides).toBe(true);
    expect(result.hits).toHaveLength(1);
  });

  it('draws the line at four characters, not three or five', () => {
    const flow = responseFlow(JSON.stringify({ price: 'x' }));

    expect(traceValue(flow, '42').collides).toBe(true);
    expect(traceValue(flow, '£42').collides).toBe(true);
    expect(traceValue(flow, '£420').collides).toBe(false);
    expect(traceValue(flow, PRICE).collides).toBe(false);
  });
});

// ── Bodies that are not a parsed object ──────────────────────────────────────

suite('a body with no path to name', () => {
  it('reports a non-JSON body as a weaker sighting, and says why', () => {
    const flow = responseFlow('<html><body><p>Total £42.00</p></body></html>');
    const [hit] = traceValue(flow, PRICE).hits;

    // A sighting with no pointer is still a sighting, and it must not be
    // dressed as one with a pointer: `where` carries the call and stops there.
    expect(hit.where).toBe('GET https://shop.example.com/api/checkout');
    expect(hit.match).toBe('within');
    expect(hit.detail).toContain('not JSON');
    expect(hit.detail).toContain('no path to name');
    expect(hit.detail).not.toContain('capture cap');
  });

  it('names the cut when the body was truncated mid-JSON', () => {
    const flow = responseFlow('{"cart":{"lines":[{"sku":"W-1","price":"£42.00"', {
      responseBodyTruncated: true,
    });
    const [hit] = traceValue(flow, PRICE).hits;

    /*
     * A body cut at the capture cap does not parse, so it arrives here as "not
     * JSON" — which is true of the *captured text* and misleading about the
     * response. The cut is what tells a reader the missing pointer is DevFlow's
     * limit and not the server's shape.
     */
    expect(hit.match).toBe('within');
    expect(hit.detail).toContain('cut at the capture cap');
  });

  it('finds nothing in a body that parsed and merely mentions the value', () => {
    const flow = responseFlow(JSON.stringify({ summary: 'Order total £42.00 paid' }));

    /*
     * The substring is right there and the answer is still no. A JSON body that
     * held the value at no path does not hold it in its punctuation either, and
     * a prose field that mentions a price is the server *talking about* the
     * value rather than sending it. Falling through to a raw scan here would
     * turn every `message` and `description` field in an app into a provenance
     * hit — plausible, unfalsifiable, and wrong.
     */
    expect(traceValue(flow, PRICE).hits).toEqual([]);
  });

  it('finds nothing when a request failed before a response', () => {
    const flow = responseFlow(null, { status: null });

    expect(traceValue(flow, PRICE).hits).toEqual([]);
  });
});

// ── The difference between "not there" and "never looked" ────────────────────

/** A one-step recording carrying nothing but a click, for the unsearched cases. */
const bare = (over: Partial<FlowPayload> = {}): FlowPayload => ({
  schemaVersion: 1,
  id: 'flow-bare',
  name: 'Bare',
  timestamp: BASE,
  steps: [
    {
      type: 'click',
      url: 'https://shop.example.com/',
      timestamp: BASE,
      action: 'Clicked "Go"',
      stepNumber: 1,
      element: el({ tag: 'button', cssSelector: '#go', text: 'Go' }),
    },
  ],
  ...over,
});

const reasonFor = (flow: FlowPayload, layer: string): string | undefined =>
  traceValue(flow, PRICE).unsearched.find((entry) => entry.layer === layer)?.reason;

suite('a layer the recording never carried is named, not left empty', () => {
  /*
   * The most important behaviour in the module. Every other test here is about
   * a hit; these are about the absence of one, and an absence has two causes
   * that look identical on the wire. A reader told "the value is not in any
   * response" when the truth is "this flow was sent without its responses"
   * stops looking at the server — which is the one conclusion the recording
   * gives no support for at all.
   */

  it('lists all three searchable-but-absent layers on a recording carrying none', () => {
    expect(traceValue(bare(), PRICE).unsearched.map((entry) => entry.layer)).toEqual([
      'response',
      'store',
      'render',
    ]);
    expect(traceValue(bare(), PRICE).unsearched.every((entry) => entry.reason.length > 0)).toBe(
      true,
    );
  });

  it('says the sender withheld the network calls, rather than that none were made', () => {
    // `omitted` exists precisely so the receiving end can say "you did not send
    // that" instead of answering a debugging question with a confident absence.
    expect(reasonFor(bare({ omitted: ['network'] }), 'response')).toMatch(
      /sent without its network calls/,
    );
    expect(reasonFor(bare(), 'response')).toMatch(/No step in this recording captured a network/);
  });

  it('says state capture did not run, rather than that no store moved', () => {
    expect(reasonFor(bare({ state: { read: false, stores: [] } }), 'store')).toMatch(
      /did not read the app/,
    );
    // A recording that *did* read state and found a store that never moved is a
    // fact about the application. The one above is a fact about DevFlow.
    expect(
      reasonFor(bare({ state: { read: true, stores: [{ id: 'redux:0', kind: 'redux' }] } }), 'store'),
    ).toMatch(/No store moved/);
  });

  it('says renders were not sampled, rather than that nothing re-rendered', () => {
    expect(reasonFor(bare({ renders: { read: false } }), 'render')).toMatch(
      /did not sample renders/,
    );
    expect(reasonFor(bare({ renders: { read: true } }), 'render')).toMatch(/No component re-render/);
  });

  it('claims nothing unsearched when a layer was read and simply did not hold it', () => {
    const result = traceValue(CHECKOUT, 'a value nothing in this flow carries');

    /*
     * The other half of the distinction, and the half a test suite usually
     * forgets. `CHECKOUT` carries responses, store writes and renders; none of
     * them held this string. "Not found" is the honest answer and adding an
     * `unsearched` entry here would hedge a real negative into an unusable one.
     */
    expect(result.hits).toEqual([]);
    expect(result.unsearched).toEqual([]);
  });
});

// ── The cap ──────────────────────────────────────────────────────────────────

/**
 * Ten results on one page, each priced the same and each fetched on its own.
 *
 * Ten of each in two different layers, so the overflow count has to be kept per
 * layer: one shared counter would report twenty-minus-eight and be wrong twice.
 */
const CROWDED: FlowPayload = {
  schemaVersion: 1,
  id: 'flow-crowded',
  name: 'Search results',
  timestamp: BASE,
  steps: Array.from({ length: 10 }, (_, index): Step => ({
    type: 'click',
    url: 'https://shop.example.com/search',
    timestamp: BASE + index * 1_000,
    action: `Clicked result ${index + 1}`,
    stepNumber: index + 1,
    element: el({ tag: 'li', cssSelector: `#result-${index + 1}`, text: PRICE }),
    networkCalls: [
      call({
        url: `https://shop.example.com/api/price/${index + 1}`,
        responseBody: JSON.stringify({ price: PRICE }),
      }),
    ],
  })),
};

suite('the per-layer cap', () => {
  it('lists eight of a layer and counts the rest, keyed by layer', () => {
    const result = traceValue(CROWDED, PRICE);

    // A value in ten places in one layer has told the reader what it is going
    // to tell them by the third; the rest is the number.
    expect(result.hits.filter((hit) => hit.layer === 'response')).toHaveLength(8);
    expect(result.hits.filter((hit) => hit.layer === 'dom')).toHaveLength(8);
    // Keyed, not summed — and never silently dropped, which is the failure that
    // makes eight of twelve read as all of them.
    expect(result.more).toEqual({ response: 2, dom: 2 });
  });

  it('keeps the cut inside one layer, so a later layer is still listed', () => {
    // Capping the flat list rather than each layer would spend the whole budget
    // on responses and report a recording with no DOM sightings at all.
    expect(new Set(traceValue(CROWDED, PRICE).hits.map((hit) => hit.layer))).toEqual(
      new Set(['response', 'dom']),
    );
  });

  it('reports no overflow at all when nothing was cut', () => {
    expect(traceValue(CHECKOUT, PRICE).more).toEqual({});
  });
});

// ── The needle itself ────────────────────────────────────────────────────────

suite('an empty needle', () => {
  it('finds nothing rather than matching every string in the recording', () => {
    /*
     * `''.includes('')` is true and `String(node) === ''` is true of every
     * empty leaf, so an unguarded search for nothing returns a hit for most of
     * the DOM layer — an answer that looks like a very well-travelled value.
     */
    for (const needle of ['', '   ', '\n\t ']) {
      const result = traceValue(CHECKOUT, needle);
      expect(result.hits).toEqual([]);
      expect(result.value).toBe('');
      expect(result.collides).toBe(false);
    }
  });

  it('still reports what the recording could not be asked', () => {
    // The needle being empty says nothing about the recording, so the layers a
    // flow does not carry are named either way.
    expect(traceValue(bare(), '  ').unsearched.map((entry) => entry.layer)).toEqual([
      'response',
      'store',
      'render',
    ]);
  });

  it('trims the needle before searching and reports the trimmed form', () => {
    const result = traceValue(CHECKOUT, `  ${PRICE}  `);

    // A value copied out of a cell arrives with the cell's padding on it. What
    // `value` echoes back has to be what was actually searched for, or the
    // reader cannot reproduce the answer.
    expect(result.value).toBe(PRICE);
    expect(result.hits.length).toBeGreaterThan(0);
  });
});

// ── The handle a step offers ─────────────────────────────────────────────────

const step = (over: Partial<Step>): Step =>
  ({
    type: 'click',
    url: 'https://shop.example.com/checkout',
    timestamp: BASE,
    action: 'Clicked something',
    stepNumber: 1,
    element: el({ cssSelector: '#x' }),
    ...over,
  }) as Step;

suite('what a step offers to trace, when the caller names a step', () => {
  it('prefers what the element said, collapsed the way the page said it', () => {
    expect(
      valueOfStep(
        step({ element: el({ cssSelector: '#total', text: '  Total\n  £42.00 ' }), value: 'ignored' }),
      ),
    ).toBe('Total £42.00');
  });

  it('falls back to what the user typed when the element showed nothing', () => {
    /*
     * An `<input>` has no text. Preferring the empty text over the typed value
     * would return `''` for exactly the steps where the value is most certainly
     * known — the ones where a person typed it.
     */
    expect(
      valueOfStep(
        step({
          type: 'input',
          element: el({ tag: 'input', cssSelector: '#email', text: null }),
          value: 'ada@example.com',
        }),
      ),
    ).toBe('ada@example.com');
  });

  it('falls back to the label last, which describes rather than shows', () => {
    // A label is the field's name, not its contents — worth returning when
    // there is nothing else, and worth being third.
    expect(
      valueOfStep(step({ element: el({ tag: 'input', cssSelector: '#email', label: 'Email' }) })),
    ).toBe('Email');
  });

  it('returns an empty string when the step offers no handle at all', () => {
    // A recording has no node ids: an element is described, not addressed. A
    // step that described nothing has nothing to trace, and saying so as `''`
    // is what lets the caller ask for a value instead.
    expect(valueOfStep(step({ element: undefined }))).toBe('');
    expect(
      valueOfStep(step({ element: el({ cssSelector: '#x', text: '   ', label: '\n' }) })),
    ).toBe('');
  });
});

/**
 * The two defects the mutation pass over this file surfaced, pinned so they
 * cannot come back.
 *
 * Neither was found by reading the code and neither would have failed a test:
 * both are the module *reporting* correctly-found evidence in a way that says
 * something untrue about the page. That is the failure mode this whole feature
 * is one careless line away from, which is why they get a section rather than a
 * line each.
 */
suite('what it says about what it found', () => {
  const long =
    'Order 1180 for Ada Lovelace, Analytical Engine spare parts, total £42.00 as of Tuesday';

  const flowShowing = (text: string): FlowPayload => ({
    schemaVersion: 1,
    id: 'flow-quote',
    name: 'Quoting',
    timestamp: BASE,
    steps: [step({ element: el({ cssSelector: '#total', text }) })],
  });

  it('shows the cut inside the quotes when it quotes only part of the text', () => {
    /*
     * The quotation is a claim about what the element said. Cut and presented
     * as complete, it is a wrong one — and it reads perfectly: a closing quote
     * after a trailing space, with nothing anywhere saying the sentence went on.
     * `ElementRef.text` is capped at 80 characters, so this is reachable by any
     * ordinary table cell.
     */
    const [hit] = traceValue(flowShowing(long), PRICE).hits;

    expect(hit.detail).toContain('…"');
    expect(hit.detail.endsWith(' ".')).toBe(false);
  });

  it('does not cut text that fits, and does not quote what it did not cut', () => {
    const [hit] = traceValue(flowShowing(`Total ${PRICE}`), PRICE).hits;
    expect(hit.detail).toContain('"Total £42.00"');
    expect(hit.detail).not.toContain('…');
  });

  it('names the dom layer as unsearched when there was no page text to search', () => {
    /*
     * The other three layers name their own nothing and this one did not, so on
     * a recording with no steps the dom layer alone read as "looked, found
     * nothing" — the exact failure `unsearchedLayers` exists to prevent, on the
     * one layer a reader is most likely to trust.
     */
    const empty = {
      schemaVersion: 1,
      id: 'flow-empty',
      name: 'Nothing',
      timestamp: BASE,
      steps: [],
    } as unknown as FlowPayload;

    const layers = traceValue(empty, PRICE).unsearched.map((gap) => gap.layer);
    expect(layers).toContain('dom');
    // Last, so the list reads in the order the layers themselves are reported.
    expect(layers).toEqual(['response', 'store', 'render', 'dom']);
  });

  it('does not call the dom unsearched when a step touched an element', () => {
    const layers = traceValue(flowShowing('anything'), PRICE).unsearched.map((gap) => gap.layer);
    expect(layers).not.toContain('dom');
  });
});
