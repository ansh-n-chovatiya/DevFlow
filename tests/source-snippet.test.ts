import { describe, expect, it } from 'vitest';
import { snippet } from '../src/core/source/snippet.js';
import type { Pos1 } from '../src/core/react/positions.js';

/** A file whose every line names its own number, so a gutter bug is visible. */
const file = (count: number): string =>
  Array.from({ length: count }, (_, i) => `line ${i + 1}`).join('\n');

/** The line the reader is being pointed at, marked with `>`. */
const marked = (lines: string[]): string | undefined => lines.find((l) => l.startsWith('>'));

describe('the window around a component', () => {
  it('marks the line the component was written on and nothing else', () => {
    const { lines } = snippet(file(180), 34 as Pos1, 2);

    expect(lines.map((l) => l[0])).toEqual([' ', ' ', '>', ' ', ' ']);
    expect(marked(lines)).toBe('>34 | line 34');
  });

  it('shows only the target line when asked for no context', () => {
    const { lines, range } = snippet(file(180), 34 as Pos1, 0);

    expect(lines).toEqual(['>34 | line 34']);
    expect(range).toBe('line 34 of 180');
  });

  it('treats a nonsense radius as no context rather than throwing', () => {
    expect(snippet(file(10), 4 as Pos1, -5).lines).toEqual(['>4 | line 4']);
    expect(snippet(file(10), 4 as Pos1, Number.NaN).lines).toEqual(['>4 | line 4']);
    expect(snippet(file(10), 4 as Pos1, Number.POSITIVE_INFINITY).lines).toEqual(['>4 | line 4']);
  });

  it('stops at the top of the file instead of padding with blank lines', () => {
    const { lines, range } = snippet(file(10), 1 as Pos1, 3);

    expect(lines).toEqual(['>1 | line 1', ' 2 | line 2', ' 3 | line 3', ' 4 | line 4']);
    expect(range).toBe('lines 1–4 of 10');
  });

  it('stops at the end of the file instead of numbering lines that do not exist', () => {
    const { lines, range, beyondEnd } = snippet(file(10), 10 as Pos1, 3);

    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe('  7 | line 7');
    expect(marked(lines)).toBe('>10 | line 10');
    expect(lines.some((l) => l.includes('11 |'))).toBe(false);
    expect(range).toBe('lines 7–10 of 10');
    expect(beyondEnd).toBe(false);
  });

  it('says how much of the file the reader is being shown', () => {
    expect(snippet(file(180), 34 as Pos1, 12).range).toBe('lines 22–46 of 180');
  });

  it('keeps a blank source line blank rather than dropping it from the window', () => {
    const { lines } = snippet('const x = 1;\n\nreturn x;', 2 as Pos1, 1);

    expect(lines).toEqual([' 1 | const x = 1;', '>2 |', ' 3 | return x;']);
  });
});

describe('the gutter', () => {
  it('numbers lines with the file own 1-based numbers', () => {
    const { lines } = snippet(file(180), 100 as Pos1, 1);

    expect(lines).toEqual(['  99 | line 99', '>100 | line 100', ' 101 | line 101']);
  });

  it('lines the pipes up when the window crosses from one digit to two', () => {
    const { lines } = snippet(file(10), 10 as Pos1, 1);

    expect(lines).toEqual(['  9 | line 9', '>10 | line 10']);
    expect(new Set(lines.map((l) => l.indexOf('|')))).toEqual(new Set([4]));
  });

  it('lines the pipes up when the window crosses from two digits to three', () => {
    const { lines } = snippet(file(100), 100 as Pos1, 1);

    expect(lines).toEqual(['  99 | line 99', '>100 | line 100']);
    expect(new Set(lines.map((l) => l.indexOf('|')))).toEqual(new Set([5]));
  });
});

describe('line endings', () => {
  it('prints a Windows file without stray carriage returns', () => {
    const { lines, range } = snippet('const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n', 2 as Pos1, 1);

    expect(lines.join('\n')).not.toContain('\r');
    expect(lines[1]).toBe('>2 | const b = 2;');
    expect(range).toBe('lines 1–3 of 3');
  });

  it('does not count the newline a file ends with as another line', () => {
    expect(snippet('a\nb\n', 1 as Pos1, 5).range).toBe('lines 1–2 of 2');
    expect(snippet('a\nb', 1 as Pos1, 5).range).toBe('lines 1–2 of 2');
    expect(snippet('a\nb\n', 1 as Pos1, 5).lines).toHaveLength(2);
  });
});

describe('a minified line', () => {
  it('is cut short and says how many characters it lost', () => {
    const { lines } = snippet('x'.repeat(5000), 1 as Pos1, 0);

    expect(lines[0]).toBe(`>1 | ${'x'.repeat(400)} …[+4600 chars]`);
  });

  it('leaves a line that fits exactly alone', () => {
    const { lines } = snippet('x'.repeat(400), 1 as Pos1, 0);

    expect(lines[0]).toBe(`>1 | ${'x'.repeat(400)}`);
    expect(lines[0]).not.toContain('chars]');
  });

  it('leaves tabs as the file wrote them', () => {
    expect(snippet('\tif (x) {', 1 as Pos1, 0).lines[0]).toBe('>1 | \tif (x) {');
  });
});

describe('a target line past the end of the file', () => {
  it('is reported rather than quietly shown as the end of the file', () => {
    const stale = snippet(file(5), 900 as Pos1, 2);
    const real = snippet(file(5), 5 as Pos1, 2);

    expect(stale.beyondEnd).toBe(true);
    expect(real.beyondEnd).toBe(false);
    expect(stale.lines).not.toEqual(real.lines);
    expect(marked(stale.lines)).toBeUndefined();
    expect(marked(real.lines)).toBe('>5 | line 5');
  });

  it('still shows how the file ends, so a stale build is recognisable', () => {
    const { lines, range } = snippet(file(5), 900 as Pos1, 2);

    expect(lines).toEqual([' 3 | line 3', ' 4 | line 4', ' 5 | line 5']);
    expect(range).toBe('lines 3–5 of 5');
  });
});

describe('an empty file', () => {
  it('says it is empty instead of printing a blank line', () => {
    const { lines, range, beyondEnd } = snippet('', 1 as Pos1, 5);

    expect(lines).toEqual([]);
    expect(range).toBe('the file is empty');
    expect(beyondEnd).toBe(true);
  });
});
