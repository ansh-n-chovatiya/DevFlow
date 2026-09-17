/**
 * The webpack `eval` devtools, which put one source map inside every module.
 *
 * `extractSourceMappingURL` was written for the shape every other bundler ships:
 * one annotation, at the end of the file, describing the file. `eval-source-map`
 * and its `eval-cheap-module-*` siblings break that assumption without breaking
 * anything visible — the chunk still ends in a `//# sourceMappingURL=data:…`, it
 * just belongs to whichever module the bundler happened to emit last.
 *
 * That is the difference between this file and the other fail-closed cases in
 * `panel-locate.test.ts`. A bundle with no map, a map that 404s, a map that will
 * not parse: each of those *announces* its own failure, and the locate reports
 * it. This one announces success. The needle is found, a map is fetched and
 * parsed, a segment covers the position, and the answer comes back `resolved`
 * with a file the component was never written in and no caveat at all — the one
 * outcome this engine is built to make impossible.
 *
 * So the fixture is arranged to bite: the second test below asserts that the map
 * at the end of the chunk really does answer for the hit, confidently and
 * wrongly. Without that, a test that merely watches the refusal happen would
 * keep passing if the danger it guards against ever stopped being real, and
 * would never say so.
 *
 * Dev-only, which is why this is a correctness guard rather than a production
 * one: nobody ships `eval-source-map`. A developer locating a component on their
 * own dev server is exactly who reads the answer most closely, though, and a
 * confident wrong path costs them more than a missing one.
 */

import { describe, expect, it } from 'vitest';

import type { BundleProvider } from '../src/core/locate/provider.js';
import {
  decodeDataUrl,
  extractSourceMappingURL,
  lookupFunctionStart,
  parseSourceMap,
} from '../src/core/locate/sourcemap.js';
import type { PickedComponent } from '../src/shared/types.js';
import { locateComponent } from '../src/ui/locator/locate.js';
import { sourceMapJson, type FixtureSegment } from './helpers/sourcemap-fixture.js';

// ── The fixture ──────────────────────────────────────────────────────────────

/**
 * What `fn.toString()` hands back for the picked component.
 *
 * Deliberately free of newlines, quotes and backslashes. Webpack stores a module
 * as a JS string literal, so most compiled source appears in the chunk with its
 * newlines written `\n` and its quotes escaped, and no needle taken from the
 * running function can match that. This one survives the escaping verbatim,
 * which is what makes the chunk searchable at all — and a component simple
 * enough to compile to one quote-free line is an ordinary thing to click on.
 */
const FN = 'function Total(props){return props.a+props.b}';

const DATA_PREFIX = 'data:application/json;charset=utf-8;base64,';

/** One module's own inline map, written the way webpack writes it. */
function inlineMap(source: string, lines: FixtureSegment[][]): string {
  const json = sourceMapJson([source], lines);
  return DATA_PREFIX + Buffer.from(json, 'utf8').toString('base64');
}

/**
 * The map belonging to the module the hit is actually in.
 *
 * Its generated coordinates are the eval'd text's own — line 0 is the first line
 * of the module, not of the chunk — which is the whole reason the chunk's last
 * annotation cannot stand in for it.
 */
const TOTAL_MAP = inlineMap('webpack://app/./src/Total.jsx', [
  [{ generatedColumn: 12, sourceIndex: 0, originalLine: 3, originalColumn: 0 }],
]);

/**
 * The map belonging to the *last* module, which is the one the old tail scan
 * would have returned. Its segment on generated line 3 is what turns a hit in
 * `Total.jsx` into a confident answer of `Other.jsx`.
 */
const OTHER_MAP = inlineMap('webpack://app/./src/Other.jsx', [
  [],
  [],
  [],
  [{ generatedColumn: 0, sourceIndex: 0, originalLine: 7, originalColumn: 0 }],
]);

/** One module, wrapped as `eval("…")` with its map hung off the end of the string. */
function evalModule(body: string, map: string): string {
  return `eval("${body}\\n\\n//# sourceURL=[module]\\n//# sourceMappingURL=${map}");`;
}

/** A chunk built with `devtool: 'eval-source-map'`, two modules deep. */
const EVAL_CHUNK = [
  '(() => {',
  'var __webpack_modules__ = ({',
  '"./src/Total.jsx": ((module, exports, __webpack_require__) => {',
  evalModule(`var Total = ${FN};`, TOTAL_MAP),
  '}),',
  '"./src/Other.jsx": ((module, exports, __webpack_require__) => {',
  evalModule('var Other = 1;', OTHER_MAP),
  '})',
  '});',
  '})();',
].join('\n');

/** Where `searchBundle` finds `FN` in the chunk above — line 3, column 18. */
const HIT_LINE = 3;
const HIT_COLUMN = EVAL_CHUNK.split('\n')[HIT_LINE].indexOf(FN);

