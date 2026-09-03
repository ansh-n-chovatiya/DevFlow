import { describe, expect, it } from 'vitest';
import { buildNeedle, needleRejection } from '../src/core/locate/needle.js';
import { MAX_FN_SOURCE_LEN, NEEDLE_BODY_LEN, NEEDLE_HEAD_LEN } from '../src/shared/constants.js';

describe('needleRejection', () => {
  /*
   * The two refusals are different facts and the caller says different things
   * about them, which is why this is a named answer rather than an empty
   * result. `[native code]` appears in no bundle at all, so searching every
   * script for it spends a full pass to report "not found" — which reads like a
   * bug in the search rather than a fact about the function.
   */
  it('names native code as the reason, not length', () => {
    expect(needleRejection('function bound Widget() { [native code] }')).toBe('native');
  });

  it('names length for a source too short to identify anything', () => {
    expect(needleRejection('()=>1')).toBe('too-short');
  });

  it('passes an ordinary component source', () => {
    expect(needleRejection('function Widget(props){return null}')).toBeNull();
  });
});

describe('buildNeedle', () => {
  it('carries the rejection with the refusal, so the caller needs no second call', () => {
    const source = 'function bound Widget() { [native code] }';
    const result = buildNeedle(source);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(needleRejection(source));
  });

  it('anchors the head at offset 0, so a hit on it is the function start', () => {
    const source = 'function Widget(props){return createElement("div",null,props.children)}';
    const result = buildNeedle(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(source.indexOf(result.needle.head)).toBe(0);
  });

  it('places the body needle exactly at bodyOffset, or hit positions skew', () => {
    const source = 'function Widget(props){return createElement("div",null,props.children)}';
    const result = buildNeedle(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const { body, bodyOffset } = result.needle;
    expect(body).toBeDefined();
    expect(source.slice(bodyOffset, bodyOffset! + body!.length)).toBe(body);
  });

  it('takes the head of the source verbatim, so it matches the bundle byte for byte', () => {
    const source = `function Cart(){${'x'.repeat(500)}}`;
    const result = buildNeedle(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needle.head).toBe(source.slice(0, NEEDLE_HEAD_LEN));
    expect(source.indexOf(result.needle.head)).toBe(0);
  });

  it('adds a body needle that survives the bundler renaming the function', () => {
    const source = `function Cart(){${'abcdefgh'.repeat(60)}}`;
    const result = buildNeedle(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needle.body).toBeDefined();
    expect(result.needle.body).toHaveLength(NEEDLE_BODY_LEN);
    // The offset is what lets a hit be walked back to the function's real start.
    expect(source.slice(result.needle.bodyOffset)).toContain(result.needle.body!);
  });

  it('rejects a bound or native function rather than scanning every bundle for it', () => {
    const result = buildNeedle('function Cart() { [native code] }');
    expect(result).toEqual({ ok: false, reason: 'native' });
  });

  it('rejects a source too short to match anything but noise', () => {
    expect(buildNeedle('()=>1')).toEqual({ ok: false, reason: 'too-short' });
  });

  it('caps a pathological source instead of carrying it around whole', () => {
    const source = `function Big(){${'y'.repeat(MAX_FN_SOURCE_LEN * 2)}}`;
    const result = buildNeedle(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.needle.head.length).toBeLessThanOrEqual(NEEDLE_HEAD_LEN);
  });

  it('omits the body needle when it would duplicate the head', () => {
    const result = buildNeedle('function Ab(){return 1}');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    if (result.needle.body) expect(result.needle.body).not.toBe(result.needle.head);
  });
});
