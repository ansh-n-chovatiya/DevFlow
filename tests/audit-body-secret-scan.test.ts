/**
 * `report.md` §2 finding 2 / §3.2: bodies were never scanned for secret
 * content — a success body under `SCHEMA_THRESHOLD` and a failed-call body
 * under `DIAGNOSTIC_LIMIT` both passed through `compactBody` byte for byte,
 * live-verified against the built bundle with real token payloads. Both
 * branches now run `redactSecretShapes` before returning a body verbatim.
 */

import { describe, expect, it } from 'vitest';
import { redactSecretShapes } from '../src/core/redact/index.js';
import { compactBody } from '../src/core/schema/index.js';

describe('redactSecretShapes', () => {
  it('masks a JWT wherever it appears', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    expect(redactSecretShapes(`{"id_token":"${jwt}"}`)).not.toContain(jwt);
  });

  it('masks a bearer token', () => {
    expect(redactSecretShapes('Authorization failed for Bearer sk_live_abcdef1234567890')).not.toContain(
      'sk_live_abcdef1234567890',
    );
  });

  it('masks a long value behind a key/token/secret-shaped field name', () => {
    const out = redactSecretShapes('{"session_token":"sTok_live_9f8e7d6c5b4a3210"}');
    expect(out).not.toContain('sTok_live_9f8e7d6c5b4a3210');
    expect(out).toContain('[redacted]');
  });

  it('leaves an ordinary body with no secret-shaped content unchanged', () => {
    const body = '{"order_id":"a1b2c3d4-5678-90ab-cdef-1234567890ab","status":"shipped","total":42}';
    expect(redactSecretShapes(body)).toBe(body);
  });

  it('leaves a short field value alone even when the name says token', () => {
    // A 6-character value is a flag, not a credential — the 8-char floor
    // exists precisely so this is not masked away.
    const body = '{"token_type":"Bearer"}';
    expect(redactSecretShapes(body)).toBe(body);
  });
});

describe('compactBody redacts secret-shaped content it would otherwise pass through verbatim', () => {
  it('redacts a success body under SCHEMA_THRESHOLD (≤1KB)', () => {
    const body = '{"session_token":"sTok_live_9f8e7d6c5b4a3210"}';
    const out = compactBody(body);
    expect(out).not.toContain('sTok_live_9f8e7d6c5b4a3210');
  });

  it('redacts a failed-call body under DIAGNOSTIC_LIMIT (≤4KB)', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U';
    const body = `{"attempted_token":"Bearer ${jwt}"}`;
    const out = compactBody(body, { diagnostic: true });
    expect(out).not.toContain(jwt);
    expect(out).not.toContain(`Bearer ${jwt}`);
  });

  it('leaves an ordinary success body unchanged content-wise', () => {
    const body = '{"order_id":"a1b2c3d4-5678-90ab-cdef-1234567890ab","status":"shipped"}';
    expect(compactBody(body)).toBe(body);
  });

  it('leaves an ordinary failed-call body unchanged content-wise', () => {
    const body = '{"error":"Cannot read property \'id\' of undefined"}';
    expect(compactBody(body, { diagnostic: true })).toBe(body);
  });
});
