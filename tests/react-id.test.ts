import { describe, expect, it } from 'vitest';
import { componentId, fnv1a, isNameOnly, nameOnlyId } from '../src/core/react/id.js';

describe('componentId', () => {
  it('is stable across calls', () => {
    const source = 'function Cart(){return jsx("div",{children:items})}';
    expect(componentId('Cart', source)).toBe(componentId('Cart', source));
  });

  it('separates two components whose source differs', () => {
    const a = componentId('Button', 'function a(){return 1}');
    const b = componentId('Button', 'function a(){return 2}');
    expect(a).not.toBe(b);
  });

  it('separates two components whose name differs', () => {
    const source = 'function e(t){return null}';
    expect(componentId('Cart', source)).not.toBe(componentId('Header', source));
  });

  it('ignores source past the hashed head, so it is cheap on huge components', () => {
    const head = 'x'.repeat(200);
    expect(componentId('Big', `${head}AAAA`)).toBe(componentId('Big', `${head}BBBB`));
  });

  it('does not collide across a realistic flow of distinct components', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 500; i++) ids.add(componentId(`Component${i}`, `function c${i}(){return ${i}}`));
    expect(ids.size).toBe(500);
  });
});

describe('nameOnlyId', () => {
  it('is marked, so a component with no needle is never mistaken for a failed search', () => {
    expect(isNameOnly(nameOnlyId('LazyModal'))).toBe(true);
    expect(isNameOnly(componentId('Cart', 'function Cart(){return null}'))).toBe(false);
  });
});

describe('fnv1a', () => {
  it('stays inside 32 unsigned bits', () => {
    const hash = fnv1a('a'.repeat(1000), 0x811c9dc5);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(hash)).toBe(true);
  });
});
