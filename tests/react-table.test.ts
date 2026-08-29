import { describe, expect, it } from 'vitest';
import { CAPPED_ID, isAbsolutePath, mergeComponents } from '../src/core/react/table.js';
import type { CapturedComponent } from '../src/shared/messages.js';
import type { ComponentNeedle, ComponentSource } from '../src/shared/types.js';

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
      debugSource: { source: 'src/Cart.tsx', line: 19, column: 3 },
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

  it('keeps an absolute dev-server path, which is directly openable on this machine', () => {
    const { table, needles } = empty();
    const component: CapturedComponent = {
      id: 'dev2',
      name: 'App',
      debugSource: { source: '/Users/me/proj/src/App.tsx', line: 1, column: 1 },
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
      abc123: { name: 'Cart', status: 'resolved', source: 'src/Cart.tsx', line: 19 },
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
