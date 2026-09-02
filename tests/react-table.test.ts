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

  /*
   * `dependency`, on every branch that resolves a path.
   *
   * `src/ui/locator/locate.ts` sets `absolutePath` and `dependency` together
   * from identical input, and everything downstream reads the flag rather than
   * re-testing the path: `pickOwner` refuses a dependency as a step's owner,
   * the review view renders the `node_modules` tag from it, and
   * `classifyComponent` buckets on it. A recording that omits it names somebody
   * else's component as the owner of a step while the panel, over the same
   * component, tags it correctly — two surfaces over one recording disagreeing,
   * which is what the shared precedence exists to prevent.
   */
  it.each([
    [
      'a stamped path',
      { id: 'dep1', name: 'Dialog', stamp: { source: 'node_modules/@radix-ui/react-dialog/index.js', line: pos1(4) } },
    ],
    [
      'a JSX position React recorded',
      { id: 'dep2', name: 'Dialog', debugSource: { source: 'node_modules/@radix-ui/react-dialog/index.js', line: pos1(4), column: pos1(1) } },
    ],
  ] as [string, CapturedComponent][])('flags a component under node_modules — %s', (_label, component) => {
    const { table, needles } = empty();
    const result = mergeComponents([component], 'https://app.test', table, needles);

    expect(result.table[component.id].dependency).toBe(true);
  });

  it('leaves the flag off a path inside the application', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = {
      id: 'own1',
      name: 'Cart',
      stamp: { source: 'src/Cart.tsx', line: pos1(12) },
    };

    const result = mergeComponents([component], 'https://app.test', table, needles);
    expect(result.table.own1).not.toHaveProperty('dependency');
  });

  /*
   * The one upgrade, and the three things that are not it.
   *
   * A page agent's `componentCache` is per injection, so a content script
   * re-injected after a navigation captures a component it has already seen
   * from scratch. If the first capture read no stamp, first-answer-wins freezes
   * the entry at `via: 'debug-source'` — the *parent's* file — while the panel
   * resolves the same component to its own. See `isStampUpgrade`.
   */
  it('upgrades a debug-source entry when the component is seen again with a stamp', () => {
    const { table, needles } = empty();
    mergeComponents(
      [{ id: 'up1', name: 'Cart', debugSource: { source: 'src/App.tsx', line: pos1(40), column: pos1(6) } }],
      'https://app.test',
      table,
      needles,
    );
    expect(table.up1).toMatchObject({ via: 'debug-source', source: 'src/App.tsx' });

    const again = mergeComponents(
      [{ id: 'up1', name: 'Cart', stamp: { source: 'src/Cart.tsx', line: pos1(12) } }],
      'https://app.test',
      table,
      needles,
    );

    expect(again.changed).toBe(true);
    expect(again.table.up1).toMatchObject({ via: 'plugin', source: 'src/Cart.tsx', line: 12 });
    // `column` belonged to the position it replaced and must not survive it.
    expect(again.table.up1).not.toHaveProperty('column');
  });

  it('refuses to let a stamp overwrite an answer resolved against the page’s own map', () => {
    const table: Record<string, ComponentSource> = {
      bs1: {
        name: 'Cart',
        status: 'resolved',
        via: 'bundle-search',
        source: 'src/Cart.tsx',
        line: pos1(12),
      },
    };

    const result = mergeComponents(
      [{ id: 'bs1', name: 'Cart', stamp: { source: 'src/Wrong.tsx', line: pos1(1) } }],
      'https://app.test',
      table,
      {},
    );

    expect(result.table.bs1).toMatchObject({ via: 'bundle-search', source: 'src/Cart.tsx' });
    expect(result.changed).toBe(false);
  });

  it('refuses to let a JSX position overwrite a stamp', () => {
    const table: Record<string, ComponentSource> = {
      pl1: { name: 'Cart', status: 'resolved', via: 'plugin', source: 'src/Cart.tsx', line: pos1(12) },
    };

    const result = mergeComponents(
      [{ id: 'pl1', name: 'Cart', debugSource: { source: 'src/App.tsx', line: pos1(40), column: pos1(6) } }],
      'https://app.test',
      table,
      {},
    );

    expect(result.table.pl1).toMatchObject({ via: 'plugin', source: 'src/Cart.tsx' });
    expect(result.changed).toBe(false);
  });

  /*
   * The cap counts distinct components, and an upgrade adds none.
   *
   * Testing the cap before knowing whether the id is new would both refuse the
   * upgrade and write the cap marker on the strength of a component already
   * counted in the number that tripped it — a note saying components were
   * dropped, on a flow that dropped none.
   */
  it('upgrades an entry in a table that is already at the cap, and writes no cap notice', () => {
    const { table, needles } = empty();
    mergeComponents(
      [
        { id: 'c0', name: 'C0', debugSource: { source: 'src/App.tsx', line: pos1(1), column: pos1(1) } },
        { id: 'c1', name: 'C1', needle: { head: 'function C1(){return null}' } },
      ],
      'https://app.test',
      table,
      needles,
      2,
    );

    const again = mergeComponents(
      [{ id: 'c0', name: 'C0', stamp: { source: 'src/C0.tsx', line: pos1(3) } }],
      'https://app.test',
      table,
      needles,
      2,
    );

    expect(again.table.c0).toMatchObject({ via: 'plugin', source: 'src/C0.tsx' });
    expect(again.table).not.toHaveProperty(CAPPED_ID);
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
