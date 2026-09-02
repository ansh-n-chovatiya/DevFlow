/**
 * Finding one value in four independent readings of one recording, and in the
 * work the server did behind it.
 *
 * Everything this module can get wrong is quiet. Nothing throws, every failure
 * still returns a well-formed `ProvenanceResult`, and six of the seven are only
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
 *  6. **One span rendered as several sightings.** The fifth layer searches five
 *     fields of one span, and an error span carries the same sentence in three
 *     of them because `recordException`, `setStatus` and the driver's own stack
 *     trace all say it. Counted three times it inflates the only thing this
 *     module asks a reader to weigh, and it does so on the failure path, where
 *     they are least able to check.
 *  7. **A chain filed under the wrong step.** The backend half of an answer is
 *     matched to the browser half by a key built out of a step number, and a
 *     recording is free to number its steps however it likes. The two halves
 *     drifting apart produces a sighting with no chain beneath it — and nothing
 *     anywhere saying that a chain existed.
 *
 * The browser-side fixtures are written out by hand rather than produced by
 * `buildPayload` or by a recorder: a fixture built by the code under test
 * agrees with the code under test by construction, and what is being checked
 * here is whether the search agrees with a payload of the shape the extension
 * actually posts. The spans are the opposite case and the rule inverts — they
 * are somebody else's wire format, so they are two real captures off a real
 * exporter, read through the real `readOtlpTraces` and joined by the real
 * `joinTrace`. An invented OTLP payload would only ever prove that this file
 * agrees with whoever invented it.
 */

import { describe as suite, expect, it } from 'vitest';

import { joinTrace, readOtlpTraces, tracedCallsOf, type OtelSpan } from '../src/core/otel/index.js';
import {
  traceValue,
  valueOfStep,
  type BackendInput,
  type ProvenanceResult,
} from '../src/core/provenance/index.js';
import type { ElementRef, FlowPayload, NetworkCall, Step } from '../src/shared/types.js';

const BASE = Date.UTC(2026, 7, 20, 9, 30);

/**
 * The backend input for every test that is not about the backend.
 *
 * `backend` is a required argument, so each of the four browser-side layers has
 * to say something about the fifth to be tested at all, and this is the honest
 * thing to say on a recording made against a server with no span ingest: the
 * layer was not searched, and the result says so. It is *not* neutral, and that
 * is the point — the alternative, an `available: true` input with an empty
 * join, would claim the recording carried no traced call, which would be a
 * second false statement rather than none. Every assertion below that lists
 * `unsearched` layers therefore lists `backend` first, deliberately and in
 * full: filtering it out of those lists would hide a real regression, since a
 * backend entry appearing on the wrong branch is exactly what the last suite in
 * this file is about.
 */
const INGEST_OFF: BackendInput = { available: false, reason: 'ingest-off' };

const layersOf = (result: ProvenanceResult): string[] =>
  result.unsearched.map((entry) => entry.layer);

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
    const result = traceValue(CHECKOUT, PRICE, INGEST_OFF);

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
    // unsearched on a recording that carries all four. `backend` is the whole
    // of the list because this fixture is run against a server with ingest off;
    // none of the four the recording *does* carry may appear beside it.
    expect(result.more).toEqual({});
    expect(layersOf(result)).toEqual(['backend']);
    expect(result.value).toBe(PRICE);
    expect(result.collides).toBe(false);
  });

  it('attributes each sighting to the step it happened on', () => {
    const result = traceValue(CHECKOUT, PRICE, INGEST_OFF);

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

    expect(traceValue(unnumbered, PRICE, INGEST_OFF).hits.map((hit) => hit.step)).toEqual([
      1, 1, 1, 1, 2, 2, 3, 4,
    ]);
  });
});

// ── Whether a hit can be acted on ────────────────────────────────────────────

suite('every hit says where, in terms a reader can use', () => {
  const hits = traceValue(CHECKOUT, PRICE, INGEST_OFF).hits;
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
    const [hit] = traceValue(flow, PRICE, INGEST_OFF).hits;
    expect(hit.where).toContain('/flags/checkout~1v2/price~0variant');
  });

  it('escapes `~` before `/`, so an escape is not escaped twice', () => {
    // `a/b` naively escaped `/`-first is `a~1b`, and escaping `~` after that
    // turns it into `a~01b` — a pointer to a key that does not exist. Order is
    // the whole of the correctness here.
    const flow = responseFlow(JSON.stringify({ 'a/b': PRICE }));

    expect(traceValue(flow, PRICE, INGEST_OFF).hits[0].where).toContain('/a~1b');
    expect(traceValue(flow, PRICE, INGEST_OFF).hits[0].where).not.toContain('~01');
  });

  it('counts the other paths it did not print, and pluralises the count', () => {
    const flow = responseFlow(JSON.stringify({ a: PRICE, b: PRICE, c: PRICE }));

    // Three sightings in one body is one fact about the body; three pointers is
    // the same fact at three times the price. The count is what is left of the
    // other two, so an off-by-one here overstates or hides a path.
    expect(traceValue(flow, PRICE, INGEST_OFF).hits[0].detail).toBe(
      'The response carried it at /a, and at 2 other paths (200).',
    );
  });
});

// ── Text, not types ──────────────────────────────────────────────────────────

suite('values are compared as text', () => {
  it('finds a JSON number when the reader typed a string', () => {
    const flow = responseFlow(JSON.stringify({ cart: { quantity: 42 } }));
    const result = traceValue(flow, '42', INGEST_OFF);

    // A person asking about a value on a page has a string, and the server sent
    // a number. Comparing types would answer "not found" to a question whose
    // answer is on line one of the body.
    expect(result.hits[0].where).toContain('/cart/quantity');
    expect(result.hits[0].match).toBe('exact');
  });

  it('says a short value collides, and searches anyway', () => {
    const flow = responseFlow(JSON.stringify({ cart: { quantity: 42 } }));
    const result = traceValue(flow, '42', INGEST_OFF);

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

    expect(traceValue(flow, '42', INGEST_OFF).collides).toBe(true);
    expect(traceValue(flow, '£42', INGEST_OFF).collides).toBe(true);
    expect(traceValue(flow, '£420', INGEST_OFF).collides).toBe(false);
    expect(traceValue(flow, PRICE, INGEST_OFF).collides).toBe(false);
  });
});

// ── Bodies that are not a parsed object ──────────────────────────────────────

