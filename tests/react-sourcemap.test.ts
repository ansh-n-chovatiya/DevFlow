import { describe, expect, it } from 'vitest';
import {
  decodeDataUrl,
  extractSourceMappingURL,
  lookupOriginal,
  parseSourceMap,
  SourceMapError,
} from '../src/core/locate/sourcemap.js';
import { sourceMapJson, type FixtureSegment } from './helpers/sourcemap-fixture.js';

/**
 * Three generated lines, deliberately awkward: a line with no segments at all,
 * a one-field segment with no original counterpart, and cumulative fields that
 * only come out right if every preceding line was walked. The decoding itself is
 * `react-vlq.test.ts`; what this file asks is what a *lookup* makes of it.
 */
const LINES: FixtureSegment[][] = [
  [
    { generatedColumn: 0, sourceIndex: 0, originalLine: 0, originalColumn: 0 },
    { generatedColumn: 12, sourceIndex: 0, originalLine: 3, originalColumn: 4 },
  ],
  [],
  [
    { generatedColumn: 0 },
    { generatedColumn: 8, sourceIndex: 1, originalLine: 40, originalColumn: 2 },
    { generatedColumn: 30, sourceIndex: 0, originalLine: 7, originalColumn: 11 },
  ],
];

describe('lookupOriginal', () => {
  const map = parseSourceMap(sourceMapJson(['src/Cart.tsx', 'src/Price.tsx'], LINES));

  /*
   * D1, and the assertion that changed with the merge. This used to add one
   * here, so that everything downstream of it was 1-based; the sibling
   * extension stayed 0-based all the way to `buildEditorUrl` and added one
   * there. The base is a type now: this returns exactly what the map says, and
   * `toOneBased` is applied once, by whichever surface shows the number.
   */
  it('reports what the map says, 0-based, and does not editorialise', () => {
    // The fixture records line 3, column 4 — 0-based, as the format stores it.
    const found = lookupOriginal(map, 0, 12);
    expect(found).toEqual({
      source: 'src/Cart.tsx',
      line: 3,
      column: 4,
      name: null,
      content: null,
    });
  });

  it('maps position 0,0 to line 0, column 0', () => {
    expect(lookupOriginal(map, 0, 0)).toMatchObject({ line: 0, column: 0 });
  });

  it('picks the right source when a line spans several files', () => {
    expect(lookupOriginal(map, 2, 9)?.source).toBe('src/Price.tsx');
    expect(lookupOriginal(map, 2, 31)?.source).toBe('src/Cart.tsx');
  });

  it('is null for generated code with no original counterpart', () => {
    // The 1-field segment at the start of line 2 maps to nothing.
    expect(lookupOriginal(map, 2, 1)).toBeNull();
    // And a line the map does not reach at all.
    expect(lookupOriginal(map, 9, 0)).toBeNull();
  });

  it('applies sourceRoot without mangling an absolute path', () => {
    const rooted = parseSourceMap(
      sourceMapJson(['App.tsx'], [[{ generatedColumn: 0, sourceIndex: 0 }]], {
        sourceRoot: 'src/ui',
      }),
    );
    expect(lookupOriginal(rooted, 0, 0)?.source).toBe('src/ui/App.tsx');
  });
});

describe('index maps', () => {
  it('resolves through the section covering the position', () => {
    const first = JSON.parse(sourceMapJson(['a.tsx'], [[{ generatedColumn: 0, sourceIndex: 0 }]]));
    const second = JSON.parse(
      sourceMapJson(['b.tsx'], [[{ generatedColumn: 0, sourceIndex: 0, originalLine: 9 }]]),
    );

    const map = parseSourceMap(
      JSON.stringify({
        version: 3,
        sections: [
          { offset: { line: 0, column: 0 }, map: first },
          { offset: { line: 5, column: 0 }, map: second },
        ],
      }),
    );

    expect(lookupOriginal(map, 0, 0)?.source).toBe('a.tsx');
    expect(lookupOriginal(map, 5, 0)).toEqual({
      source: 'b.tsx',
      line: 9,
      column: 0,
      name: null,
      content: null,
    });
  });

  it('shifts only the first line of a section horizontally', () => {
    const inner = JSON.parse(
      sourceMapJson(
        ['b.tsx'],
        [
          [{ generatedColumn: 0, sourceIndex: 0, originalLine: 0 }],
          [{ generatedColumn: 0, sourceIndex: 0, originalLine: 1 }],
        ],
      ),
    );

    const map = parseSourceMap(
      JSON.stringify({
        version: 3,
        sections: [{ offset: { line: 2, column: 20 }, map: inner }],
      }),
    );

    expect(lookupOriginal(map, 2, 20)?.line).toBe(0);
    // Second line of the section starts at column 0 again, not 20.
    expect(lookupOriginal(map, 3, 0)?.line).toBe(1);
  });

  it('refuses an index map whose sections are all by url', () => {
    expect(() =>
      parseSourceMap(
        JSON.stringify({ version: 3, sections: [{ offset: { line: 0, column: 0 }, url: 'a.map' }] }),
      ),
    ).toThrow(SourceMapError);
  });
});

