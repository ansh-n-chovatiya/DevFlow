import { describe, expect, it } from 'vitest';
import { decodeLine, decodeMappings, findSegmentInLine } from '../src/core/react/vlq.js';
import {
  decodeDataUrl,
  extractSourceMappingURL,
  lookupOriginal,
  parseSourceMap,
  SourceMapError,
} from '../src/core/react/sourcemap.js';
import { encodeMappings, sourceMapJson, type FixtureSegment } from './helpers/sourcemap-fixture.js';

/**
 * Three generated lines, deliberately awkward: a line with no segments at all,
 * a one-field segment with no original counterpart, and cumulative fields that
 * only come out right if every preceding line was walked.
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

describe('streaming decode', () => {
  const mappings = encodeMappings(LINES);

  it('gives the same answer as decoding the whole map', () => {
    const whole = decodeMappings(mappings);

    for (let line = 0; line < whole.length; line++) {
      expect(decodeLine(mappings, line)).toEqual(whole[line]);
    }
  });

  it('carries the running counters across lines it does not keep', () => {
    // Only correct if line 0's deltas were applied while decoding line 2.
    expect(decodeLine(mappings, 2)?.[2]).toEqual({
      generatedColumn: 30,
      sourceIndex: 0,
      originalLine: 7,
      originalColumn: 11,
    });
  });

  it('answers null past the end of the map rather than throwing', () => {
    expect(decodeLine(mappings, 99)).toBeNull();
    expect(decodeLine(mappings, -1)).toBeNull();
  });

  it('skips malformed segments instead of losing the rest of the line', () => {
    const decoded = decodeMappings('AAAA,!!!!,IAAA');
    expect(decoded[0]).toHaveLength(2);
    expect(decoded[0][1].generatedColumn).toBe(4);
  });
});

describe('findSegmentInLine', () => {
  const segments = decodeLine(encodeMappings(LINES), 0);

  it('takes the last segment starting at or before the column', () => {
    expect(findSegmentInLine(segments, 20)?.generatedColumn).toBe(12);
    expect(findSegmentInLine(segments, 12)?.generatedColumn).toBe(12);
    expect(findSegmentInLine(segments, 11)?.generatedColumn).toBe(0);
  });

  it('is null when nothing covers the column', () => {
    expect(findSegmentInLine([], 0)).toBeNull();
    expect(findSegmentInLine([{ generatedColumn: 5 }], 2)).toBeNull();
  });
});

describe('lookupOriginal', () => {
  const map = parseSourceMap(sourceMapJson(['src/Cart.tsx', 'src/Price.tsx'], LINES));

  it('converts to 1-based, once, at this edge', () => {
    // The fixture records line 3, column 4 — 0-based, as the format stores it.
    const found = lookupOriginal(map, 0, 12);
    expect(found).toEqual({ source: 'src/Cart.tsx', line: 4, column: 5, name: null });
  });

  it('maps position 0,0 to line 1, column 1 rather than 0', () => {
    expect(lookupOriginal(map, 0, 0)).toMatchObject({ line: 1, column: 1 });
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
      line: 10,
      column: 1,
      name: null,
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

    expect(lookupOriginal(map, 2, 20)?.line).toBe(1);
    // Second line of the section starts at column 0 again, not 20.
    expect(lookupOriginal(map, 3, 0)?.line).toBe(2);
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
