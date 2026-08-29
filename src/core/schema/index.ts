/**
 * Body compaction.
 *
 * A recorded flow can carry megabytes of JSON response bodies. An AI reading the
 * flow needs the *shape* of a response, not 400 rows of it, so bodies over the
 * threshold are replaced with an inferred schema. The viewer keeps the raw body
 * and offers a "Show raw" toggle.
 */

import { SCHEMA_THRESHOLD } from '../../shared/constants.js';

/** Fields shown per object before the rest are summarised as a count. */
const MAX_FIELDS = 25;

/** Sibling values sampled when guessing whether a string field is an enum. */
const ENUM_SAMPLE = 15;

/** A string this long or shorter can be shown literally instead of as `string`. */
const SHORT_STRING = 30;

/**
 * Infer a compact type string for one value. `siblings` holds the same key's
 * values from a parent array, which is what makes enum detection possible.
 */
export function inferType(val: unknown, depth: number, siblings: unknown[] | null): string {
  if (val === null || val === undefined) return 'null';

  const t = typeof val;
  if (t === 'boolean') return 'boolean';
  if (t === 'number') return Number.isInteger(val) ? 'integer' : 'number';

  if (typeof val === 'string') {
    if (siblings?.length) {
      const unique = [
        ...new Set(siblings.filter((v): v is string => typeof v === 'string' && v.length <= SHORT_STRING)),
      ];
      if (unique.length >= 2 && unique.length <= 5) {
        return unique.map((v) => JSON.stringify(v)).join(' | ');
      }
    }
    return val.length <= SHORT_STRING ? JSON.stringify(val) : 'string';
  }

  if (Array.isArray(val)) {
    if (!val.length) return 'Array(0)';
    const first: unknown = val[0];
    if (typeof first === 'object' && first !== null && !Array.isArray(first) && depth > 0) {
      return `Array(${val.length}) of ${inferObjectSchema(first as Record<string, unknown>, val, depth - 1)}`;
    }
    return `Array(${val.length}) of ${inferType(first, depth - 1, null)}`;
  }

  if (t === 'object') {
    return depth > 0 ? inferObjectSchema(val as Record<string, unknown>, null, depth) : '{...}';
  }

  return t;
}

/** Infer a schema for one object. `parentArr` supplies siblings for enums. */
export function inferObjectSchema(
  obj: Record<string, unknown>,
  parentArr: unknown[] | null,
  depth: number,
): string {
  if (depth <= 0) return '{...}';

  const entries = Object.entries(obj);
  if (!entries.length) return '{}';

  const shown = entries.slice(0, MAX_FIELDS);
  const omitted = entries.length - shown.length;

  const fields = shown.map(([key, value]) => {
    const siblings = parentArr
      ? parentArr
          .slice(0, ENUM_SAMPLE)
          .map((item) => (item as Record<string, unknown> | null)?.[key])
          .filter((x) => typeof x === 'string')
      : null;
    return `  ${key}: ${inferType(value, depth - 1, siblings)}`;
  });

  if (omitted > 0) fields.push(`  // +${omitted} more fields`);
  return `{\n${fields.join(',\n')}\n}`;
}

/** Produce the schema string for an already-parsed JSON value. */
export function buildSchema(parsed: unknown): string {
  if (Array.isArray(parsed)) {
    if (!parsed.length) return 'Array(0)';
    const first: unknown = parsed[0];
    if (typeof first === 'object' && first !== null && !Array.isArray(first)) {
      return `Array(${parsed.length}) of ${inferObjectSchema(first as Record<string, unknown>, parsed, 3)}`;
    }
    return `Array(${parsed.length}) of ${inferType(first, 2, null)}`;
  }
  return inferType(parsed, 3, null);
}

/**
 * Replace a large body with its schema. Returns the original when it is under
 * the threshold, and falls back to truncation when it is not JSON.
 */
/**
 * What the capture already did to a body before it got here.
 *
 * Without this, a body the agent had cut short was indistinguishable from a
 * short one: the JSON parse failed on the missing tail and the result was
 * labelled `[non-JSON]`, which is the one thing it certainly was not.
 */
export interface BodyMeta {
  truncated?: boolean;
  /** Length of the original body, not of the prefix that survived. */
  bytes?: number;
  /**
   * This body *is* the diagnostic, not an example of a shape — the response to
   * a call that failed.
   *
   * A schema answers "what does this endpoint return"; it cannot answer "why
   * did this one break". `{"error":"Cannot read property 'id' of undefined",
   * "stack":"at CartService.total (…)"}` compacts to `{ error: string, stack:
   * string }`, which is every word of the failure replaced by the observation
   * that it had words. So a failed call keeps its body verbatim up to
   * `DIAGNOSTIC_LIMIT` — long enough for a stack trace, short enough that a
   * server returning its whole database on a 500 cannot blow the budget.
   */
  diagnostic?: boolean;
}

