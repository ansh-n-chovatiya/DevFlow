/**
 * Blanking out comments, for the gates that grep source.
 *
 * One copy, because two would drift and the whole point of it is subtlety:
 * `check-brand.mjs` reached this shape after a regex version that had a false
 * *negative*, and `check-settings-ui.mjs` was still carrying that regex —
 * `line.replace(/\/\/.*$/, '')` — so `const url = 'https://x'; node.className =
 * 'row';` had everything after `https:` deleted and the breach on the same line
 * went unreported. A gate with a hole in it is worse than no gate, and the hole
 * was the copy.
 */

/**
 * The file with comments blanked out, newlines and offsets preserved.
 *
 * Character-wise rather than regex, because the regex version has a false
 * *negative*: `'https://x/DevFlow'` is a string containing `//`, and stripping
 * from the first `//` to end of line would delete the violation instead of
 * reporting it. Comment characters become spaces so the line numbers this
 * prints are the line numbers in the editor.
 *
 * An unterminated `'` or `"` is a syntax error in every language here, so both
 * reset at a newline: a regex literal like `/["']/` that fools the scanner then
 * costs one line of accuracy instead of the rest of the file.
 */
export function stripComments(text, html) {
  const out = Array.from(text);
  let i = 0;
  let quote = null;

  const blank = (from, to) => {
    for (let j = from; j < to && j < out.length; j++) {
      if (out[j] !== '\n') out[j] = ' ';
    }
  };

  while (i < out.length) {
    const c = text[i];

    if (quote) {
      if (c === '\\') {
        i += 2;
      } else {
        if (c === quote || (c === '\n' && quote !== '`')) quote = null;
        i++;
      }
      continue;
    }

    if (c === "'" || c === '"' || c === '`') {
      quote = c;
      i++;
      continue;
    }

    if (html && text.startsWith('<!--', i)) {
      const end = text.indexOf('-->', i + 4);
      const stop = end === -1 ? out.length : end + 3;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (!html && text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? out.length : end + 2;
      blank(i, stop);
      i = stop;
      continue;
    }

    if (!html && text.startsWith('//', i)) {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? out.length : end;
      blank(i, stop);
      i = stop;
      continue;
    }

    i++;
  }

  return out.join('');
}

