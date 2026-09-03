/**
 * Search needles: the slices of a component's compiled source that are looked
 * for in the page's bundles to find where it was defined.
 *
 * The one needle builder. Both extensions had one; this is the recorder's shape
 * with the panel's `needleRejection` folded back in, because a rejection is a
 * *result*, not a silence. The panel's copy returned an empty array of needles
 * and made the caller ask a second function why; this returns the reason with
 * the refusal, so the sentence a component carries in place of a path — "this is
 * a bound or native function, its source appears in no bundle" — is built from
 * the same value that caused it.
 *
 * The panel also built its needles as a flat `Needle[]` that its search loop
 * walked in order. That array is gone rather than kept beside this: head and
 * body are not two interchangeable needles, they are a specific needle and its
 * rename-proof fallback, and `searchBundle` has to know which one hit to know
 * whether the position it reports is the function's start or the middle of it.
 * Two shapes for one concept is what this package deletes.
 *
 * `Function.prototype.toString` returns the exact source text of the loaded
 * code, so a needle taken from it matches the bundle it came from byte for byte
 * — which is what makes any of this work on a minified build.
 *
 * Pure — no DOM, no Chrome. Runs in the page on the click path, so it does no
 * more than slice.
 */

import {
  MIN_NEEDLE_LEN,
  NEEDLE_BODY_LEN,
  NEEDLE_HEAD_LEN,
  MAX_FN_SOURCE_LEN,
} from '../../shared/constants.js';

export interface Needle {
  /** Highly specific, but lost if the bundler renamed the function. */
  head: string;
  /** Survives renaming. Absent when the source is too short to spare a slice. */
  body?: string;
  /** Where `body` sits inside the source, so a hit can be walked back to the start. */
  bodyOffset?: number;
}

/**
 * Why a source yielded no needle. Carried through to the component's status so
 * a flow says *why* a file is missing instead of leaving a blank.
 */
export type NeedleRejection = 'native' | 'too-short';

export type NeedleResult = { ok: true; needle: Needle } | { ok: false; reason: NeedleRejection };

/**
 * Whether a source can be searched for at all, and if not, why.
 *
 * Exported rather than inlined into `buildNeedle` because both answers have to
 * be reachable before a search is started: `[native code]` is a bound or native
 * function whose source exists in no bundle, so scanning every script for it
 * spends a full pass to report "not found", which reads like a bug in the search
 * rather than a fact about the function.
 */
export function needleRejection(fnSource: string): NeedleRejection | null {
  if (fnSource.includes('[native code]')) return 'native';
  // Below this, false positives dominate and a match means nothing.
  if (fnSource.length < MIN_NEEDLE_LEN) return 'too-short';
  return null;
}

/** Builds the head and body needles for one component's source, or says why not. */
export function buildNeedle(fnSource: string): NeedleResult {
  const rejection = needleRejection(fnSource);
  if (rejection) return { ok: false, reason: rejection };

  // A pathological source (a giant inlined data table) would otherwise be
  // carried around whole; the head is all the specificity we need anyway.
  const source = fnSource.length > MAX_FN_SOURCE_LEN ? fnSource.slice(0, MAX_FN_SOURCE_LEN) : fnSource;

  const head = source.slice(0, Math.min(source.length, NEEDLE_HEAD_LEN));

  const bodyOffset = Math.min(NEEDLE_HEAD_LEN / 4, Math.floor(source.length / 3));
  const body = source.slice(bodyOffset, bodyOffset + NEEDLE_BODY_LEN);

  const needle: Needle = { head };
  if (bodyOffset > 0 && body !== head && body.length >= MIN_NEEDLE_LEN) {
    needle.body = body;
    needle.bodyOffset = bodyOffset;
  }

  return { ok: true, needle };
}
