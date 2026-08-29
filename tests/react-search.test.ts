import { describe, expect, it } from 'vitest';
import { countOccurrences, offsetToLineColumn, searchBundle } from '../src/core/react/search.js';
import { buildNeedle } from '../src/core/react/needle.js';
import { MAX_MATCHES_TRACKED } from '../src/shared/constants.js';

function needleFor(source: string) {
  const built = buildNeedle(source);
  if (!built.ok) throw new Error(`fixture rejected: ${built.reason}`);
  return built.needle;
}

const CART = 'function Cart(props){return renderTheWholeCart(props)}';

describe('offsetToLineColumn', () => {
  it('is 0-based on both axes', () => {
    expect(offsetToLineColumn('abc\ndef', 0)).toEqual({ line: 0, column: 0 });
    expect(offsetToLineColumn('abc\ndef', 4)).toEqual({ line: 1, column: 0 });
    expect(offsetToLineColumn('abc\ndef', 6)).toEqual({ line: 1, column: 2 });
  });

  it('keeps everything on line 0 for a minified bundle', () => {
    expect(offsetToLineColumn('a'.repeat(90_000), 88_214)).toEqual({ line: 0, column: 88_214 });
  });
});

describe('countOccurrences', () => {
  it('counts non-overlapping matches and stops at the cap', () => {
    expect(countOccurrences('aXbXcX', 'X')).toBe(3);
    expect(countOccurrences('XXXXXXXXXX', 'X', 3)).toBe(3);
  });

  it('is zero for a needle that is not there, or empty', () => {
    expect(countOccurrences('abc', 'z')).toBe(0);
    expect(countOccurrences('abc', '')).toBe(0);
  });
});

describe('searchBundle', () => {
  it('reports the position of the function start, 0-based', () => {
    const bundle = `var a=1;\n${CART}\n`;
    expect(searchBundle(bundle, needleFor(CART))).toMatchObject({
      line: 1,
      column: 0,
      matchCount: 1,
    });
  });

  it('walks a body-needle hit back to the start of the function', () => {
    // The head is gone — as if the bundler renamed the function — so only the
    // body needle can hit, and its offset has to be subtracted for the reported
    // position to still be the definition rather than the middle of it.
    const needle = needleFor(CART);
    expect(needle.body).toBeDefined();

    const renamed = CART.replace('function Cart', 'function e');
    const bundle = `${renamed}\n`;

    const found = searchBundle(bundle, needle);
    expect(found?.needleText).toBe(needle.body);
    expect(found?.column).toBe(0);
  });

  it('never reports a negative position when the body hit sits near the start', () => {
    const needle = { head: 'zzzzzzzzzzzz', body: 'unction Cart', bodyOffset: 50 };
    expect(searchBundle(CART, needle)).toMatchObject({ line: 0, column: 0 });
  });

  it('counts duplicates within one bundle', () => {
    const bundle = `${CART}\nvar b=2;\n${CART}\n`;
    expect(searchBundle(bundle, needleFor(CART))?.matchCount).toBe(2);
  });

  it('stops counting at the cap rather than scanning a huge bundle out', () => {
    const bundle = `${CART}\n`.repeat(MAX_MATCHES_TRACKED + 5);
    expect(searchBundle(bundle, needleFor(CART))?.matchCount).toBe(MAX_MATCHES_TRACKED);
  });

  it('is null when the component is not in this bundle', () => {
    expect(searchBundle('var a = 1;', needleFor(CART))).toBeNull();
  });
});
