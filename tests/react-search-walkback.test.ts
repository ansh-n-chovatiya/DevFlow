/**
 * Where a body-needle hit is reported.
 *
 * The head needle puts the position exactly at the function's start, so it never
 * had this problem. The body needle is reached only when the bundler renamed the
 * function — and the old code walked back from the hit by the offset the needle
 * had in the *runtime* source, which is the one number a rename is guaranteed to
 * change. Shortening `function Cart(` to `function n(` moved the reported
 * position before the function began, and in a minified bundle the characters
 * before a module are the end of the previous one: the source map then answered
 * truthfully about the wrong file, `status: 'resolved'`, no caveat.
 *
 * The stakes are the whole feature. A step that names no file costs a reader a
 * search; a step that names `src/Helper.ts` for a click in `src/Cart.tsx` costs
 * them the time it takes to work out the tool is lying.
 */
import { describe, expect, it } from 'vitest';
import { buildNeedle } from '../src/core/react/needle.js';
import { searchBundle } from '../src/core/react/search.js';

/** As `fn.toString()` returns it in the page, before any bundler touched it. */
const RUNTIME = 'function Cart(props){ return renderCartRow(props); }';

function needleFor(source: string) {
  const built = buildNeedle(source);
  if (!built.ok) throw new Error(`fixture rejected: ${built.reason}`);
  return built.needle;
}

describe('searchBundle, when only the body needle can hit', () => {
  it('reports a position inside the renamed function, not before it', () => {
    const needle = needleFor(RUNTIME);
    expect(needle.body).toBeDefined();

    // Two modules concatenated, as a bundler emits them. The second is `Cart`,
    // renamed — which is why the head misses and the body is reached at all.
    const previousModule = 'function a(e){return e+1}';
    const cart = 'function n(props){ return renderCartRow(props); }';
    const bundle = `${previousModule}${cart}`;

    const found = searchBundle(bundle, needle);

    expect(found?.needleText).toBe(needle.body);
    // The old `at - bodyOffset` landed at column 22, four characters inside the
    // module before it, and every source map in the world maps that to
    // `src/Helper.ts`.
    expect(found?.column).toBe(previousModule.length);
  });

  it('never reports a position before the hit, even with nothing to scan back to', () => {
    // A class or object method — `render(props){…}` — opens with neither
    // `function` nor `=>`, so there is no token to find. The hit itself is then
    // the answer: a position in the middle of the component, which costs a few
    // lines of precision and keeps the file right. Subtracting an offset here is
    // what produced the wrong file.
    const needle = needleFor('renderCartRow(props){ return props.items.map(toRow); }');
    expect(needle.body).toBeDefined();

    // Renamed, like every other body-needle case, so the walk-back distance is
    // wrong; and with no keyword to scan back to there is nothing to correct it.
    const previousModule = 'var x=1;'.repeat(20);
    const bundle = `${previousModule}r(props){ return props.items.map(toRow); }`;

    const found = searchBundle(bundle, needle);
    expect(found?.column).toBeGreaterThanOrEqual(previousModule.length);
  });

  it('walks back past a longer name, which is the other direction of the same bug', () => {
    // A bundler that inlines can make the prefix *longer* as easily as shorter.
    // Either way the offset from the runtime source is the wrong distance.
    const needle = needleFor(RUNTIME);
    const renamed = 'function CartRowRenderer(props){ return renderCartRow(props); }';
    const bundle = `var pad=0;${renamed}`;

    const found = searchBundle(bundle, needle);
    expect(found?.column).toBe('var pad=0;'.length);
  });

  it('still puts a head hit exactly at the start, which never needed a walk-back', () => {
    const bundle = `var x=1;\n${RUNTIME}\n`;
    const found = searchBundle(bundle, needleFor(RUNTIME));

    expect(found).toMatchObject({ line: 1, column: 0, matchCount: 1 });
    expect(found?.needleText).toBe(needleFor(RUNTIME).head);
  });
});
