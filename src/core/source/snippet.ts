/**
 * The few lines around the one a component was written on.
 *
 * Locating a component ends with a path and a line number, and a reader — or a
 * model about to edit the file — then has to go and look. This is the looking,
 * minus the part that touches a disk. Windowing, numbering and marking are
 * decisions about what a person reads, so they are decided here, under tests,
 * with nothing but strings going in and out; opening the file, resolving it
 * against a root and refusing a path that climbs out of the project are
 * decisions about trust, and those belong to the server that owns the
 * filesystem. Splitting them the other way would have put the only interesting
 * logic behind an `fs` mock, and the security check somewhere a browser build
 * could reach.
 *
 * The target line can genuinely be past the end of the file, and that is not a
 * malformed input to be clamped away. A source map records the line as it was
 * in the tree the bundle was built from; the file on disk is whatever the
 * checkout says now. A stale map naming line 900 of a 40-line file is the
 * ordinary consequence of a stale build, and the failure it produces if it is
 * hidden is far worse than the one it produces if it is reported: clamping the
 * window silently prints the last few lines of the file, which read as the
 * component's own code and are not. So the window still ends at the end of the
 * file — seeing what the file actually finishes with is how a reader recognises
 * a stale build — and `beyondEnd` says out loud that the line asked for was not
 * in it.
 *
 * The per-line cap exists because one of these lines may be a minified bundle:
 * a single 200 KB statement that no reader gains anything from and that would
 * spend the whole tool response on its own. Cutting it and saying how much was
 * cut keeps the surrounding lines — which are the point — affordable.
 */

import type { Pos1 } from '../react/positions.js';

/**
 * Characters of one source line worth printing.
 *
 * Past this it is not a line anyone reads; it is a build artefact that happens
 * to contain the component.
 */
const LINE_CAP = 400;

export interface Snippet {
  /** The window, one string per line, gutter-numbered, target line marked. */
  lines: string[];
  /** `lines 22–46 of 180` — so a reader knows this is a window, not the file. */
  range: string;
  /**
   * The target line is past the end of the file.
   *
   * A source map can name line 900 of a 40-line file when the build it was made
   * from is not the checkout on disk, and a snippet that quietly showed the last
   * few lines instead would read as the component's own code.
   */
  beyondEnd: boolean;
}

/**
 * The file as lines, with the line endings gone.
 *
 * A file ending in a newline has not got a final empty line — `"a\nb\n"` is the
 * same two lines as `"a\nb"`, which is what every editor's gutter says and what
 * the numbers here have to agree with. A lone trailing `\r` is a CRLF file's
 * line ending, not content, and printing it puts a stray carriage return in the
 * middle of the response.
 */
function fileLines(text: string): string[] {
  if (text === '') return [];

  const parts = text.split('\n');
  if (parts[parts.length - 1] === '') parts.pop();

  return parts.map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
}

/** One line, cut to something printable, saying how much it lost. */
function capLine(line: string): string {
  if (line.length <= LINE_CAP) return line;
  return `${line.slice(0, LINE_CAP)} …[+${line.length - LINE_CAP} chars]`;
}

/**
 * @param text   the whole file, as read off disk
 * @param target the line the component was written on
 * @param radius how many lines to show either side of it
 */
export function snippet(text: string, target: Pos1, radius: number): Snippet {
  const lines = fileLines(text);
  const total = lines.length;

  /*
   * Everything below counts in plain numbers over `lines`. That is array
   * indexing, not position arithmetic: no value computed here is a `Pos1`, and
   * none leaves — the bounds go out inside `range`, as text, so that no caller
   * can pick a bare number off this result and pass it somewhere a typed
   * position was wanted.
   */
  const line = Math.max(1, Math.floor(target));
  const span = Number.isFinite(radius) && radius > 0 ? Math.floor(radius) : 0;
  const beyondEnd = line > total;

  if (total === 0) return { lines: [], range: 'the file is empty', beyondEnd };

  // Past the end, the window is the tail of the file: the last lines are the
  // evidence that the file is shorter than the map thinks.
  const last = beyondEnd ? total : Math.min(total, line + span);
  const first = Math.max(1, (beyondEnd ? total : line) - span);

  // The widest number in the window, so the pipes stand in one column.
  const width = String(last).length;

  const out: string[] = [];
  for (let number = first; number <= last; number++) {
    const mark = number === line ? '>' : ' ';
    const gutter = `${mark}${String(number).padStart(width, ' ')} |`;
    const body = capLine(lines[number - 1]);
    out.push(body === '' ? gutter : `${gutter} ${body}`);
  }

  const range =
    first === last ? `line ${first} of ${total}` : `lines ${first}–${last} of ${total}`;

  return { lines: out, range, beyondEnd };
}
