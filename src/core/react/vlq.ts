/**
 * Base64-VLQ decoding for source maps.
 *
 * Ported from react-source-locator `src/core/vlq.ts` @ 314488d.
 *
 * One deliberate divergence, and it is the reason this file exists rather than
 * being copied verbatim: **decoding is streaming**. Upstream materialises every
 * segment of the whole map as an object graph, which a DevTools panel survives
 * and an MV3 service worker does not — a 30 MB map becomes hundreds of megabytes
 * of JS objects and the worker is killed mid-flow.
 *
 * We only ever want one position. The VLQ fields are *cumulative deltas* across
 * the entire map, so earlier lines cannot be skipped — but their segments need
 * not be kept. `decodeLine` walks forward carrying only the running counters and
 * retains segments for the target line alone, then stops. Memory is O(one line)
 * instead of O(map), and on a minified bundle — everything on generated line 0 —
 * it is also dramatically faster, because it stops after the first line.
 *
 * `decodeMappings` is kept as the reference implementation: it is what the
 * streaming path is tested against, and it is small.
 *
 * Source map `mappings` are semicolon-separated lines, comma-separated segments,
 * each segment 1, 4 or 5 base64-VLQ numbers. See https://tc39.es/ecma426/.
 *
 * Pure — no DOM, no Chrome.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const CHAR_TO_INT = new Int16Array(128).fill(-1);
for (let i = 0; i < B64.length; i++) CHAR_TO_INT[B64.charCodeAt(i)] = i;

/*
 * Tier 3 — deliberately not configurable. These are the VLQ
 * encoding defined by the source-map spec, not a tuning choice. A different
 * mask does not decode maps differently; it decodes them wrongly, and the
 * result is a plausible file and line that point somewhere else.
 */
const VLQ_CONTINUATION = 0b100000;
const VLQ_VALUE_MASK = 0b011111;

const COMMA = 44; // ','
const SEMICOLON = 59; // ';'

/**
 * A decoded mapping segment. All fields are 0-based, as the format defines them;
 * the conversion to the 1-based numbers humans read happens once, in
 * `sourcemap.ts`.
 *
 * `sourceIndex`/`originalLine`/`originalColumn` are absent for 1-field segments,
 * which mark generated code with no original counterpart.
 */
export interface MappingSegment {
  generatedColumn: number;
  sourceIndex?: number;
  originalLine?: number;
  originalColumn?: number;
  nameIndex?: number;
}

/** Decoded mappings indexed by generated line; each line's segments are column-sorted. */
export type DecodedMappings = MappingSegment[][];

/**
 * The fields that carry across lines. Only `generatedColumn` resets, which is
 * what makes a mid-map seek impossible and this forward walk necessary.
 */
interface Counters {
  sourceIndex: number;
  originalLine: number;
  originalColumn: number;
  nameIndex: number;
}

function newCounters(): Counters {
  return { sourceIndex: 0, originalLine: 0, originalColumn: 0, nameIndex: 0 };
}

/**
 * Reads one comma-terminated segment into `fields`, returning the index just
 * past it.
 *
 * A malformed segment comes back as zero fields rather than throwing: real maps
 * from older toolchains carry stray characters, and a map that is 99% usable
 * still answers the question. The caller skips anything that is not 1, 4 or 5
 * fields, so an empty result needs no separate signal.
 */
function readSegment(mappings: string, from: number, end: number, fields: number[]): number {
  fields.length = 0;

  let value = 0;
  let shift = 0;
  let started = false;
  let malformed = false;
  let i = from;

  for (; i < end; i++) {
    const code = mappings.charCodeAt(i);
    if (code === COMMA) {
      i++;
      break;
    }

    const digit = code < 128 ? CHAR_TO_INT[code] : -1;
    if (digit === -1) {
      malformed = true;
      continue;
    }

    started = true;
    value += (digit & VLQ_VALUE_MASK) << shift;

    if (digit & VLQ_CONTINUATION) {
      shift += 5;
      // Guard against absurd continuation runs overflowing into float territory.
      if (shift > 31) malformed = true;
      continue;
    }

    // Low bit is the sign; the rest is magnitude.
    const negative = (value & 1) === 1;
    fields.push(negative ? -(value >>> 1) : value >>> 1);

    value = 0;
    shift = 0;
    started = false;
  }

  // A trailing continuation bit means the segment was truncated.
  if (started || malformed) fields.length = 0;

  return i;
}

