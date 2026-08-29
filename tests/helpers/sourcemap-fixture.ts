/**
 * A minimal base64-VLQ *encoder*, so source map tests build real fixtures.
 *
 * Hand-written `mappings` strings are unreadable and easy to get subtly wrong,
 * and a fixture that is wrong in the same way as the decoder proves nothing.
 * This encodes from absolute positions, which is the thing a test can state
 * plainly, and does the delta arithmetic itself.
 */

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

export interface FixtureSegment {
  /** 0-based column in the generated file. */
  generatedColumn: number;
  sourceIndex?: number;
  /** 0-based, as the format stores it. */
  originalLine?: number;
  originalColumn?: number;
  nameIndex?: number;
}

function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1;
  let out = '';

  do {
    let digit = vlq & 0b11111;
    vlq >>>= 5;
    if (vlq > 0) digit |= 0b100000;
    out += B64[digit];
  } while (vlq > 0);

  return out;
}

/** Encodes generated lines of absolute segments into a `mappings` string. */
export function encodeMappings(lines: FixtureSegment[][]): string {
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let nameIndex = 0;

  return lines
    .map((segments) => {
      let generatedColumn = 0;

      return segments
        .map((segment) => {
          const fields = [segment.generatedColumn - generatedColumn];
          generatedColumn = segment.generatedColumn;

          if (segment.sourceIndex !== undefined) {
            fields.push(segment.sourceIndex - sourceIndex);
            fields.push((segment.originalLine ?? 0) - originalLine);
            fields.push((segment.originalColumn ?? 0) - originalColumn);
            sourceIndex = segment.sourceIndex;
            originalLine = segment.originalLine ?? 0;
            originalColumn = segment.originalColumn ?? 0;

            if (segment.nameIndex !== undefined) {
              fields.push(segment.nameIndex - nameIndex);
              nameIndex = segment.nameIndex;
            }
          }

          return fields.map(encodeVlq).join('');
        })
        .join(',');
    })
    .join(';');
}

/** A complete v3 map as JSON text. */
export function sourceMapJson(
  sources: string[],
  lines: FixtureSegment[][],
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    version: 3,
    sources,
    names: [],
    mappings: encodeMappings(lines),
    ...extra,
  });
}
