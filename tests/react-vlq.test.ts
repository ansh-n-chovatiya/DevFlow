/**
 * Base64-VLQ decoding.
 *
 * Both extensions tested this file and each had found cases the other had not:
 * one owned the streaming decode against the reference decode, the other owned
 * the encoding itself — sign bits, continuation bytes, field counts the spec
 * does not define. Both are here, because there is one decoder now.
 *
 * The hand-written `mappings` strings are the sharper fixtures for the encoding
 * cases: they say what a byte means. The generated ones (`encodeMappings`) are
 * the sharper fixtures for the streaming walk, because a fixture that is wrong
 * in the same way as the decoder proves nothing.
 */

import { describe, expect, it } from 'vitest';
import {
  countLines,
  decodeLine,
  decodeMappings,
  findSegment,
  findSegmentInLine,
} from '../src/core/locate/vlq.js';
import { encodeMappings, type FixtureSegment } from './helpers/sourcemap-fixture.js';

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

describe('decodeMappings, the reference decode', () => {
  it('decodes a single zero segment', () => {
    // "AAAA" is four zero deltas: generated col 0 → source 0, line 0, col 0.
    expect(decodeMappings('AAAA')).toEqual([
      [{ generatedColumn: 0, sourceIndex: 0, originalLine: 0, originalColumn: 0 }],
    ]);
  });

  it('accumulates deltas across segments on one line', () => {
    expect(decodeMappings('AAAA,EAAE')[0]).toEqual([
      { generatedColumn: 0, sourceIndex: 0, originalLine: 0, originalColumn: 0 },
      { generatedColumn: 2, sourceIndex: 0, originalLine: 0, originalColumn: 2 },
    ]);
  });

  it('resets the generated column each line but carries the other fields', () => {
    const decoded = decodeMappings('AAAA;AACA');
    expect(decoded).toHaveLength(2);
    expect(decoded[1][0]).toEqual({
      generatedColumn: 0,
      sourceIndex: 0,
      originalLine: 1,
      originalColumn: 0,
    });
  });

  it('decodes negative values via the sign bit', () => {
    // "D" encodes -1: raw 3, sign bit set, magnitude 1. Every delta goes
    // negative, so this segment sorts ahead of the leading zero segment.
    expect(decodeMappings('AAAA,DDDD')[0]).toEqual([
      { generatedColumn: -1, sourceIndex: -1, originalLine: -1, originalColumn: -1 },
      { generatedColumn: 0, sourceIndex: 0, originalLine: 0, originalColumn: 0 },
    ]);
  });

  it('decodes multi-digit continuation values', () => {
    // "gB" is 16 — a continuation byte plus the high bits, a common delta.
    expect(decodeMappings('gBAAA')[0][0].generatedColumn).toBe(16);
  });

  it('keeps the name index as a fifth field', () => {
    expect(decodeMappings('AAAAA')[0][0].nameIndex).toBe(0);
  });

  it('emits an empty array for a line with no segments', () => {
    expect(decodeMappings('AAAA;;AAAA')[1]).toEqual([]);
  });

  it('skips malformed segments instead of losing the rest of the line', () => {
    // "!" is not a base64 digit; the valid segments either side survive, because
    // a map that is 99% usable still answers the question asked of it.
    expect(decodeMappings('AAAA,!!!,EAAE')[0]).toHaveLength(2);

    const decoded = decodeMappings('AAAA,!!!!,IAAA');
    expect(decoded[0]).toHaveLength(2);
    expect(decoded[0][1].generatedColumn).toBe(4);
  });

  it('drops segments with a field count the spec does not define', () => {
    expect(decodeMappings('AA')[0]).toEqual([]);
  });

  it('sorts segments by generated column, which encoders need not do', () => {
    const columns = decodeMappings('UAAA,pBAAA')[0].map((s) => s.generatedColumn);
    expect(columns).toEqual([...columns].sort((a, b) => a - b));
  });
});

describe('the streaming decode', () => {
  const mappings = encodeMappings(LINES);

  it('gives the same answer as decoding the whole map', () => {
    const whole = decodeMappings(mappings);

    for (let line = 0; line < whole.length; line++) {
      expect(decodeLine(mappings, line)).toEqual(whole[line]);
    }
  });

  it('carries the running counters across lines it does not keep', () => {
    // The property the whole design rests on: fields are cumulative deltas, so
    // earlier lines have to be walked even though their segments are dropped.
    expect(decodeLine(mappings, 2)?.[2]).toEqual({
      generatedColumn: 30,
      sourceIndex: 0,
      originalLine: 7,
      originalColumn: 11,
    });
  });

  it('answers null past the end of the map rather than throwing', () => {
    expect(decodeLine(mappings, 99)).toBeNull();
    expect(decodeLine(mappings, countLines(mappings))).toBeNull();
    expect(decodeLine(mappings, -1)).toBeNull();
  });

  it('distinguishes a line that maps nothing from a line that is not there', () => {
    // An empty array reads as "this line exists and maps nothing", which is a
    // different fact from "the map does not reach this line".
    expect(decodeLine(mappings, 1)).toEqual([]);
  });

  it('reaches the same answer as the reference path for a mid-map lookup', () => {
    const streamed = findSegmentInLine(decodeLine(mappings, 2), 9);
    expect(streamed).toEqual(findSegment(decodeMappings(mappings), 2, 9));
    expect(streamed?.sourceIndex).toBeDefined();
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

describe('findSegment, on a fully decoded map', () => {
  const decoded = decodeMappings('AAAA,EAAE,EAAE');

  it('returns the segment starting exactly at the column', () => {
    expect(findSegment(decoded, 0, 2)?.generatedColumn).toBe(2);
  });

  it('returns the closest segment at or before the column', () => {
    expect(findSegment(decoded, 0, 3)?.generatedColumn).toBe(2);
  });

  it('returns the last segment for a column past every mapping', () => {
    expect(findSegment(decoded, 0, 999)?.generatedColumn).toBe(4);
  });

  it('returns null for a line the map has no row for', () => {
    expect(findSegment(decoded, 7, 0)).toBeNull();
  });
});

describe('countLines', () => {
  it('counts a single line with no separator', () => {
    expect(countLines('AAAA')).toBe(1);
  });

  it('counts trailing empty lines', () => {
    expect(countLines('AAAA;;')).toBe(3);
  });

  it('agrees with the full decode', () => {
    const mappings = 'AAAA;AACA;;AAAA';
    expect(countLines(mappings)).toBe(decodeMappings(mappings).length);
  });
});