/**
 * How much of a failed call's body survives compaction.
 *
 * Larger than `SCHEMA_THRESHOLD` on purpose: the threshold asks "is this too
 * big to be worth showing", and for an error body the answer is almost always
 * no. A stack trace runs to two or three kilobytes and is worth every one.
 */
export const DIAGNOSTIC_LIMIT = 4096;

/**
 * Close whatever a truncated JSON body left open, so its shape can be read.
 *
 * A prefix cut at a fixed length almost always ends mid-value. Trimming back to
 * the last completed element and closing the brackets that are still open
 * recovers a document whose *schema* is the real one — which is all the caller
 * wants from a body this size. Strings are tracked so a brace inside one is not
 * mistaken for structure.
 */
function repairJson(prefix: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  // Where the last complete element ended, and the depth at that point.
  let safe = -1;

  for (let i = 0; i < prefix.length; i++) {
    const char = prefix[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }

    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char === '{' ? '}' : ']');
    else if (char === '}' || char === ']') {
      stack.pop();
      safe = i;
    } else if (char === ',' && stack.length > 0) safe = i - 1;
  }

  if (safe < 0) return null;

  // Re-walk the kept prefix, because trimming may have closed some of what was
  // open at the cut.
  const kept = prefix.slice(0, safe + 1);
  const open: string[] = [];
  inString = false;
  escaped = false;
  for (const char of kept) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') open.push('}');
    else if (char === '[') open.push(']');
    else if (char === '}' || char === ']') open.pop();
  }

  return kept + open.reverse().join('');
}

/**
 * The two settings that decide whether a body is summarised, and above what
 * size — `network.summariseBodies` and `network.schemaThreshold`.
 *
 * Passed in rather than read here, because this module is pure and is bundled
 * into the MCP server, which has no `chrome.storage` to read from. The defaults
 * are the shipped constants, which is what a caller with no opinion — a test, an
 * older flow with no stamp — should get.
 */
export interface BodyLimits {
  /** Bodies at or under this length are quoted verbatim. */
  threshold?: number;
  /** `false` quotes every body verbatim, however large. */
  summarise?: boolean;
}

export function compactBody(
  bodyStr: string | null | undefined,
  meta?: BodyMeta,
  limits?: BodyLimits,
): string | null | undefined {
  if (!bodyStr || typeof bodyStr !== 'string') return bodyStr;

  const threshold = limits?.threshold ?? SCHEMA_THRESHOLD;

  /*
   * Summarising switched off: the bytes, as they were captured.
   *
   * "Someone debugging a serialisation bug needs the bytes" is the whole reason
   * the setting exists, and handing them a schema anyway would make it a switch
   * that does nothing. Truncation is still stamped, because nothing may make a
   * recording silently worse, and a body cut at the capture limit that reads as
   * a complete one is exactly that. It is also why this is not simply an
   * infinite threshold: the stamp would go with it.
   */
  if (limits?.summarise === false) {
    if (!meta?.truncated) return bodyStr;
    const cut = ((meta.bytes ?? bodyStr.length) / 1024).toFixed(1);
    return `${bodyStr}\n\n[${cut}KB total, truncated at capture]`;
  }

  if (!meta?.truncated && bodyStr.length <= threshold) return bodyStr;

  /*
   * A failed call's body is kept, not summarised. Truncation is still stamped
   * rather than silent — the same rule the rest of this file follows — so a
   * stack trace cut at the limit cannot read as one that ended there.
   */
  if (meta?.diagnostic) {
    const size = ((meta.bytes ?? bodyStr.length) / 1024).toFixed(1);
    if (bodyStr.length <= DIAGNOSTIC_LIMIT) {
      return meta.truncated ? `${bodyStr}\n\n[${size}KB total, truncated at capture]` : bodyStr;
    }
    return `${bodyStr.slice(0, DIAGNOSTIC_LIMIT)}\n\n[${size}KB total, truncated]`;
  }

  // The size the caller cares about is the body the server sent, not the slice
  // that survived capture.
  const size = ((meta?.bytes ?? bodyStr.length) / 1024).toFixed(1);
  const trimmed = bodyStr.trim();
  const looksJson = trimmed.startsWith('{') || trimmed.startsWith('[');

  if (looksJson) {
    try {
      return `[schema — ${size}KB raw]\n${buildSchema(JSON.parse(trimmed))}`;
    } catch {
      // Cut mid-structure rather than malformed: repair the prefix and read the
      // shape off that. This is why the flag matters — the parse fails either
      // way, and only the flag says which failure it is.
      if (meta?.truncated) {
        const repaired = repairJson(trimmed);
        if (repaired) {
          try {
            return `[schema — ${size}KB raw, body truncated at capture]\n${buildSchema(JSON.parse(repaired))}`;
          } catch {
            // The repair did not produce readable JSON either; fall through.
          }
        }
        return `${trimmed.slice(0, 300)}\n\n[JSON · ${size}KB · truncated at capture, shape unreadable]`;
      }
    }
  }

  return `${trimmed.slice(0, 300)}\n\n[non-JSON · ${size}KB · truncated]`;
}
