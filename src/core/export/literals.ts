/**
 * Recorded page text, turned into literals a generated script can safely hold.
 *
 * Everything a compiled test interpolates — a typed value, an aria-label, a URL,
 * a response body — is text the recorded page chose, and the compiler pastes it
 * into JavaScript source. Each of the three generators used to carry its own
 * `str.replace(/'/g, "\\'").replace(/\n/g, ' ')`, which leaves the backslash
 * alone: a value ending in one compiled to `'foo\'`, escaping the closing quote,
 * so the rest of the page's content ran on as code. That escaper also missed
 * `\r`, `\t` and U+2028/U+2029, each of which ends a string literal on its own.
 * One copy of each escaper lives here so the fix cannot be half-applied.
 *
 * The rule they all obey: escape the backslash first, or every escape added
 * after it is itself escapable by the page.
 */

/**
 * The two characters that are ordinary text in JSON and a line break in
 * JavaScript — invisible to whoever reads the generated file either way.
 */
const LINE_SEPARATOR = 0x2028;
const PARAGRAPH_SEPARATOR = 0x2029;

const SEPARATORS = new RegExp(
  `[${String.fromCharCode(LINE_SEPARATOR, PARAGRAPH_SEPARATOR)}]`,
  'g',
);

/**
 * Characters that cannot stand as themselves inside a string literal.
 *
 * `\n`, `\r` and `\t` are spelled out by their callers, so what reaches here is
 * the unprintable remainder — a NUL or a vertical tab out of a response body —
 * plus the two separators above.
 */
function needsEscape(code: number): boolean {
  return code < 0x20 || code === 0x7f || code === LINE_SEPARATOR || code === PARAGRAPH_SEPARATOR;
}

function unicodeEscape(code: number): string {
  return `\\u${code.toString(16).padStart(4, '0')}`;
}

/**
 * A single-quoted JavaScript string literal, quotes included.
 *
 * Quotes included rather than the body returned bare, because a caller that has
 * to add them is a caller that can forget to — and the whole class of bug this
 * module exists for is a quote that did not close where the reader thought.
 */
export function jsLiteral(value: string): string {
  let body = '';

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;

    if (char === '\\') body += '\\\\';
    else if (char === "'") body += "\\'";
    else if (char === '\n') body += '\\n';
    else if (char === '\r') body += '\\r';
    else if (char === '\t') body += '\\t';
    else if (needsEscape(code)) body += unicodeEscape(code);
    else body += char;
  }

  return `'${body}'`;
}

/**
 * The inside of a double-quoted CSS string, for an attribute selector.
 *
 * Escaped for CSS only — the result is still a plain JavaScript string, and the
 * caller passes the selector it is built into back through `jsLiteral`.
 * Composing the two in that order is what makes a label holding both `"` and
 * `\` come out right: the CSS pass doubles its own backslashes, the JS pass
 * doubles those again, and the page reaches neither parser as syntax.
 */
export function cssString(value: string): string {
  return (
    value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      // CSS spells a line break inside a string as a hex escape, and a hex
      // escape is terminated by a space. Dropping the character instead would
      // silently change which elements the selector matches.
      .replace(/\n/g, '\\a ')
      .replace(/\r/g, '\\d ')
      .replace(/\t/g, '\\9 ')
  );
}

const REGEX_META = /[\\^$.*+?()[\]{}|/]/;

/**
 * A regular-expression literal matching exactly one URL and nothing else.
 *
 * Cypress glob-matches an `intercept` url given as a string, so a recorded URL
 * carrying `?`, `*` or `[` — which is to say most recorded URLs — is read as a
 * pattern and quietly matches nothing. An anchored literal has no pattern
 * syntax left in it to be read the wrong way.
 */
export function exactUrlRegex(url: string): string {
  let body = '';

  for (const char of url) {
    const code = char.codePointAt(0) ?? 0;

    if (char === '\n') body += '\\n';
    else if (char === '\r') body += '\\r';
    else if (char === '\t') body += '\\t';
    else if (needsEscape(code)) body += unicodeEscape(code);
    else if (REGEX_META.test(char)) body += `\\${char}`;
    else body += char;
  }

  return `/^${body}$/`;
}

/**
 * `JSON.stringify`, hardened for pasting into source.
 *
 * It emits U+2028 and U+2029 raw, because they are ordinary characters in JSON.
 * In a JS file they are line terminators, and a response body carrying one used
 * to end the literal it was sitting inside.
 */
export function jsonLiteral(value: unknown): string {
  return JSON.stringify(value).replace(SEPARATORS, (char) => unicodeEscape(char.charCodeAt(0)));
}

/**
 * Text safe to put after `//`.
 *
 * A comment ends at the first line terminator, so an action sentence or a note
 * carrying a newline does not produce an ugly comment — it produces whatever
 * followed the newline, evaluated as code.
 */
export function commentText(value: string): string {
  let out = '';

  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    out += needsEscape(code) || char === '\t' ? ' ' : char;
  }

  return out.replace(/ {2,}/g, ' ').trim();
}