/**
 * Decodes one generated line, advancing `counters` as it goes.
 *
 * `out` is where the segments land, or `null` to advance the counters and keep
 * nothing — which is the whole point of the streaming decode. The decode work is
 * identical either way; only the allocation is skipped.
 */
function decodeLineRange(
  mappings: string,
  start: number,
  end: number,
  counters: Counters,
  out: MappingSegment[] | null,
): void {
  const fields: number[] = [];
  let generatedColumn = 0; // resets each generated line
  let i = start;

  while (i < end) {
    i = readSegment(mappings, i, end, fields);

    // 1, 4 and 5 are the only counts the spec defines.
    const count = fields.length;
    if (count !== 1 && count !== 4 && count !== 5) continue;

    generatedColumn += fields[0];

    if (count === 1) {
      out?.push({ generatedColumn });
      continue;
    }

    counters.sourceIndex += fields[1];
    counters.originalLine += fields[2];
    counters.originalColumn += fields[3];
    if (count === 5) counters.nameIndex += fields[4];

    if (out) {
      const segment: MappingSegment = {
        generatedColumn,
        sourceIndex: counters.sourceIndex,
        originalLine: counters.originalLine,
        originalColumn: counters.originalColumn,
      };
      if (count === 5) segment.nameIndex = counters.nameIndex;
      out.push(segment);
    }
  }

  // Encoders are not required to emit segments in column order.
  out?.sort((a, b) => a.generatedColumn - b.generatedColumn);
}

/** Index just past the end of the generated line beginning at `start`. */
function lineEnd(mappings: string, start: number): number {
  const at = mappings.indexOf(';', start);
  return at === -1 ? mappings.length : at;
}

/**
 * Segments of one generated line, decoded without keeping any other line.
 *
 * Returns null when the map has fewer lines than asked for — a real answer of
 * "this position is past the end of the map", not an error.
 */
export function decodeLine(mappings: string, targetLine: number): MappingSegment[] | null {
  if (targetLine < 0) return null;

  const counters = newCounters();
  let start = 0;

  for (let line = 0; ; line++) {
    const end = lineEnd(mappings, start);

    if (line === targetLine) {
      const segments: MappingSegment[] = [];
      decodeLineRange(mappings, start, end, counters, segments);
      return segments;
    }

    decodeLineRange(mappings, start, end, counters, null);

    if (end >= mappings.length) return null; // no more lines
    start = end + 1;
  }
}

/**
 * Decodes an entire `mappings` string.
 *
 * The reference implementation, and the thing `decodeLine` is tested against.
 * Nothing on the resolution path calls it, because a large map decoded whole is
 * exactly what gets a service worker killed.
 */
export function decodeMappings(mappings: string): DecodedMappings {
  const counters = newCounters();
  const lines: DecodedMappings = [];

  let start = 0;
  for (;;) {
    const end = lineEnd(mappings, start);

    const segments: MappingSegment[] = [];
    decodeLineRange(mappings, start, end, counters, segments);
    lines.push(segments);

    if (end >= mappings.length) return lines;
    start = end + 1;
  }
}

/** How many generated lines a `mappings` string covers, without decoding it. */
export function countLines(mappings: string): number {
  let count = 1;
  for (let i = 0; i < mappings.length; i++) {
    if (mappings.charCodeAt(i) === SEMICOLON) count++;
  }
  return count;
}

/**
 * The mapping covering `column` on an already-decoded line: the last segment
 * starting at or before it, which is how a generated position maps back.
 *
 * Returns null when the line has no mappings or the column precedes them all.
 */
export function findSegmentInLine(
  segments: MappingSegment[] | null,
  column: number,
): MappingSegment | null {
  if (!segments || segments.length === 0) return null;

  // Binary search for the rightmost segment with generatedColumn <= column.
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (segments[mid].generatedColumn <= column) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return found === -1 ? null : segments[found];
}
