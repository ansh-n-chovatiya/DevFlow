/**
 * What one picked component is worth recording in the graph.
 *
 * The extension's half of the ARKG pick path, which had no test of its own —
 * `arkg-ingest.test.ts` and `arkg.test.ts` both drive a spawned server and start
 * from an observation that has already been built. This is the fold above them,
 * and it is where a source can be lost silently: an observation with a name and
 * no file is a valid observation, so dropping the file fails nothing downstream
 * and simply leaves the graph never learning where a component lives.
 */

import { describe, expect, it } from 'vitest';
import { observationFor } from '../src/features/arkg/ingest.js';
import { pos1 } from '../src/core/react/positions.js';

describe('observationFor', () => {
  it('records a name alone when nothing knows where the component lives', () => {
    expect(observationFor({ name: 'CartButton' })).toEqual({ name: 'CartButton' });
  });

  it('records the JSX position React left on the fiber', () => {
    expect(
      observationFor({
        name: 'CartButton',
        debugSource: { source: 'src/Cart.tsx', line: pos1(12), column: pos1(3) },
      }),
    ).toEqual({ name: 'CartButton', sourceFile: 'src/Cart.tsx', sourceLine: 12 });
  });

  /*
   * The stamp first, matching `table.ts` and `locate.ts`. Without it a build
   * that has a stamp and no `_debugSource` — which is every React 19
   * development build using the plugin — files every pick under a name with no
   * file, and the graph's `maps_to` edge is never drawn.
   */
  it('prefers the build stamp, which names the component’s own file', () => {
    expect(
      observationFor({
        name: 'CartButton',
        stamp: { source: 'src/Cart.tsx', line: pos1(12) },
        debugSource: { source: 'src/App.tsx', line: pos1(40), column: pos1(6) },
      }),
    ).toEqual({ name: 'CartButton', sourceFile: 'src/Cart.tsx', sourceLine: 12 });
  });

  /*
   * File and line are read as a pair. Taking the name of the file from one
   * source and the line from the other would file a real line number under a
   * file it is not in — a wrong answer that reads exactly like a right one.
   */
  it('never mixes a line from one source with a file from the other', () => {
    const mixed = observationFor({
      name: 'CartButton',
      stamp: { source: 'src/Cart.tsx', line: pos1(12) },
      debugSource: { source: 'src/App.tsx', line: pos1(40), column: pos1(6) },
    });

    expect(mixed?.sourceLine).toBe(12);
    expect(mixed?.sourceLine).not.toBe(40);
  });

  it('refuses a component with no usable name, which the graph would key on nothing', () => {
    expect(observationFor({ name: '' })).toBeNull();
    expect(observationFor({ name: '   ' })).toBeNull();
  });
});
