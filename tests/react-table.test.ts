import { describe, expect, it } from 'vitest';
import { CAPPED_ID, isAbsolutePath, mergeComponents } from '../src/core/react/table.js';
import type { CapturedComponent } from '../src/shared/messages.js';
import type { ComponentNeedle, ComponentSource } from '../src/shared/types.js';
import { pos1 } from '../src/core/react/positions.js';

function empty(): { table: Record<string, ComponentSource>; needles: Record<string, ComponentNeedle> } {
  return { table: {}, needles: {} };
}

const withNeedle: CapturedComponent = {
  id: 'abc123',
  name: 'Cart',
  needle: { head: 'function Cart(){return null}' },
};

describe('mergeComponents', () => {
  it('queues a component that has a needle, and stores the needle apart from the table', () => {
    const { table, needles } = empty();
    const result = mergeComponents([withNeedle], 'https://app.test/cart', table, needles);

    expect(result.changed).toBe(true);
    expect(result.table.abc123).toEqual({ name: 'Cart', status: 'pending' });
    expect(result.needles.abc123).toEqual({
      head: 'function Cart(){return null}',
      pageUrl: 'https://app.test/cart',
    });
    // Needles live in their own key so that "needles never ship" is structural.
    expect(result.table.abc123).not.toHaveProperty('head');
  });

  it('answers straight away when React recorded the JSX position itself', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = {
      id: 'dev1',
      name: 'Cart',
      debugSource: { source: 'src/Cart.tsx', line: pos1(19), column: pos1(3) },
    };

    const result = mergeComponents([component], 'https://app.test', table, needles);

    expect(result.table.dev1).toMatchObject({
      status: 'resolved',
      via: 'debug-source',
      source: 'src/Cart.tsx',
      line: 19,
    });
    expect(result.needles).toEqual({});
  });

  /*
   * Precedence, all three ways round: stamp, then `debugSource`, then needle.
   *
   * The order is not "newest first". `_debugSource` is where the JSX element was
   * *written* — a position in the parent's file — and a build stamp is where the
   * component was *defined*, which is what `ComponentSource` has always claimed
   * to be. The stamp is the better match for the contract and `debug-source` is
   * the compromise. `src/ui/locator/locate.ts` uses the same order, and has to:
   * the panel and a recorded flow naming different files for one component is a
   * contradiction whoever reads either cannot resolve.
   */
  it('prefers the build stamp over the JSX position React recorded', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = {
      id: 'both1',
      name: 'Cart',
      stamp: { source: 'src/Cart.tsx', line: pos1(12) },
      debugSource: { source: 'src/App.tsx', line: pos1(40), column: pos1(6) },
      needle: { head: 'function Cart(){return null}' },
    };

    const result = mergeComponents([component], 'https://app.test', table, needles);

    expect(result.table.both1).toEqual({
      name: 'Cart',
      status: 'resolved',
      via: 'plugin',
      source: 'src/Cart.tsx',
      line: 12,
    });
    // The definition, not the parent's JSX call site.
    expect(result.table.both1.source).not.toBe('src/App.tsx');
    expect(result.needles).toEqual({});
  });

  it('prefers the build stamp over a bundle search, and queues no needle', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = {
      id: 'stamp1',
      name: 'Cart',
      stamp: { source: 'src/Cart.tsx', line: pos1(12) },
      needle: { head: 'function Cart(){return null}' },
    };

    const result = mergeComponents([component], 'https://app.test', table, needles);

    expect(result.table.stamp1).toMatchObject({ status: 'resolved', via: 'plugin', line: 12 });
    expect(result.needles).toEqual({});
  });

  it('falls back to the JSX position when there is no stamp', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = {
      id: 'debug1',
      name: 'Cart',
      stamp: null,
      debugSource: { source: 'src/App.tsx', line: pos1(40), column: pos1(6) },
      needle: { head: 'function Cart(){return null}' },
    };

    const result = mergeComponents([component], 'https://app.test', table, needles);

    expect(result.table.debug1).toMatchObject({ via: 'debug-source', source: 'src/App.tsx' });
    expect(result.needles).toEqual({});
  });

  /*
   * The `isPlaceholderId` guard, kept for the stamp too.
   *
   * The hazard it names is one row winning under an id every unnamed component
   * in the flow shares, and where the location came from does not change it.
   * A build stamp under `n_…` would be published as the location of all of them.
   */
  it('refuses a stamp under a placeholder id, exactly as it refuses a JSX position', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = {
      id: 'n_deadbeef',
      name: 'Lazy(loading…)',
      stamp: { source: 'src/Cart.tsx', line: pos1(12) },
    };

    const result = mergeComponents([component], 'https://app.test', table, needles);

    expect(result.table.n_deadbeef.status).toBe('not-found');
    expect(result.table.n_deadbeef.source).toBeUndefined();
    expect(result.table.n_deadbeef.via).toBeUndefined();
  });

  it('keeps an absolute stamped path, as it does an absolute dev-server one', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = {
      id: 'stamp2',
      name: 'App',
      stamp: { source: '/Users/me/proj/src/App.tsx', line: pos1(3) },
    };

    const result = mergeComponents([component], 'https://app.test', table, needles);
    expect(result.table.stamp2.absolutePath).toBe('/Users/me/proj/src/App.tsx');
  });

  it('keeps an absolute dev-server path, which is directly openable on this machine', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = {
      id: 'dev2',
      name: 'App',
      debugSource: { source: '/Users/me/proj/src/App.tsx', line: pos1(1), column: pos1(1) },
    };

    const result = mergeComponents([component], 'https://app.test', table, needles);
    expect(result.table.dev2.absolutePath).toBe('/Users/me/proj/src/App.tsx');
  });

  it('reports nothing changed when every component is already known', () => {
    const { table, needles } = empty();
    mergeComponents([withNeedle], 'https://app.test', table, needles);
    const again = mergeComponents([withNeedle], 'https://app.test', table, needles);
    expect(again.changed).toBe(false);
  });

  it('never downgrades an entry that already carries an answer', () => {
    const table: Record<string, ComponentSource> = {
      abc123: { name: 'Cart', status: 'resolved', source: 'src/Cart.tsx', line: pos1(19) },
    };
    const result = mergeComponents([withNeedle], 'https://app.test', table, {});
    expect(result.table.abc123.status).toBe('resolved');
    expect(result.changed).toBe(false);
  });

  it('says why a native function was skipped instead of leaving a blank', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = { id: 'n1', name: 'Bound', needleRejection: 'native' };
    const result = mergeComponents([component], 'https://app.test', table, needles);

    expect(result.table.n1.status).toBe('skipped');
    expect(result.table.n1.detail).toMatch(/no bundle/);
  });

  it('explains an unsettled lazy component rather than reporting a failed search', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = { id: 'l1', name: 'Lazy(loading…)' };
    const result = mergeComponents([component], 'https://app.test', table, needles);

    expect(result.table.l1.status).toBe('not-found');
    expect(result.table.l1.detail).toMatch(/lazy/i);
  });

  it('records that it hit the cap rather than silently dropping the rest', () => {
    const { table, needles } = empty();
    const many: CapturedComponent[] = Array.from({ length: 5 }, (_, i) => ({
      id: `c${i}`,
      name: `C${i}`,
      needle: { head: `function C${i}(){return null}` },
    }));

    const result = mergeComponents(many, 'https://app.test', table, needles, 3);

    expect(Object.keys(result.table)).toHaveLength(4); // 3 components + the notice
    expect(result.table[CAPPED_ID].status).toBe('skipped');
    expect(result.table[CAPPED_ID].detail).toMatch(/More than 3/);
  });
});

describe('isAbsolutePath', () => {
  it.each([
    ['/Users/me/app/src/App.tsx', true],
    ['C:\\projects\\app\\src\\App.tsx', true],
    ['src/components/Cart.tsx', false],
    ['webpack://app/./src/Cart.tsx', false],
  ])('%s → %s', (path, expected) => {
    expect(isAbsolutePath(path)).toBe(expected);
  });
});
