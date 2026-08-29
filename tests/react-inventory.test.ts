import { describe, expect, it } from 'vitest';
import {
  inventoryKey,
  isLikelyScript,
  isSearchableUrl,
  mergeScripts,
  scriptsForPage,
} from '../src/features/react/inventory.js';

const PAGE = 'https://shop.test/products/42';
const APP = 'https://shop.test/assets/app.js';
const CHUNK = 'https://cdn.test/chunk-8f2a.js';

describe('isLikelyScript', () => {
  it('accepts the JavaScript extensions and extensionless bundle paths', () => {
    expect(isLikelyScript('https://a.test/app.js')).toBe(true);
    expect(isLikelyScript('https://a.test/app.mjs')).toBe(true);
    // Next.js and friends serve bundles from paths with no extension at all.
    expect(isLikelyScript('https://a.test/_next/static/chunk')).toBe(true);
  });

  it('rejects assets, so no bundle search ever runs over decoded PNG bytes', () => {
    expect(isLikelyScript('https://a.test/logo.png')).toBe(false);
    expect(isLikelyScript('https://a.test/font.woff2')).toBe(false);
    expect(isLikelyScript('https://a.test/styles.css')).toBe(false);
  });

  it('rejects a URL it cannot even parse', () => {
    expect(isLikelyScript('not a url')).toBe(false);
  });
});

describe('isSearchableUrl', () => {
  it('takes only what the worker can actually re-fetch', () => {
    expect(isSearchableUrl('https://a.test/app.js')).toBe(true);
    expect(isSearchableUrl('http://a.test/app.js')).toBe(true);
    // The worker has no access to the page's blob registry, and another
    // extension's scripts are not this page's code.
    expect(isSearchableUrl('blob:https://a.test/1234')).toBe(false);
    expect(isSearchableUrl('data:text/javascript,void 0')).toBe(false);
    expect(isSearchableUrl('chrome-extension://abc/content.js')).toBe(false);
  });
});

describe('mergeScripts', () => {
  it('files scripts under the origin, so an SPA route change does not lose them', () => {
    const first = mergeScripts({}, PAGE, [APP]);
    // Same document, different URL — `pushState`, not a new page.
    const second = mergeScripts(first.scripts, 'https://shop.test/cart', [CHUNK]);

    expect(second.changed).toBe(true);
    expect(scriptsForPage(second.scripts, PAGE)).toEqual([APP, CHUNK]);
  });

  it('keeps load order and drops duplicates', () => {
    const first = mergeScripts({}, PAGE, [APP, CHUNK]);
    const second = mergeScripts(first.scripts, PAGE, [CHUNK, APP]);

    expect(second.changed).toBe(false);
    expect(second.scripts).toBe(first.scripts);
    expect(scriptsForPage(second.scripts, PAGE)).toEqual([APP, CHUNK]);
  });

  it('filters out everything that is not a fetchable script', () => {
    const result = mergeScripts({}, PAGE, [
      'https://shop.test/logo.png',
      'blob:https://shop.test/1234',
      APP,
    ]);

    expect(scriptsForPage(result.scripts, PAGE)).toEqual([APP]);
  });

  it('keeps origins apart', () => {
    const merged = mergeScripts(mergeScripts({}, PAGE, [APP]).scripts, 'https://other.test/', [
      CHUNK,
    ]);

    expect(scriptsForPage(merged.scripts, PAGE)).toEqual([APP]);
    expect(scriptsForPage(merged.scripts, 'https://other.test/x')).toEqual([CHUNK]);
  });

  it('stops at the cap rather than growing without limit', () => {
    const many = Array.from({ length: 10 }, (_, i) => `https://shop.test/c${i}.js`);
    const result = mergeScripts({}, PAGE, many, 4);

    expect(scriptsForPage(result.scripts, PAGE)).toHaveLength(4);
  });

  it('ignores a page URL it cannot parse instead of filing under an empty key', () => {
    const result = mergeScripts({}, 'about:blank', [APP]);
    expect(result.changed).toBe(false);
    expect(result.scripts).toEqual({});
  });

  it('does not mutate the inventory it was given', () => {
    const before = { 'https://shop.test': [APP] };
    const after = mergeScripts(before, PAGE, [CHUNK]);

    expect(before['https://shop.test']).toEqual([APP]);
    expect(after.scripts['https://shop.test']).toEqual([APP, CHUNK]);
  });
});

describe('inventoryKey', () => {
  it('is the origin, and empty for anything unparseable', () => {
    expect(inventoryKey(PAGE)).toBe('https://shop.test');
    expect(inventoryKey('nonsense')).toBe('');
  });
});

describe('scriptsForPage', () => {
  it('is empty rather than undefined for a page nothing was seen on', () => {
    expect(scriptsForPage({}, PAGE)).toEqual([]);
  });
});
