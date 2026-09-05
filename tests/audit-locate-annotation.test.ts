/**
 * The two edges an audit of `core/locate/` found, both of them silent.
 *
 * `extractSourceMappingURL` measured its window from the *start* of the
 * annotation, so an inlined `data:` map — one unbroken token tens of kilobytes
 * long — never fitted in it. Every bundle built with `devtool: 'inline-source-map'`
 * or Vite's inline maps therefore came back `compiled-only` ("ships no source
 * map"), and the `data:` branch in both resolvers, along with `decodeDataUrl`
 * itself, was unreachable for any map large enough to be worth having.
 *
 * `buildEditorUrl` passed the path to `String.replace` as the replacement
 * string, where `$&`, `` $` ``, `$'` and `$1` are substitution patterns rather
 * than characters.
 */

import { describe, expect, it } from 'vitest';
import {
  decodeDataUrl,
  extractSourceMappingURL,
  lookupOriginal,
  parseSourceMap,
} from '../src/core/locate/sourcemap.js';
import { buildEditorUrl } from '../src/core/locate/editor.js';
import { pos1 } from '../src/core/locate/positions.js';

/** A map whose base64 payload is longer than the tail window on its own. */
function inlineAnnotation(): { annotation: string; json: string } {
  const json = JSON.stringify({
    version: 3,
    sources: ['src/components/Cart.tsx'],
    names: [],
    // One mapping at generated 0:0 → Cart.tsx 0:0, then padding so the payload
    // comfortably exceeds the 2000-character window.
    mappings: 'AAAA',
    sourcesContent: [`// ${'x'.repeat(4000)}\n`],
  });
  const base64 = Buffer.from(json, 'utf-8').toString('base64');
  return { annotation: `data:application/json;charset=utf-8;base64,${base64}`, json };
}

describe('an inlined source map annotation', () => {
  it('is found even though its payload is longer than the tail window', () => {
    const { annotation } = inlineAnnotation();
    expect(annotation.length).toBeGreaterThan(2000);

    const bundle = `function Cart(){return null}\n//# sourceMappingURL=${annotation}`;
    expect(extractSourceMappingURL(bundle)).toBe(annotation);
  });

  it('decodes to a map that answers a lookup', () => {
    const { annotation, json } = inlineAnnotation();
    const bundle = `function Cart(){return null}\n//# sourceMappingURL=${annotation}`;

    const found = extractSourceMappingURL(bundle);
    expect(found).not.toBeNull();
    expect(found?.startsWith('data:')).toBe(true);

    expect(decodeDataUrl(found as string)).toBe(json);
    const map = parseSourceMap(decodeDataUrl(found as string));
    expect(lookupOriginal(map, 0, 0)?.source).toBe('src/components/Cart.tsx');
  });

  it('still ignores an annotation buried far from the end', () => {
    // The rule did not change: what has to sit near the end is the end of the
    // match, and here 5000 characters of unrelated bundle follow it.
    const bundle = `//# sourceMappingURL=early.map\n${'x'.repeat(5000)}`;
    expect(extractSourceMappingURL(bundle)).toBeNull();
  });

  it('takes the last annotation when a long one follows a short one', () => {
    const { annotation } = inlineAnnotation();
    const bundle = `//# sourceMappingURL=first.map\n//# sourceMappingURL=${annotation}`;
    expect(extractSourceMappingURL(bundle)).toBe(annotation);
  });

  it('is null when the marker appears with no annotation around it', () => {
    expect(extractSourceMappingURL('var sourceMappingURL = 1;')).toBeNull();
  });
});

describe('a path that contains a replacement pattern', () => {
  it('reaches the editor verbatim', () => {
    // `$'` means "everything after the match" to String.replace, so filling the
    // template with the raw string put `:34:3` where the filename belonged.
    const url = buildEditorUrl('vscode://file/{path}:{line1}:{col1}', {
      path: "/repo/src/routes/$'.tsx",
      line: pos1(34),
      column: pos1(3),
    });
    expect(url).toBe("vscode://file//repo/src/routes/$'.tsx:34:3");
  });

  it('leaves `$&` and `$1` alone too', () => {
    expect(
      buildEditorUrl('zed://file/{path}:{line1}:{col1}', {
        path: '/repo/src/$&/$1.tsx',
        line: pos1(1),
        column: pos1(1),
      }),
    ).toBe('zed://file//repo/src/$&/$1.tsx:1:1');
  });
});
