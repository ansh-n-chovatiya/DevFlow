// @vitest-environment jsdom

/**
 * What the RSC adapter is allowed to do to a page on every keystroke.
 *
 * `registry.ts::chainsFor` runs every adapter's `fromElement` on every recorded
 * interaction, from the capture-phase `click`/`input` listener — synchronously,
 * ahead of the page's own handlers. On a Next.js App Router page this adapter
 * used to answer by re-reading the whole flight payload each time: a
 * `querySelectorAll('script')`, a global regex over every `__next_f` body, a
 * `JSON.parse` per push, then a join, a row split and a further `JSON.parse` of
 * every row inside `buildFlightModel`. Over the hundreds of kilobytes a real
 * page ships, that is typing lag in the user's own application.
 *
 * These assert the absence of work, which is a thing tests are usually bad at:
 * a fixture that merely returns the right answer passes just as well when the
 * payload has been parsed twice. So they count the reads directly — the
 * document scans by spying on `querySelectorAll`, the parse by spying on
 * `JSON.parse` — and the invalidation cases either side keep that honest. An
 * assertion that nothing happened is worthless next to an assertion that the
 * right thing still does, and a cache with no invalidation would answer for a
 * page that is no longer there, which is worse than being slow.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRscAdapter, type RscFiberReading, type RscPort } from '../src/core/rsc/adapter.js';
import { createRscPort } from '../src/injected/rsc.js';

/** spike-rsc §2, the dev shape: the module id is a path, so the build is dev. */
const DEV_ROW =
  '3f:I["[project]/app/components/ClientCounter.tsx [app-client] (ecmascript)",["/_next/static/chunks/_098lxtj._.js"],"default"]\n';

/** An untagged JSON model row — a payload with no `I` row to stamp the build. */
const MODEL_ROW = '0:{"children":"$L1"}\n';

/** One fiber the walk can report, so `fromElement` has a chain to return. */
const READINGS: readonly RscFiberReading[] = [
  { name: 'ClientCounter', host: false, fnSource: 'function ClientCounter(){}' },
];

function docWith(...payloads: string[]): Document {
  const doc = document.implementation.createHTMLDocument('t');
  for (const payload of payloads) push(doc, payload);
  return doc;
}

/** One `self.__next_f.push` inline script, exactly as Next emits it. */
function push(doc: Document, payload: string): HTMLScriptElement {
  const script = doc.createElement('script');
  script.textContent = `self.__next_f.push([1,${JSON.stringify(payload)}])`;
  doc.body.appendChild(script);
  return script;
}

/**
 * The adapter as the extension builds it, with the fiber walk replaced.
 *
 * Only `readingsFor` and `describe` are stubbed: the point of these tests is
 * the path from the document to the model, so the real port does the real scan
 * and the real adapter does the real parse.
 */
function adapterOver(doc: Document) {
  const port: RscPort = {
    ...createRscPort(doc),
    readingsFor: () => READINGS,
    describe: () => ({ tag: 'div', attributes: {} }),
  };
  return createRscAdapter(port);
}

/**
 * Counts the two readings that cost real time, without changing what they
 * answer — a stub returning nothing would make every behavioural assertion
 * here vacuous.
 */
function watch(doc: Document) {
  const scan = vi.spyOn(doc, 'querySelectorAll');
  const parse = vi.spyOn(JSON, 'parse');

  return {
    /** Scans of the document for its inline scripts. */
    get scans() {
      return scan.mock.calls.filter(([selector]) => selector === 'script').length;
    },
    /** Every `JSON.parse` — the push payloads and the flight rows alike. */
    get parses() {
      return parse.mock.calls.length;
    },
    reset() {
      scan.mockClear();
      parse.mockClear();
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a second interaction on an unchanged page', () => {
  it('does not scan the document again', () => {
    const doc = docWith(DEV_ROW);
    const adapter = adapterOver(doc);
    const el = doc.createElement('div');
    const seen = watch(doc);

    adapter.fromElement(el);
    adapter.fromElement(el);

    expect(seen.scans).toBe(1);
  });

  it('does not parse the payload again', () => {
    const doc = docWith(DEV_ROW, MODEL_ROW);
    const adapter = adapterOver(doc);
    const el = doc.createElement('div');
    adapter.fromElement(el);

    const seen = watch(doc);
    adapter.fromElement(el);

    expect(seen.parses).toBe(0);
  });

  it('still answers, which is what makes the two counts above worth having', () => {
    const doc = docWith(DEV_ROW);
    const adapter = adapterOver(doc);
    const el = doc.createElement('div');

    expect(adapter.fromElement(el)?.framework).toBe('rsc');
    expect(adapter.fromElement(el)?.chain).toHaveLength(1);
    expect(adapter.detect().build).toBe('development');
  });
});

describe('a payload that grew after hydration', () => {
  /*
   * The case a memo with no invalidation gets wrong, and gets wrong silently:
   * Next keeps emitting flight after the document has settled — a suspended
   * boundary resolving, a segment streamed in — and each of those is another
   * inline script. A model held past one of them describes a page that is no
   * longer there.
   */
  it('sees a push that arrives later', () => {
    const doc = docWith(MODEL_ROW);
    const adapter = adapterOver(doc);

    expect(adapter.detect().build).toBe('unknown');
    push(doc, DEV_ROW);
    expect(adapter.detect().build).toBe('development');
  });

  it('rescans the document for it', () => {
    const doc = docWith(MODEL_ROW);
    const adapter = adapterOver(doc);
    adapter.detect();

    const seen = watch(doc);
    push(doc, DEV_ROW);
    adapter.detect();

    expect(seen.scans).toBe(1);
  });

  it('sees a script whose own body changed, which the text length catches', () => {
    const doc = docWith(MODEL_ROW);
    const adapter = adapterOver(doc);
    expect(adapter.detect().build).toBe('unknown');

    doc.scripts[0].textContent = `self.__next_f.push([1,${JSON.stringify(DEV_ROW)}])`;

    expect(adapter.detect().build).toBe('development');
  });
});

describe('the memo never crosses a document', () => {
  /*
   * Two documents whose signatures are identical by construction — one script
   * each, the same number of characters in it. A cache keyed on the signature
   * alone, held anywhere above the port, would serve the first document's rows
   * for the second. The cache lives on the port and a port is made for one
   * document, so this is the shape of the thing rather than a rule kept.
   */
  it('answers each document from its own payload', () => {
    const first = docWith('1:I["app/a.tsx",[],"default"]\n');
    const second = docWith('1:I["app/b.tsx",[],"default"]\n');

    expect(createRscPort(first).flightChunks()[0]).toContain('app/a.tsx');
    expect(createRscPort(second).flightChunks()[0]).toContain('app/b.tsx');
  });
});