describe('extractSourceMappingURL', () => {
  it('reads the annotation from the tail of a bundle', () => {
    expect(extractSourceMappingURL('var a=1;\n//# sourceMappingURL=app.js.map')).toBe('app.js.map');
  });

  it('reads a whole data: URI, which is one long unbroken token', () => {
    const annotation = 'data:application/json;base64,eyJ2IjozfQ==';
    expect(extractSourceMappingURL(`var a=1;\n//# sourceMappingURL=${annotation}`)).toBe(
      annotation,
    );
  });

  it('accepts the legacy @ spelling and the block-comment form', () => {
    expect(extractSourceMappingURL('x\n//@ sourceMappingURL=a.map')).toBe('a.map');
    expect(extractSourceMappingURL('x\n/*# sourceMappingURL=b.map */')).toBe('b.map');
  });

  it('takes the last annotation when a bundle carries more than one', () => {
    expect(extractSourceMappingURL('//# sourceMappingURL=a.map\n//# sourceMappingURL=b.map')).toBe(
      'b.map',
    );
  });

  it('ignores an annotation buried far from the end', () => {
    const bundle = `//# sourceMappingURL=early.map\n${'x'.repeat(5000)}`;
    expect(extractSourceMappingURL(bundle)).toBeNull();
  });

  it('is null when there is none', () => {
    expect(extractSourceMappingURL('var a = 1;')).toBeNull();
  });
});

describe('decodeDataUrl', () => {
  it('decodes base64 payloads as UTF-8', () => {
    const json = '{"sources":["src/Café.tsx"]}';
    const base64 = Buffer.from(json, 'utf-8').toString('base64');
    expect(decodeDataUrl(`data:application/json;base64,${base64}`)).toBe(json);
  });

  it('decodes percent-encoded payloads', () => {
    expect(decodeDataUrl('data:application/json,%7B%22a%22%3A1%7D')).toBe('{"a":1}');
  });

  it('throws on a payload with no comma at all', () => {
    expect(() => decodeDataUrl('data:application/json')).toThrow(SourceMapError);
  });
});

describe('parseSourceMap', () => {
  it('names JSON and missing-mappings failures separately', () => {
    expect(() => parseSourceMap('not json')).toThrow(/not valid JSON/);
    expect(() => parseSourceMap('{"version":3}')).toThrow(/no mappings/);
  });
});

describe('sourcesContent, which is D3', () => {
  /*
   * The bounded divergence. A panel renders a preview from the inlined original
   * source; a recorder must not keep it, because a flow is handed to an AI and
   * inlined source is both a token disaster and a way to leak code the user did
   * not mean to send. Getting this wrong costs a missing preview or a larger
   * object — never a wrong path, which is why it is a parameter where the line
   * base had to be a type.
   */
  const SOURCE = 'export function Cart() {\n  return null;\n}\n';

  function mapWithContent(): string {
    return sourceMapJson(['src/Cart.tsx'], [[{ generatedColumn: 0, sourceIndex: 0 }]], {
      sourcesContent: [SOURCE],
    });
  }

  it('is dropped by default, which is the recorder\'s answer', () => {
    const map = parseSourceMap(mapWithContent());
    expect(lookupOriginal(map, 0, 0)?.content).toBeNull();
  });

  it('is kept when a surface asks for it, which is the panel\'s', () => {
    const map = parseSourceMap(mapWithContent(), { keepSourcesContent: true });
    expect(lookupOriginal(map, 0, 0)?.content).toBe(SOURCE);
  });

  it('is not retained on the map either, so a large map does not sit in memory', () => {
    // Dropping it at lookup would still hold every source string for the life
    // of the parsed map, which on a real bundle is the bulk of the JSON.
    const map = parseSourceMap(mapWithContent());
    expect(map.kind === 'plain' && map.sourcesContent).toEqual([]);
  });

  it('rides down into an index map\'s sections', () => {
    // The one place a dropped `sourcesContent` could silently come back, or a
    // kept one silently go missing: a section is prepared by a second call.
    const inner = JSON.parse(mapWithContent()) as unknown;
    const json = JSON.stringify({
      version: 3,
      sections: [{ offset: { line: 0, column: 0 }, map: inner }],
    });

    expect(lookupOriginal(parseSourceMap(json), 0, 0)?.content).toBeNull();
    expect(
      lookupOriginal(parseSourceMap(json, { keepSourcesContent: true }), 0, 0)?.content,
    ).toBe(SOURCE);
  });

  it('is null for a map that inlined nothing, kept or not', () => {
    const bare = sourceMapJson(['src/Cart.tsx'], [[{ generatedColumn: 0, sourceIndex: 0 }]]);
    expect(lookupOriginal(parseSourceMap(bare, { keepSourcesContent: true }), 0, 0)?.content).toBeNull();
  });
});
