/**
 * A result that carries its failure instead of throwing it.
 *
 * Every function in `src/chrome/` returns one of these. Chrome's APIs report
 * failure through `chrome.runtime.lastError`, which is only readable inside the
 * callback and silently vanishes if nobody looks at it — the original code read
 * it exactly once in 2,900 lines, so quota failures and closed tabs were
 * invisible. Making the failure part of the return type means a caller has to
 * decide what to do about it.
 */

import type { FlowError } from './errors.js';

export type Result<T, E = FlowError> = { ok: true; value: T } | { ok: false; error: E };

export function ok(): Result<void>;
export function ok<T>(value: T): Result<T>;
export function ok<T>(value?: T): Result<T | undefined> {
  return { ok: true, value };
}

export function err<T = never>(error: FlowError): Result<T> {
  return { ok: false, error };
}
