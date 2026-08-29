/**
 * Search needles: the slices of a component's compiled source that are looked
 * for in the page's bundles to find where it was defined.
 *
 * Ported from react-source-locator `src/core/bundle-search.ts` @ 314488d
 * (`buildNeedles`), with the rejection rules below added — upstream builds a
 * needle from anything long enough, which quietly wastes a full bundle scan on
 * sources that cannot possibly match.
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
 * the flow says *why* a file is missing instead of leaving a blank.
 */
export type NeedleRejection = 'native' | 'too-short';

export type NeedleResult = { ok: true; needle: Needle } | { ok: false; reason: NeedleRejection };

/**
 * Builds needles from `fn.toString()`.
 *
 * `Function.prototype.toString` returns the exact source text of the loaded
 * code, so a needle taken from it matches the bundle it came from byte for byte
 * — which is what makes this work on minified builds at all.
 */
export function buildNeedle(fnSource: string): NeedleResult {
  // A bound or native function's source exists in no bundle. Upstream scans for
  // it anyway and reports "not found", which reads like a bug in the search.
  if (fnSource.includes('[native code]')) return { ok: false, reason: 'native' };

  // Below this, false positives dominate and a match means nothing.
  if (fnSource.length < MIN_NEEDLE_LEN) return { ok: false, reason: 'too-short' };

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