suite('a body with no path to name', () => {
  it('reports a non-JSON body as a weaker sighting, and says why', () => {
    const flow = responseFlow('<html><body><p>Total £42.00</p></body></html>');
    const [hit] = traceValue(flow, PRICE, INGEST_OFF).hits;

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
    const [hit] = traceValue(flow, PRICE, INGEST_OFF).hits;

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
    expect(traceValue(flow, PRICE, INGEST_OFF).hits).toEqual([]);
  });

  it('finds nothing when a request failed before a response', () => {
    const flow = responseFlow(null, { status: null });

    expect(traceValue(flow, PRICE, INGEST_OFF).hits).toEqual([]);
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
  traceValue(flow, PRICE, INGEST_OFF).unsearched.find((entry) => entry.layer === layer)?.reason;

suite('a layer the recording never carried is named, not left empty', () => {
  /*
   * The most important behaviour in the module. Every other test here is about
   * a hit; these are about the absence of one, and an absence has two causes
   * that look identical on the wire. A reader told "the value is not in any
   * response" when the truth is "this flow was sent without its responses"
   * stops looking at the server — which is the one conclusion the recording
   * gives no support for at all.
   */

  it('lists every searchable-but-absent layer on a recording carrying none', () => {
    // Four, not three: `backend` joins the list under `INGEST_OFF`, and it
    // leads because that is the order the layers themselves are reported in.
    expect(layersOf(traceValue(bare(), PRICE, INGEST_OFF))).toEqual([
      'backend',
      'response',
      'store',
      'render',
    ]);
    expect(
      traceValue(bare(), PRICE, INGEST_OFF).unsearched.every((entry) => entry.reason.length > 0),
    ).toBe(true);
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
    const result = traceValue(CHECKOUT, 'a value nothing in this flow carries', INGEST_OFF);

    /*
     * The other half of the distinction, and the half a test suite usually
     * forgets. `CHECKOUT` carries responses, store writes and renders; none of
     * them held this string. "Not found" is the honest answer and adding an
     * `unsearched` entry here would hedge a real negative into an unusable one.
     */
    expect(result.hits).toEqual([]);
    // Only the backend, which this server genuinely could not search.
    expect(layersOf(result)).toEqual(['backend']);
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
    const result = traceValue(CROWDED, PRICE, INGEST_OFF);

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
    expect(new Set(traceValue(CROWDED, PRICE, INGEST_OFF).hits.map((hit) => hit.layer))).toEqual(
      new Set(['response', 'dom']),
    );
  });

  it('reports no overflow at all when nothing was cut', () => {
    expect(traceValue(CHECKOUT, PRICE, INGEST_OFF).more).toEqual({});
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
      const result = traceValue(CHECKOUT, needle, INGEST_OFF);
      expect(result.hits).toEqual([]);
      expect(result.value).toBe('');
      expect(result.collides).toBe(false);
    }
  });

  it('still reports what the recording could not be asked', () => {
    // The needle being empty says nothing about the recording, so the layers a
    // flow does not carry are named either way.
    expect(layersOf(traceValue(bare(), '  ', INGEST_OFF))).toEqual([
      'backend',
      'response',
      'store',
      'render',
    ]);
  });

  it('trims the needle before searching and reports the trimmed form', () => {
    const result = traceValue(CHECKOUT, `  ${PRICE}  `, INGEST_OFF);

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
    const [hit] = traceValue(flowShowing(long), PRICE, INGEST_OFF).hits;

    expect(hit.detail).toContain('…"');
    expect(hit.detail.endsWith(' ".')).toBe(false);
  });

  it('does not cut text that fits, and does not quote what it did not cut', () => {
    const [hit] = traceValue(flowShowing(`Total ${PRICE}`), PRICE, INGEST_OFF).hits;
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

    const layers = layersOf(traceValue(empty, PRICE, INGEST_OFF));
    expect(layers).toContain('dom');
    // Last, so the list reads in the order the layers themselves are reported —
    // which now begins at the backend and ends at the page.
    expect(layers).toEqual(['backend', 'response', 'store', 'render', 'dom']);
  });

  it('does not call the dom unsearched when a step touched an element', () => {
    const layers = layersOf(traceValue(flowShowing('anything'), PRICE, INGEST_OFF));
    expect(layers).not.toContain('dom');
  });
});

// ── The fifth layer: what the server did ─────────────────────────────────────

/**
 * Four `ExportTraceServiceRequest` bodies, exactly as a Node exporter sent
 * them — the capture `tests/otel.test.ts` and `tests/arkg-otel.test.ts` are
 * built on, copied in as text so that nothing here can quietly tidy one up.
 *
 * They are in the order they were captured, which is the order that matters:
 * the `SELECT` is first and the server span that caused it is third, because a
 * span is exported when it *ends* and a child ends before its parent. Every
 * span below is joined to a recorded call through `readOtlpTraces` →
 * `joinTrace` → `tracedCallsOf` rather than by hand, so a change in the join is
 * a change these tests see.
 */
const DELIVERIES: readonly string[] = [
  `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout-api"}},{"key":"service.version","value":{"stringValue":"2.4.1"}},{"key":"deployment.environment","value":{"stringValue":"staging"}}],"droppedAttributesCount":0},"scopeSpans":[{"scope":{"name":"probe"},"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"29abc6b630d1e717","parentSpanId":"e014090292b7a0de","name":"SELECT invoices","kind":3,"startTimeUnixNano":"1788364167355000000","endTimeUnixNano":"1788364167355043667","attributes":[{"key":"db.system.name","value":{"stringValue":"postgresql"}},{"key":"db.namespace","value":{"stringValue":"shop"}},{"key":"db.query.text","value":{"stringValue":"SELECT total_amount FROM invoices WHERE id = $1"}},{"key":"db.collection.name","value":{"stringValue":"invoices"}}],"droppedAttributesCount":0,"events":[],"droppedEventsCount":0,"status":{"code":0},"links":[],"droppedLinksCount":0,"flags":257}]}]}]}`,
  `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout-api"}},{"key":"service.version","value":{"stringValue":"2.4.1"}},{"key":"deployment.environment","value":{"stringValue":"staging"}}],"droppedAttributesCount":0},"scopeSpans":[{"scope":{"name":"probe"},"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"e014090292b7a0de","parentSpanId":"7cb4a6ed1dd21e14","name":"InvoiceService.list","kind":1,"startTimeUnixNano":"1788364167355000000","endTimeUnixNano":"1788364167362472291","attributes":[],"droppedAttributesCount":0,"events":[],"droppedEventsCount":0,"status":{"code":0},"links":[],"droppedLinksCount":0,"flags":257}]}]}]}`,
  `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout-api"}},{"key":"service.version","value":{"stringValue":"2.4.1"}},{"key":"deployment.environment","value":{"stringValue":"staging"}}],"droppedAttributesCount":0},"scopeSpans":[{"scope":{"name":"probe"},"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"7cb4a6ed1dd21e14","parentSpanId":"00f067aa0ba902b7","name":"GET /api/v1/invoices","kind":2,"startTimeUnixNano":"1788364167355000000","endTimeUnixNano":"1788364167362949250","attributes":[{"key":"http.request.method","value":{"stringValue":"GET"}},{"key":"url.path","value":{"stringValue":"/api/v1/invoices"}},{"key":"http.response.status_code","value":{"intValue":200}},{"key":"server.address","value":{"stringValue":"localhost"}},{"key":"server.port","value":{"intValue":8000}},{"key":"code.filepath","value":{"stringValue":"app/controllers/invoice_controller.py"}},{"key":"code.lineno","value":{"intValue":45}},{"key":"code.function","value":{"stringValue":"list_invoices"}}],"droppedAttributesCount":0,"events":[],"droppedEventsCount":0,"status":{"code":0},"links":[],"droppedLinksCount":0,"flags":769}]}]}]}`,
  `{"resourceSpans":[{"resource":{"attributes":[{"key":"service.name","value":{"stringValue":"checkout-api"}},{"key":"service.version","value":{"stringValue":"2.4.1"}},{"key":"deployment.environment","value":{"stringValue":"staging"}}],"droppedAttributesCount":0},"scopeSpans":[{"scope":{"name":"probe"},"spans":[{"traceId":"4bf92f3577b34da6a3ce929d0e0e4736","spanId":"875ddf3c4ff485f0","parentSpanId":"00f067aa0ba902b7","name":"POST /api/v1/charge","kind":2,"startTimeUnixNano":"1788364167363000000","endTimeUnixNano":"1788364167363163542","attributes":[{"key":"http.request.method","value":{"stringValue":"POST"}},{"key":"url.path","value":{"stringValue":"/api/v1/charge"}},{"key":"http.response.status_code","value":{"intValue":500}}],"droppedAttributesCount":0,"events":[{"attributes":[{"key":"exception.type","value":{"stringValue":"Error"}},{"key":"exception.message","value":{"stringValue":"card declined"}},{"key":"exception.stacktrace","value":{"stringValue":"Error: card declined\\n    at charge (app/services/billing.js:88:11)"}}],"name":"exception","timeUnixNano":"1788364167363160542","droppedAttributesCount":0}],"droppedEventsCount":0,"status":{"code":2,"message":"card declined"},"links":[],"droppedLinksCount":0,"flags":769}]}]}]}`,
];

/** The trace id the exporter continued — the one DevFlow's `traceparent` minted. */
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';

/** A second and a third, for the recordings that carry more than one traced call. */
const OTHER_TRACE = '1a2b3c4d5e6f70819a2b3c4d5e6f7081';
const FX_TRACE = '9c4e1f2a6b8d40e7a1c3f5079b2d6e84';

const parse = (text: string): unknown => JSON.parse(text) as unknown;

/** The capture, parsed. */
const CAPTURE: readonly unknown[] = DELIVERIES.map(parse);

/**
 * The same capture re-keyed onto another trace id.
 *
 * A recording that made two traced calls made them under two ids, and the join
 * has to keep them apart. Re-keying the real deliveries rather than writing a
 * second set by hand keeps every other field of them honest.
 */
const under = (traceId: string, deliveries: readonly string[] = DELIVERIES): unknown[] =>
  deliveries.map((text) => parse(text.split(TRACE).join(traceId)));

/** Read deliveries the way the receiver reads them, failing loudly on a rejection. */
function spansOf(bodies: readonly unknown[]): OtelSpan[] {
  const spans: OtelSpan[] = [];
  for (const body of bodies) {
    const reading = readOtlpTraces(body);
    if ('rejected' in reading) throw new Error(`the capture was rejected: ${reading.rejected}`);
    spans.push(...reading.spans);
  }
  return spans;
}

/**
 * What the span store can say about one recording, assembled the way the server
 * assembles it.
 *
 * `tracedCallsOf` and `joinTrace` are the real ones on purpose. The step a
 * traced call is filed under is the single thing this layer can get wrong
 * without anybody seeing — it is the key the response layer's own hits are
 * matched against — so a fixture that supplied `TraceJoin`s by hand would agree
 * with whichever numbering the fixture author had in mind rather than with the
 * one the module uses.
 */
function ingested(flow: FlowPayload, bodies: readonly unknown[]): BackendInput {
  const calls = tracedCallsOf(flow);
  const { joined, awaiting } = joinTrace({ calls, spans: spansOf(bodies) });
  return { available: true, joined, awaiting, tracedCalls: calls.length };
}

/** One step of a recording that carried a trace id out with its request. */
const tracedStep = (
  number: number,
  over: Partial<NetworkCall> & { url: string; responseBody: string | null; traceId: string },
): Step => ({
  type: 'click',
  url: 'https://shop.example.com/invoices',
  timestamp: BASE + number * 1_000,
  action: `Clicked step ${number}`,
  stepNumber: number,
  element: el({ tag: 'button', cssSelector: `#s${number}`, text: 'Invoices' }),
  networkCalls: [call(over)],
});

const flowOf = (...steps: Step[]): FlowPayload => ({
  schemaVersion: 1,
  id: 'flow-traced',
  name: 'Traced',
  timestamp: BASE,
  steps,
});

/** One click, one traced `GET`, and the four captured deliveries under its id. */
const INVOICES = flowOf(
  tracedStep(1, {
    method: 'GET',
    url: 'https://shop.example.com/api/v1/invoices',
    traceId: TRACE,
    responseBody: null,
  }),
);

const invoices = (needle: string): ProvenanceResult =>
  traceValue(INVOICES, needle, ingested(INVOICES, CAPTURE));

const backendHits = (result: ProvenanceResult) =>
  result.hits.filter((hit) => hit.layer === 'backend');

// ── A value found in a span ──────────────────────────────────────────────────

suite('the value, found in the work the server did', () => {
  it('finds it in the text of the query a span ran', () => {
    const [hit, ...rest] = backendHits(invoices('total_amount'));

    expect(hit.step).toBe(1);
    // The service and the span's own name: a reader with those two can find the
    // operation in their own tracing UI, which is where they go next.
    expect(hit.where).toBe('checkout-api  SELECT invoices');
    expect(hit.detail).toBe(
      'The server-side work carried it in the query it ran: ' +
        '"SELECT total_amount FROM invoices WHERE id = $1".',
    );
    // Within, not exact: the value is a column in a statement, not the whole of
    // what was found, and saying otherwise overstates the one thing this module
    // asks a reader to weigh.
    expect(hit.match).toBe('within');
    expect(rest).toEqual([]);
  });

  it('reads a query recorded under the attribute name db.query.text replaced', () => {
    /*
     * A service pinned to an instrumentation from before the semantic-convention
     * rename writes `db.statement`. Reading only the current name would answer
     * "the query did not carry it" for every slightly older backend, which reads
     * to its owner as DevFlow not understanding their stack rather than as a
     * version skew.
     */
    const older = DELIVERIES.map((text) =>
      text.split('"db.query.text"').join('"db.statement"'),
    ).map(parse);

    const [hit] = backendHits(traceValue(INVOICES, 'total_amount', ingested(INVOICES, older)));
    expect(hit.where).toBe('checkout-api  SELECT invoices');
    expect(hit.detail).toContain('the query it ran');
  });

  it('finds it in the path the service was asked for, and says the name held it too', () => {
    const [hit, ...rest] = backendHits(invoices('/api/v1/invoices'));

    /*
     * One span, one hit. The root span matches `url.path` *and* its own name —
     * `GET /api/v1/invoices` contains the path it routes — and printed as two
     * sightings it would double the weight of one fact about one operation. The
     * response layer already made this decision the same way: the first path
     * and a count, not forty pointers at forty times the price.
     */
    expect(rest).toEqual([]);
    expect(hit.detail).toBe(
      'The server-side work carried it in the path it was asked for: "/api/v1/invoices", ' +
        'and in its own name: "GET /api/v1/invoices".',
    );
    // The strongest field decides: `url.path` *is* the value, whichever order
    // the fields happen to be listed in.
    expect(hit.match).toBe('exact');
  });

  it('finds it in the span’s own name, which is all an internal span has', () => {
    const [hit, ...rest] = backendHits(invoices('InvoiceService.list'));

    // `InvoiceService.list` carries no http and no db attributes at all, so the
    // name is the only text on it. A list of fields that dropped it would make
    // every internal span in a trace unsearchable.
    expect(hit.where).toBe('checkout-api  InvoiceService.list');
    expect(hit.detail).toBe('The server-side work carried it in its own name: "InvoiceService.list".');
    expect(hit.match).toBe('exact');
    expect(rest).toEqual([]);
  });

  it('folds an exception, the status beside it and the stack trace into one hit', () => {
    const [hit, ...rest] = backendHits(invoices('card declined'));

    /*
     * The failure case is where a span repeats itself most: `recordException`
     * and `setStatus` are called with the same string on the same span by every
     * ordinary error handler, and the driver's stack trace opens with it again.
     * Three fields, one span, one sighting — and the sentence names all three,
     * so nothing is lost by refusing to count it three times.
     */
    expect(rest).toEqual([]);
    expect(hit.where).toBe('checkout-api  POST /api/v1/charge');
    expect(hit.detail).toBe(
      'The server-side work carried it in the exception it threw: "card declined", ' +
        'in its status message: "card declined", ' +
        'and in the stack trace of the error it threw: ' +
        '"Error: card declined at charge (app/services/billing.js:88:11)".',
    );
    expect(hit.match).toBe('exact');
  });

  it('finds it in a status message no exception event repeats', () => {
    // A span can fail with a status and no `exception` event — a handler that
    // caught the error and set the status itself. The two fields are read
    // separately for that reason and this is the case that tells them apart.
    const quiet = DELIVERIES.map((text) => text.split('"name":"exception"').join('"name":"other"')).map(
      parse,
    );

    const [hit] = backendHits(traceValue(INVOICES, 'card declined', ingested(INVOICES, quiet)));
    expect(hit.detail).toBe(
      'The server-side work carried it in its status message: "card declined".',
    );
  });

  it('finds nothing in a span that carried the value nowhere', () => {
    expect(backendHits(invoices('a value no span in this capture carries'))).toEqual([]);
  });
});

// ── The two fields the second live capture found ─────────────────────────────

/**
 * The shapes `@opentelemetry/auto-instrumentations-node` writes, with the
 * attribute values measured off a real express + knex + better-sqlite3 service.
 *
 * The first capture above is a hand-instrumented service and carries neither of
 * the two fields the second measurement found the value in, which is why it
 * takes a second fixture rather than an edit to the first: `url.query` on a
 * server span, the query inside `url.full` on a client span, and the stack
 * trace a driver interpolates its own bindings into. All three strings below
 * are that capture's, verbatim.
 *
 * The order of the spans is the order they started, not the order they would
 * have arrived — arrival order is exercised on the first capture, and this one
 * is about what is *in* a span.
 */
const attr = (key: string, stringValue: string) => ({ key, value: { stringValue } });
const intAttr = (key: string, intValue: number) => ({ key, value: { intValue } });

/** The literal SQL a driver puts in its own error text, bindings and all. */
const SELECT_STACK =
  "SqliteError: select * from `no_such_table` where `id` = '8814' limit 1 - no such table: no_such_table\n" +
  '    at Database.prepare (…/better-sqlite3/lib/methods/wrappers.js:5:21)\n' +
  '    at Client_BetterSQLite3._query (…/knex/lib/dialects/better-sqlite3/index.js:42:34)';

/**
 * The same thing where the value is 190 characters in.
 *
 * An insert names its columns before it names its values, so the literal a
 * reader is looking for sits well past any sane cut of the head of the string.
 * That is the case the quotation has to be built around rather than truncated
 * to.
 */
const INSERT_STACK =
  'SqliteError: insert into `invoices` (`customer`, `currency`, `reference`, `created_at`, ' +
  "`updated_at`, `status`, `amount`) values ('Aurora', 'GBP', 'INV-8814', 1788364200000, " +
  "1788364200000, 'open', '1284.00') - UNIQUE constraint failed: invoices.reference\n" +
  '    at Database.prepare (…/better-sqlite3/lib/methods/wrappers.js:5:21)';

const exceptionEvent = (type: string, message: string, stacktrace: string) => ({
  name: 'exception',
  timeUnixNano: '1788364200100000000',
  attributes: [
    attr('exception.type', type),
    attr('exception.message', message),
    attr('exception.stacktrace', stacktrace),
  ],
  droppedAttributesCount: 0,
});

const FX_CAPTURE: unknown = {
  resourceSpans: [
    {
      resource: {
        attributes: [attr('service.name', 'fx-gateway'), attr('service.version', '0.9.0')],
        droppedAttributesCount: 0,
      },
      scopeSpans: [
        {
          scope: { name: '@opentelemetry/instrumentation-http' },
          spans: [
            {
              traceId: FX_TRACE,
              spanId: '3f1a2b3c4d5e6f70',
              parentSpanId: '00f067aa0ba902b7',
              name: 'GET /fx',
              kind: 2,
              startTimeUnixNano: '1788364200000000000',
              endTimeUnixNano: '1788364200120000000',
              attributes: [
                attr('http.request.method', 'GET'),
                attr('url.path', '/fx'),
                attr('url.query', 'ref=1284.00&customer=Aurora'),
                attr('url.scheme', 'http'),
                intAttr('http.response.status_code', 500),
              ],
              events: [],
              status: { code: 2, message: 'Internal Server Error' },
            },
            {
              traceId: FX_TRACE,
              spanId: '4a1b2c3d4e5f6071',
              parentSpanId: '3f1a2b3c4d5e6f70',
              name: 'GET',
              kind: 3,
              startTimeUnixNano: '1788364200010000000',
              endTimeUnixNano: '1788364200020000000',
              attributes: [
                attr('http.request.method', 'GET'),
                attr('url.full', 'http://localhost:4500/fx?amount=1284.00&invoice=8814'),
                intAttr('http.response.status_code', 200),
              ],
              events: [],
              status: { code: 0 },
            },
            {
              /*
               * The outcome of a settlement, in the query string it was called
               * with and again as the status the handler set. One field
               * *contains* the value and a later one *is* it, which is what
               * tells the strongest-field rule apart from a first-field one.
               */
              traceId: FX_TRACE,
              spanId: '7d1e2f3041526374',
              parentSpanId: '3f1a2b3c4d5e6f70',
              name: 'POST /fx/settle',
              kind: 2,
              startTimeUnixNano: '1788364200050000000',
              endTimeUnixNano: '1788364200060000000',
              attributes: [
                attr('http.request.method', 'POST'),
                attr('url.path', '/fx/settle'),
                attr('url.query', 'outcome=declined&amount=1284.00'),
                intAttr('http.response.status_code', 402),
              ],
              events: [],
              status: { code: 2, message: 'declined' },
            },
          ],
        },
        {
          scope: { name: '@opentelemetry/instrumentation-knex' },
          spans: [
            {
              traceId: FX_TRACE,
              spanId: '5b1c2d3e4f506172',
              parentSpanId: '3f1a2b3c4d5e6f70',
              name: 'knex.raw',
              kind: 3,
              startTimeUnixNano: '1788364200030000000',
              endTimeUnixNano: '1788364200035000000',
              attributes: [
                attr('db.system.name', 'sqlite'),
                attr('db.query.text', 'select * from `no_such_table` where `id` = ? limit ?'),
              ],
              events: [exceptionEvent('SqliteError', 'no such table: no_such_table', SELECT_STACK)],
              status: { code: 2, message: 'no such table: no_such_table' },
            },
            {
              traceId: FX_TRACE,
              spanId: '6c1d2e3f40516273',
              parentSpanId: '3f1a2b3c4d5e6f70',
              name: 'knex.insert',
              kind: 3,
              startTimeUnixNano: '1788364200040000000',
              endTimeUnixNano: '1788364200048000000',
              attributes: [
                attr('db.system.name', 'sqlite'),
                attr(
                  'db.query.text',
                  'insert into `invoices` (`customer`, `currency`, `reference`, `created_at`, ' +
                    '`updated_at`, `status`, `amount`) values (?, ?, ?, ?, ?, ?, ?)',
                ),
              ],
              events: [
                exceptionEvent('SqliteError', 'UNIQUE constraint failed: invoices.reference', INSERT_STACK),
              ],
              status: { code: 2, message: 'UNIQUE constraint failed: invoices.reference' },
            },
          ],
        },
      ],
    },
  ],
};

const FX = flowOf(
  tracedStep(1, {
    method: 'GET',
    url: 'https://shop.example.com/fx',
    traceId: FX_TRACE,
    responseBody: null,
  }),
);

const fx = (needle: string): ProvenanceResult =>
  traceValue(FX, needle, ingested(FX, [FX_CAPTURE]));

suite('the two places a value was measured to travel that were being dropped', () => {
  it('finds it in a server span’s query string, where it travels in plain sight', () => {
    const hit = backendHits(fx('1284.00')).find((entry) => entry.where === 'fx-gateway  GET /fx');

    /*
     * The commonest case of all, and it was invisible. `?ref=1284.00` is the
     * value itself on the wire — stronger evidence than anything else a span
     * carries — and a field list that read only `url.path` found nothing in the
     * one span that held it.
     */
    expect(hit?.detail).toBe(
      'The server-side work carried it in the query string it was called with: ' +
        '"ref=1284.00&customer=Aurora".',
    );
    expect(hit?.match).toBe('within');
  });

  it('finds it in the query string cut out of a client span’s url.full', () => {
    const hit = backendHits(fx('1284.00')).find((entry) => entry.where === 'fx-gateway  GET');

    // A client span has no `url.query`; the whole url is one attribute. The two
    // spellings are one field to a reader and have to be one field here.
    expect(hit?.detail).toBe(
      'The server-side work carried it in the query string it was called with: ' +
        '"amount=1284.00&invoice=8814".',
    );
  });

  it('finds it in a stack trace when the span’s own query text has a ? in its place', () => {
    const [hit, ...rest] = backendHits(fx('8814')).filter(
      (entry) => entry.where === 'fx-gateway  knex.raw',
    );

    /*
     * The measurement that is backwards from the intuition. This span's
     * `db.query.text` says ``where `id` = ?`` — the binding is not in it — and
     * its stack trace says ``where `id` = '8814'``, because the driver
     * interpolates when it formats its own error. So the failure path carries
     * the literal the success path does not, and it is the path somebody asking
     * "why is this value wrong" is already on.
     */
    expect(rest).toEqual([]);
    expect(hit.detail).toContain('the stack trace of the error it threw');
    expect(hit.detail).toContain("`id` = '8814'");
    expect(hit.detail).not.toContain('the query it ran');
    // A stack trace is frame paths, line numbers and byte offsets around the
    // value. It is never the whole of what was found.
    expect(hit.match).toBe('within');
  });

  it('quotes the part of a long field the value is in, not the first of it', () => {
    const hit = backendHits(fx('1284.00')).find(
      (entry) => entry.where === 'fx-gateway  knex.insert',
    );

    /*
     * `'1284.00'` is 190 characters into that stack trace, past the column list
     * of the insert. A quotation cut off the head of the string would print 160
     * characters the needle is not in, directly beneath a hit claiming it was —
     * evidence that reads as an argument against itself.
     */
    expect(hit?.detail).toContain("'1284.00'");
    // Cut at the front, and the cut is inside the quotes where a reader sees it.
    expect(hit?.detail).toContain('"…');
  });

  it('decides exactness on the strongest field, not on the first one listed', () => {
    const [hit, ...rest] = backendHits(fx('declined'));

    /*
     * `outcome=declined&amount=1284.00` *contains* the value and the status
     * message *is* it. `exact` means the value accounted for the whole of what
     * was found, and that is true of this span however the fields happen to
     * sort — deciding it on whichever field comes first would make the answer a
     * fact about the order of a list in `spanTexts` rather than about evidence.
     */
    expect(rest).toEqual([]);
    expect(hit.where).toBe('fx-gateway  POST /fx/settle');
    expect(hit.detail).toBe(
      'The server-side work carried it in the query string it was called with: ' +
        '"outcome=declined&amount=1284.00", and in its status message: "declined".',
    );
    expect(hit.match).toBe('exact');
  });

  it('names the stronger field first when one span carries the value in several', () => {
    // `spanTexts` is ordered by what a match in it is worth, so the first field
    // a hit names is the best reason to believe it. A stack-trace sighting must
    // not be able to borrow the standing of a query it was not in.
    const hit = backendHits(fx('no_such_table')).find(
      (entry) => entry.where === 'fx-gateway  knex.raw',
    );

    expect(hit?.detail.indexOf('the query it ran')).toBeGreaterThan(-1);
    expect(hit?.detail.indexOf('the query it ran')).toBeLessThan(
      hit?.detail.indexOf('the stack trace of the error it threw') ?? -1,
    );
  });
});

// ── The chain behind the call, which is known rather than seen ───────────────

/** A body carrying the price, for the calls whose *response* is the reason. */
const PRICED = JSON.stringify({ invoice: { total: PRICE } });

suite('the chain behind a call the value was seen at', () => {
  it('walks the trace parents-first, at the depths the spans really sit at', () => {
    const [path, ...rest] = invoices('total_amount').backend.paths;

    /*
     * The whole of what a path is worth. The four spans arrived leaf-first
     * across four requests — the `SELECT` first, the server span that caused it
     * third — and the root's parent is DevFlow's own client span, which is not
     * an OTel SDK and will never export one. A tree built on "has no parent"
     * finds no roots here at all; a tree built on arrival order prints the
     * query above the handler that ran it.
     */
    expect(path.hops.map((hop) => [hop.name, hop.depth])).toEqual([
      ['GET /api/v1/invoices', 0],
      ['InvoiceService.list', 1],
      ['SELECT invoices', 2],
      // A second root under the same id: two requests, one trace.
      ['POST /api/v1/charge', 0],
    ]);
    expect(rest).toEqual([]);
    expect(path.more).toBe(0);
  });

  it('says which call, under which id, and which services answered it', () => {
    const [path] = invoices('total_amount').backend.paths;

    // Worded as the response layer words a call, so the two halves of one
    // answer read as one answer.
    expect(path.where).toBe('GET https://shop.example.com/api/v1/invoices');
    expect(path.step).toBe(1);
    expect(path.traceId).toBe(TRACE);
    expect(path.services).toEqual(['checkout-api']);
  });

  it('carries what a reader can act on off each hop', () => {
    const [path] = invoices('total_amount').backend.paths;

    expect(path.hops[0]).toEqual({
      depth: 0,
      service: 'checkout-api',
      name: 'GET /api/v1/invoices',
      kind: 'server',
      // Nanoseconds subtracted as BigInt: through a `number` the low digits go
      // and the loss lands on the sub-millisecond end of the duration.
      durationMs: 7.94925,
      failed: false,
      file: 'app/controllers/invoice_controller.py',
      line: 45,
      statement: null,
      status: 200,
      query: null,
      exceptionType: null,
      exceptionMessage: null,
      statusMessage: null,
      carried: false,
    });
    expect(path.hops[2].statement).toBe('SELECT total_amount FROM invoices WHERE id = $1');
    expect(path.hops[3].failed).toBe(true);
  });

  it('carries each hop’s response status, so two failures do not read alike', () => {
    const [path] = fx('1284.00').backend.paths;

    /*
     * `failed` is one bit and there are two answers behind it. A handler that
     * returned 404 and one that returned 500 are the two things somebody
     * opening this tool is choosing between — "the server has not got it" and
     * "the server fell over" — and a chain that renders both as the same bold
     * word has thrown away the distinction on the screen built to show it.
     */
    expect(path.hops.map((hop) => [hop.name, hop.status, hop.failed])).toEqual([
      ['GET /fx', 500, true],
      ['GET', 200, false],
      // A span with no HTTP attributes at all has no status to report, and a
      // `null` is that absence rather than a zero.
      ['knex.raw', null, true],
      ['knex.insert', null, true],
      ['POST /fx/settle', 402, true],
    ]);
  });

  it('carries the query string onto the hop, not only into the search', () => {
    const [path] = fx('1284.00').backend.paths;

    /*
     * The measurement that put `url.query` in `spanTexts` is the same one that
     * puts it here: it is one of only three places in a trace a value a person
     * can read off the screen was ever seen. A hop that could not carry it
     * would let that reach the search and never the chain — the reader would be
     * told the value is in the backend and shown a line that does not contain
     * it.
     */
    expect(path.hops.map((hop) => hop.query)).toEqual([
      'ref=1284.00&customer=Aurora',
      // Cut out of `url.full` on a client span, which has no `url.query` of
      // its own. One field to a reader; one field here.
      'amount=1284.00&invoice=8814',
      null,
      null,
      'outcome=declined&amount=1284.00',
    ]);
    // The hops that carry it are the hops the search found it in — the two
    // halves of one answer, over one span each.
    expect(path.hops.map((hop) => hop.carried)).toEqual([true, true, false, true, true]);
  });

  it('leaves the stack trace out of the hop it searched it in', () => {
    /*
     * Search and display are different budgets, and this is where they part.
     * `knex.raw`'s stack trace is the only field on it that carries `8814` —
     * its `db.query.text` says `where id = ?` — so the search must read it and
     * does. A hop is a line in a printed chain and a stack trace is kilobytes
     * of frames, so the hop must not carry it and does not: the hit's `detail`
     * carries a window around the match, which is the part worth reading.
     *
     * Pinned because the asymmetry reads as an inconsistency, and "fixing" it
     * in either direction undoes one of the two decisions.
     */
    const [path] = fx('8814').backend.paths;
    const raw = path.hops.find((hop) => hop.name === 'knex.raw');

    expect(raw?.carried).toBe(true);
    expect(raw).not.toHaveProperty('stacktrace');
    expect(Object.values(raw ?? {}).join(' ')).not.toContain('at Database.prepare');
    // And the statement on the hop is the parameterised one the tracer wrote,
    // never a tidied or interpolated rewrite of it.
    expect(raw?.statement).toBe('select * from `no_such_table` where `id` = ? limit ?');
  });

  /*
   * The failure text on a hop, which the chain could not show and the whole
   * span tree could.
   *
   * `spanLines` in the server prints an exception type and message, and it is
   * one renderer with two callers: `get_backend_trace` supplied them and
   * `hopOf` did not, so the *same span* showed its reason in one tool and a
   * bare **FAILED** in the other. A shared renderer exists to make exactly that
   * impossible, and a field only one caller fills is a branch that never fires
   * for the other. A chain is opened because a value is wrong, so the reason a
   * hop in it failed is rarely incidental.
   */
  it('carries why a hop failed, not only that it did', () => {
    const [path] = fx('8814').backend.paths;
    const raw = path.hops.find((hop) => hop.name === 'knex.raw');

    expect(raw?.failed).toBe(true);
    expect(raw?.exceptionType).toBe('SqliteError');
    expect(raw?.exceptionMessage).toBe('no such table: no_such_table');
  });

  it('carries the reason for a failure that threw nothing', () => {
    /*
     * `GET /fx` set an error status and recorded no `exception` event, which is
     * what a handler that caught its own error looks like. The two fields are
     * read from two different places on the span for that reason, and a hop
     * that took its reason only from the event would render this — a 500 with a
     * message sitting right there — as a failure with no reason at all.
     */
    const root = fx('1284.00').backend.paths[0].hops[0];

    expect(root.failed).toBe(true);
    expect(root.exceptionType).toBeNull();
    expect(root.exceptionMessage).toBeNull();
    expect(root.statusMessage).toBe('Internal Server Error');
  });

  it('carries a status message on a hop that failed without throwing', () => {
    /*
     * The case the other assertion cannot reach, and the one mutation-testing
     * found: nulling `statusMessage` survived a fixture in which every failure
     * threw. A handler that caught its error and set the span's status itself
     * has a message and no `exception` event, `spanLines` falls back to it
     * precisely then, and without this the fallback is unreachable from the
     * chain while being reachable from the whole tree — the asymmetry these
     * three fields were added to remove.
     */
    const quiet = DELIVERIES.map((text) =>
      text.split('"name":"exception"').join('"name":"other"'),
    ).map(parse);
    const [path] = traceValue(INVOICES, 'total_amount', ingested(INVOICES, quiet)).backend.paths;
    const failed = path.hops.find((hop) => hop.failed);

    expect(failed?.exceptionMessage).toBeNull();
    expect(failed?.statusMessage).toBe('card declined');
  });

  it('reports a hop that did not fail as having no failure text at all', () => {
    // Absent rather than empty: an empty string renders as a bare `error:` line
    // hanging off a hop that was fine.
    for (const hop of invoices('total_amount').backend.paths[0].hops) {
      if (hop.failed) continue;
      expect(hop.exceptionType).toBeNull();
      expect(hop.exceptionMessage).toBeNull();
      expect(hop.statusMessage).toBeNull();
    }
  });

  it('marks the hop that carried the value, and only that one', () => {
    // `carried` and the hit above are the same decision, asked twice. Two
    // spellings of it drift, and the drift reads as a path whose every hop
    // denies what the hit beneath it claims.
    expect(invoices('total_amount').backend.paths[0].hops.map((hop) => hop.carried)).toEqual([
      false,
      false,
      true,
      false,
    ]);
    expect(invoices('/api/v1/invoices').backend.paths[0].hops.map((hop) => hop.carried)).toEqual([
      true,
      false,
      false,
      false,
    ]);
  });

  it('gives a path to a call whose response body carried it and whose spans did not', () => {
    const flow = flowOf(
      tracedStep(1, {
        method: 'GET',
        url: 'https://shop.example.com/api/v1/invoices',
        traceId: TRACE,
        responseBody: PRICED,
      }),
    );
    const result = traceValue(flow, PRICE, ingested(flow, CAPTURE));

    /*
     * The case the roadmap actually names, and the reason a path is not gated
     * on a backend *hit*. No span in this capture says `£42.00` anywhere —
     * measured, a response body is in no span at all — and the server-side work
     * behind the call that sent it is exactly what somebody wants next.
     */
    expect(backendHits(result)).toEqual([]);
    expect(result.backend.paths).toHaveLength(1);
    expect(result.backend.paths[0].traceId).toBe(TRACE);
    expect(result.backend.paths[0].hops.every((hop) => hop.carried)).toBe(false);
  });

  it('gives no path to a joined call the value turns up nowhere near', () => {
    const flow = flowOf(
      tracedStep(1, {
        method: 'GET',
        url: 'https://shop.example.com/api/v1/invoices',
        traceId: TRACE,
        responseBody: PRICED,
      }),
      tracedStep(2, {
        method: 'GET',
        url: 'https://shop.example.com/api/v1/banners',
        traceId: OTHER_TRACE,
        responseBody: JSON.stringify({ banners: [] }),
      }),
    );
    const result = traceValue(flow, PRICE, ingested(flow, [...CAPTURE, ...under(OTHER_TRACE)]));

    /*
     * Both calls joined and both have a full chain behind them. Printing the
     * second would answer a question nobody asked and bury the one they did —
     * `get_backend_trace` is the tool for the whole recording.
     */
    expect(result.backend.paths.map((path) => path.step)).toEqual([1]);
    expect(result.backend.more).toBe(0);
  });

  it('lists the backend before the four readings of the browser’s own recording', () => {
    /*
     * Presentation, and asserted as presentation. The order is the direction
     * data moves through an application, so the answer reads top to bottom as a
     * journey — and nothing here concludes that the query *caused* the render.
     * `get_causal_chain` is the tool that makes causal claims.
     */
    const priced = DELIVERIES.map((text) =>
      text
        .split('SELECT total_amount FROM invoices WHERE id = $1')
        .join(`SELECT total_amount FROM invoices WHERE total = '${PRICE}'`),
    ).map(parse);

    const flow: FlowPayload = {
      ...CHECKOUT,
      steps: CHECKOUT.steps.map((step, index) =>
        index === 0 && step.networkCalls
          ? { ...step, networkCalls: [{ ...step.networkCalls[0], traceId: TRACE }] }
          : step,
      ),
    };

    expect(traceValue(flow, PRICE, ingested(flow, priced)).hits.map((hit) => hit.layer)).toEqual([
      'backend',
      'response',
      'store',
      'store',
      'render',
      'dom',
      'dom',
      'dom',
      'dom',
    ]);
  });
});

// ── The step a call is filed under ───────────────────────────────────────────

suite('the response hit and the trace behind it are keyed the same way', () => {
  it('files a traced call under the number the recording gave its step', () => {
    /*
     * The defect `tracedCallsOf` was moved into `core/otel` to close, and it is
     * invisible from outside: the server's own copy numbered steps by position
     * while every renderer beside it prefers the step's own `stepNumber`, so a
     * flow whose numbers do not match its positions filtered on one and printed
     * the other. `POST /flows` accepts a flow from any page the browser visits,
     * so numbers that do not match positions are not a hypothetical.
     *
     * Here the call that carried the value is at position 1 and is numbered 9.
     * Keyed by position it is call 2, the response hit is at step 9, the two
     * never meet, and the answer is a sighting with no chain behind it and
     * nothing anywhere saying why.
     */
    const flow = flowOf(
      tracedStep(7, {
        method: 'GET',
        url: 'https://shop.example.com/api/v1/invoices',
        traceId: TRACE,
        responseBody: null,
      }),
      tracedStep(9, {
        method: 'POST',
        url: 'https://shop.example.com/api/v1/charge',
        traceId: OTHER_TRACE,
        responseBody: PRICED,
      }),
    );
    const result = traceValue(flow, PRICE, ingested(flow, [...CAPTURE, ...under(OTHER_TRACE)]));

    expect(result.hits.map((hit) => [hit.layer, hit.step])).toEqual([['response', 9]]);
    expect(result.backend.paths).toHaveLength(1);
    expect(result.backend.paths[0].step).toBe(9);
    expect(result.backend.paths[0].traceId).toBe(OTHER_TRACE);
    expect(result.backend.paths[0].where).toBe('POST https://shop.example.com/api/v1/charge');
  });

  it('files a call whose method the recording did not carry the way the search does', () => {
    // Both sides default a missing method to `GET`, in `callKey` and in
    // `tracedCallsOf`, and they have to agree exactly or the two halves of one
    // answer never find each other. A flow from an untrusted page is where a
    // call with no method comes from.
    const flow = flowOf(
      tracedStep(1, {
        url: 'https://shop.example.com/api/v1/invoices',
        traceId: TRACE,
        responseBody: PRICED,
      }),
    );
    const steps = flow.steps.map((step) => ({
      ...step,
      networkCalls: [{ ...step.networkCalls![0], method: undefined as unknown as string }],
    }));
    const untyped: FlowPayload = { ...flow, steps };

    expect(traceValue(untyped, PRICE, ingested(untyped, CAPTURE)).backend.paths).toHaveLength(1);
  });
});

// ── The caps, and the counts that stop them lying ────────────────────────────

/**
 * The same `SELECT`, run once per row, under the handler that ran it.
 *
 * An N+1 in somebody's handler is what makes a trace unbounded — four hundred
 * spans out of one recorded click — and it is built here out of the captured
 * delivery rather than invented, span id and start time apart. The start times
 * stay inside the original span's own window so every copy is a span the reader
 * will accept rather than one it skips as `bad-time`.
 */
const nPlusOne = (count: number): unknown[] => [
  ...CAPTURE,
  ...Array.from({ length: count }, (_, index) =>
    parse(
      DELIVERIES[0]
        .split('"spanId":"29abc6b630d1e717"')
        .join(`"spanId":"a1b2c3d4e5f6${String(index).padStart(4, '0')}"`)
        .split('"startTimeUnixNano":"1788364167355000000"')
        .join(`"startTimeUnixNano":"1788364167355${String(index).padStart(4, '0')}00"`),
    ),
  ),
];

suite('the caps, and the counts beside them', () => {
  it('prints twelve hops of a trace and counts the rest', () => {
    const result = traceValue(INVOICES, 'total_amount', ingested(INVOICES, nPlusOne(15)));
    const [path] = result.backend.paths;

    // Nineteen spans: the four captured, and fifteen more `SELECT`s under the
    // same handler. Twelve printed, seven counted — and "and 7 more" is itself
    // the finding, which is why dropping them silently is the failure.
    expect(path.hops).toHaveLength(12);
    expect(path.more).toBe(7);
    // Still parents-first: the cut is taken off the end of the walk, not off
    // the front of a list that was never ordered.
    expect(path.hops.slice(0, 3).map((hop) => hop.depth)).toEqual([0, 1, 2]);
    expect(path.hops.slice(3).every((hop) => hop.depth === 2)).toBe(true);
    // Every hop printed is a whole hop. The cap takes hops off the end of the
    // walk; it is not a budget that starts leaving fields off the ones it kept.
    for (const hop of path.hops) {
      expect(Object.keys(hop).sort()).toEqual([
        'carried',
        'depth',
        'durationMs',
        'exceptionMessage',
        'exceptionType',
        'failed',
        'file',
        'kind',
        'line',
        'name',
        'query',
        'service',
        'statement',
        'status',
        'statusMessage',
      ]);
    }
  });

  it('counts a span as one place, so the per-layer cap means what it means elsewhere', () => {
    const result = traceValue(INVOICES, 'total_amount', ingested(INVOICES, nPlusOne(15)));

    // Sixteen spans carried it, one hit each. Eight listed and eight counted,
    // keyed by layer exactly as the other four are.
    expect(backendHits(result)).toHaveLength(8);
    expect(result.more).toEqual({ backend: 8 });
  });

  it('prints four chains and counts the rest', () => {
    const traceOf = (index: number) => String(index).padStart(32, 'c');
    const steps = Array.from({ length: 6 }, (_, index) =>
      tracedStep(index + 1, {
        method: 'GET',
        url: `https://shop.example.com/api/v1/invoices/${index + 1}`,
        traceId: traceOf(index),
        responseBody: PRICED,
      }),
    );
    const flow = flowOf(...steps);
    const result = traceValue(
      flow,
      PRICE,
      ingested(
        flow,
        Array.from({ length: 6 }, (_, index) => under(traceOf(index))).flat(),
      ),
    );

    // A trace is not bounded by anything on this machine, and neither is the
    // number of them: six calls each carrying the value is six full chains, and
    // the cap is what stops one recording's answer being all of them.
    expect(result.backend.paths.map((path) => path.step)).toEqual([1, 2, 3, 4]);
    expect(result.backend.more).toBe(2);
  });
});

// ── The three nothings, kept apart ───────────────────────────────────────────

const backendReason = (flow: FlowPayload, backend: BackendInput): string | undefined =>
  traceValue(flow, PRICE, backend).unsearched.find((entry) => entry.layer === 'backend')?.reason;

suite('the backend’s three nothings send a reader to three different places', () => {
  const off = backendReason(INVOICES, INGEST_OFF);
  const untraced = backendReason(
    bare(),
    { available: true, joined: [], awaiting: [], tracedCalls: 0 },
  );
  const unarrived = backendReason(INVOICES, ingested(INVOICES, []));

  it('says span ingest is off on this server, and how to start it', () => {
    // A flag on the machine the tool is running on. Nothing about the
    // recording, and nothing the user's backend can fix.
    expect(off).toMatch(/DEVFLOW_OTEL=1/);
    expect(off).toMatch(/v1\/traces/);
    // And says nothing about the recording, which it knows nothing about: a
    // server with ingest off cannot tell a traced recording from an untraced
    // one, and a sentence that guessed would send a reader to the extension.
    // The exporter is named, and only as the other half of the same errand —
    // starting ingest without pointing anything at it fixes nothing.
    expect(off).not.toMatch(/traced call|trace id/);
  });

  it('says no call carried a trace id, and why one might not have', () => {
    // A switch in the extension and a recording made again. The three clauses
    // are the three reasons a header does not go out, and a reader who is told
    // only "off by default" checks the switch and stops.
    expect(untraced).toMatch(/no call in this recording carried a trace id/i);
    expect(untraced).toMatch(/off by default/);
    expect(untraced).toMatch(/allow-list/);
    // Not a word about span ingest, which is on. A sentence that mentioned it
    // too would send a reader to check a flag that was never the problem —
    // which is the whole reason these three are three.
    expect(untraced).not.toMatch(/ingest/i);
    expect(untraced).not.toMatch(/DEVFLOW_OTEL/);
  });

  it('says the header went out and the spans have not come back', () => {
    /*
     * The one that is *already* correct on the DevFlow side, and the one a
     * reader is most likely to be sent away from. Telling somebody "no backend
     * data" here sends them to change a setting that was never the problem.
     */
    expect(unarrived).toMatch(/1 traced call\b/);
    expect(unarrived).toMatch(/The header went out/);
    expect(unarrived).toMatch(/Re-send this recording/);
    expect(unarrived).not.toMatch(/ingest/i);
    expect(unarrived).not.toMatch(/DEVFLOW_OTEL/);
    expect(unarrived).not.toMatch(/allow-list/);
  });

  it('counts the traced calls it is waiting on, in the plural when there are several', () => {
    const flow = flowOf(
      tracedStep(1, {
        url: 'https://shop.example.com/a',
        traceId: TRACE,
        responseBody: null,
      }),
      tracedStep(2, {
        url: 'https://shop.example.com/b',
        traceId: OTHER_TRACE,
        responseBody: null,
      }),
    );

    expect(backendReason(flow, ingested(flow, []))).toMatch(/2 traced calls/);
    expect(backendReason(flow, ingested(flow, []))).toMatch(/their ids/);
  });

  it('is three sentences and not one sentence three times', () => {
    expect(new Set([off, untraced, unarrived]).size).toBe(3);
    for (const reason of [off, untraced, unarrived]) expect(reason).toBeTruthy();
  });

  it('claims no unsearched backend at all once one trace has joined', () => {
    expect(layersOf(invoices('total_amount'))).not.toContain('backend');
  });
});

// ── A partial answer that says it is partial ─────────────────────────────────

suite('traced calls whose spans have not arrived', () => {
  const flow = flowOf(
    tracedStep(1, {
      url: 'https://shop.example.com/api/v1/invoices',
      traceId: TRACE,
      responseBody: PRICED,
    }),
    tracedStep(2, {
      url: 'https://shop.example.com/api/v1/banners',
      traceId: OTHER_TRACE,
      responseBody: PRICED,
    }),
  );
  const partial = traceValue(flow, PRICE, ingested(flow, CAPTURE));

  it('counts them even when other calls did join', () => {
    /*
     * The failure this number exists to prevent: one of a recording's two
     * traced calls rendering as the whole backend story. A partial answer that
     * reads as a whole one is worse than no answer, because the reader has no
     * way to know a hole is there.
     */
    expect(partial.backend.paths).toHaveLength(1);
    expect(partial.backend.awaiting).toBe(1);
  });

  it('does not call the layer unsearched, because it was searched', () => {
    // Deliberately not an `unsearched` entry. The layer was read and returned
    // something; the hole belongs beside what it found, not in the list of
    // things that were never looked at.
    expect(layersOf(partial)).not.toContain('backend');
  });

  it('counts nothing awaiting when the server could not be asked at all', () => {
    // Ingest off is not "waiting for spans". Nothing is known about what would
    // have arrived, and a `0` here is that ignorance rather than a measurement.
    const result = traceValue(flow, PRICE, INGEST_OFF);
    expect(result.backend).toEqual({ paths: [], more: 0, awaiting: 0 });
  });
});

// ── The needle, on the fifth layer ───────────────────────────────────────────

suite('an empty needle finds nothing on the backend either', () => {
  it('does not report every span as having carried nothing', () => {
    /*
     * Every string `includes` the empty string, so an unguarded search over a
     * span's five fields returns a hit for every span in every joined trace —
     * an answer that looks like a value with a very well-travelled history and
     * is a rendering of the fact that nothing was searched for.
     */
    for (const needle of ['', '   ']) {
      const result = traceValue(INVOICES, needle, ingested(INVOICES, CAPTURE));
      expect(result.hits).toEqual([]);
      expect(result.backend.paths).toEqual([]);
    }
  });
});