const MAIN = 'https://shop.test/main.js';

interface Fake extends BundleProvider {
  urlReads: string[];
}

function fakeProvider(scripts: [url: string, text: string][]): Fake {
  const urlReads: string[] = [];

  return {
    urlReads,
    listScripts: () => Promise.resolve(scripts.map(([url]) => url)),
    loadScript: (url) =>
      Promise.resolve(scripts.find(([known]) => known === url)?.[1] ?? null),
    loadUrl: (url) => {
      urlReads.push(url);
      return Promise.resolve(null);
    },
  };
}

const PICKED: PickedComponent = { name: 'Total' };

function run(provider: Fake) {
  return locateComponent(
    {
      component: PICKED,
      pageUrl: 'https://shop.test/checkout',
      useSourceMaps: true,
      concurrency: 4,
    },
    { provider, readSource: () => Promise.resolve(FN) },
  );
}

// ── The fixture is dangerous, which is what makes the refusal worth having ────

describe('a chunk with one map per eval’d module', () => {
  it('puts the needle in one module and the last annotation in another', () => {
    expect(HIT_COLUMN).toBe(18);
    // Two annotations, both inside string literals — the shape the audit names.
    expect(EVAL_CHUNK.match(/sourceMappingURL/g)).toHaveLength(2);
    expect(EVAL_CHUNK).toContain(`\\n//# sourceMappingURL=${DATA_PREFIX}`);
  });

  it('would answer confidently, and wrongly, from the map that ends the chunk', () => {
    const map = parseSourceMap(decodeDataUrl(OTHER_MAP));
    const wrong = lookupFunctionStart(map, HIT_LINE, HIT_COLUMN, FN.length);

    // Not null, not an error: a plausible file and line for a component that is
    // not in it. This is the answer the refusal exists to prevent.
    expect(wrong?.source).toBe('src/Other.jsx');
    expect(wrong?.line).toBe(7);
  });
});

// ── The refusal ──────────────────────────────────────────────────────────────

describe('extractSourceMappingURL on an eval chunk', () => {
  it('reads no annotation at all rather than the wrong module’s', () => {
    expect(extractSourceMappingURL(EVAL_CHUNK)).toBeNull();
  });

  it('refuses through the long-annotation pass as well as the tail scan', () => {
    // A map big enough that the whole annotation falls outside the 2000-char
    // tail window, so the `lastIndexOf` pass is the one that answers.
    const long = inlineMap(
      'webpack://app/./src/Other.jsx',
      Array.from({ length: 600 }, () => [
        { generatedColumn: 0, sourceIndex: 0, originalLine: 7, originalColumn: 0 },
      ]),
    );
    expect(long.length).toBeGreaterThan(2000);

    const chunk = [
      '(() => {',
      evalModule(`var Total = ${FN};`, TOTAL_MAP),
      evalModule('var Other = 1;', long),
      '})();',
    ].join('\n');

    expect(extractSourceMappingURL(chunk)).toBeNull();
  });

  it('is unmoved by a string literal that merely contains a newline escape', () => {
    // The escape is there, but the annotation is a real trailing comment: the
    // quote and semicolon closing the statement sit between the two.
    const bundle = 'var s = "a\\nb";\n//# sourceMappingURL=app.js.map\n';
    expect(extractSourceMappingURL(bundle)).toBe('app.js.map');
  });

  it('still takes the last of several genuine annotations', () => {
    expect(extractSourceMappingURL('//# sourceMappingURL=a.map\n//# sourceMappingURL=b.map')).toBe(
      'b.map',
    );
  });

  it('still reads an inlined map, a legacy spelling and the block-comment form', () => {
    expect(extractSourceMappingURL(`var a=1;\n//# sourceMappingURL=${TOTAL_MAP}`)).toBe(TOTAL_MAP);
    expect(extractSourceMappingURL('x\n//@ sourceMappingURL=a.map')).toBe('a.map');
    expect(extractSourceMappingURL('x\n/*# sourceMappingURL=b.map */')).toBe('b.map');
  });
});

// ── What the locate reports instead ──────────────────────────────────────────

describe('locating a component in an eval chunk', () => {
  it('stops at the compiled position instead of naming another module’s file', async () => {
    const outcome = await run(fakeProvider([[MAIN, EVAL_CHUNK]]));

    expect(outcome.source.status).not.toBe('resolved');
    expect(outcome.source.status).toBe('compiled-only');
    expect(outcome.source).not.toHaveProperty('source');
    expect(outcome.source.compiled).toEqual({
      url: MAIN,
      line: HIT_LINE,
      column: HIT_COLUMN,
    });
  });

  it('asks for no map file, because it announced none it could use', async () => {
    const provider = fakeProvider([[MAIN, EVAL_CHUNK]]);
    await run(provider);
    expect(provider.urlReads).toEqual([]);
  });
});
