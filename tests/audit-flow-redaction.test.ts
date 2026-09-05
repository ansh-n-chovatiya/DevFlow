/**
 * The redactor's misses, each one a credential that reached a recording.
 *
 * Every case here was reproduced against the shipped code before it was fixed:
 * a URL the redactor could not parse, a URL it parsed and then rebuilt wrongly,
 * a fragment it read as one query when it was a route carrying one, and a
 * percent sign that made it throw inside the page's own `fetch`.
 */

import { describe, expect, it } from 'vitest';
import { credentialParams, redactUrl } from '../src/core/redact/index.js';
import { snapshot } from '../src/core/state/snapshot.js';
import { applyPatch, diff } from '../src/core/state/patch.js';

const budget = { maxDepth: 6, maxKeys: 40, maxEntries: 40, stringCap: 200 };

describe('a URL with no origin in front of it', () => {
  /*
   * `patchedFetch` redacts whatever the application handed `fetch`, and an
   * application hands it `/api/…` far more often than an absolute URL. Those
   * went through `new URL`, threw, and were returned untouched.
   */
  it('masks a grant in a relative request URL', () => {
    expect(redactUrl('/api/session?access_token=ya29.a0AfH6SM')).toBe(
      '/api/session?access_token=[redacted]',
    );
  });

  it('masks a protocol-relative one too', () => {
    expect(redactUrl('//api.example.com/me?api_key=k9')).toBe(
      '//api.example.com/me?api_key=[redacted]',
    );
  });

  it('leaves a relative URL with nothing to hide byte for byte', () => {
    expect(redactUrl('/api/orders?page=2&sort=desc')).toBe('/api/orders?page=2&sort=desc');
  });

  it('warns about one as well, so the dialog and the redactor agree', () => {
    expect(credentialParams('/api/session?access_token=ya29')).toEqual(['access_token']);
  });
});

describe('a fragment that is a route carrying a query', () => {
  it('masks the grant a hash router put after the question mark', () => {
    expect(redactUrl('https://app.example.com/#/callback?code=4/0AY0e-g7&state=xyz')).toBe(
      'https://app.example.com/#/callback?code=[redacted]&state=xyz',
    );
  });

  it('still leaves a plain route alone', () => {
    const url = 'https://app.example.com/dashboard#/orders/42';
    expect(redactUrl(url)).toBe(url);
  });

  it('warns about the grant in a hash route', () => {
    expect(credentialParams('https://app.example.com/#/cb?code=abc')).toEqual(['code']);
  });
});

describe('a URL whose origin is opaque', () => {
  /*
   * `origin` is the string `"null"` for a `file:` URL, and the rebuild pasted
   * it in front of the path: the step said it happened at `null/report.html`.
   */
  it('keeps the path of a file: URL while masking the grant', () => {
    expect(redactUrl('file:///Users/ada/report.html?token=abc')).toBe(
      'file:///Users/ada/report.html?token=[redacted]',
    );
  });
});

describe('a malformed percent escape', () => {
  /*
   * `decodeURIComponent('%zz')` throws, and this runs inside the page's own
   * `fetch` — so the application's request failed along with the redaction.
   */
  it('does not throw, and still masks what it recognises', () => {
    expect(redactUrl('https://x/y?100%=one&access_token=SECRET')).toBe(
      'https://x/y?100%=one&access_token=[redacted]',
    );
  });

  it('does not throw while reporting either', () => {
    expect(credentialParams('https://x/y?100%=one&code=SECRET')).toEqual(['code']);
  });
});

describe('a password in the authority', () => {
  it('masks it and keeps the rest of the URL readable', () => {
    expect(redactUrl('https://ada:hunter2@app.example.com/orders?page=2')).toBe(
      'https://ada:[redacted]@app.example.com/orders?page=2',
    );
  });

  it('leaves a bare username, which is not a secret', () => {
    const url = 'https://ada@app.example.com/orders';
    expect(redactUrl(url)).toBe(url);
  });
});

describe('a store key named __proto__', () => {
  /*
   * `JSON.parse('{"__proto__":…}')` produces an own property, so an app storing
   * a parsed response can hold one. `out[key] = value` for that name runs
   * `Object.prototype`'s setter instead of writing a property: the key vanished
   * from the snapshot and the copy's prototype became the page's value.
   */
  it('is snapshotted as data rather than replacing the copy prototype', () => {
    // Built by `JSON.parse`, which is how an app comes to hold one: an object
    // literal spelling `__proto__` sets a prototype rather than a property.
    const store = JSON.parse('{"__proto__":{"admin":true},"user":"ada"}') as unknown;
    const { value } = snapshot(store, budget);
    const out = value as Record<string, unknown>;

    expect(Object.keys(out).sort()).toEqual(['__proto__', 'user']);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(JSON.parse(JSON.stringify(out)).__proto__).toEqual({ admin: true });
  });

  it('is masked like any other key when it looks like a secret', () => {
    const { value } = snapshot(JSON.parse('{"__proto__":{"x":1},"token":"t"}'), {
      ...budget,
      secretKey: (key) => key === 'token',
    });
    expect((value as Record<string, unknown>).token).toBe('[redacted]');
  });

  it('survives a patch round trip instead of moving a prototype', () => {
    const before = JSON.parse('{"__proto__":{"admin":false}}') as unknown;
    const after = JSON.parse('{"__proto__":{"admin":true}}') as unknown;

    const applied = applyPatch(before, diff(before, after, { maxOps: 20 }).ops) as object;
    expect(JSON.stringify(applied)).toBe('{"__proto__":{"admin":true}}');
    expect(Object.getPrototypeOf(applied)).toBe(Object.prototype);
    expect(({} as { admin?: boolean }).admin).toBeUndefined();
  });
});
