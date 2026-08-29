import { describe, expect, it } from 'vitest';
import { normalizeSourcePath } from '../src/core/react/sourcemap.js';

describe('normalizeSourcePath', () => {
  /** Every case — what the bundlers people actually use emit. */
  const cases: [string, string, string][] = [
    ['webpack', 'webpack://app/./src/Foo.tsx', 'src/Foo.tsx'],
    ['webpack, no namespace', 'webpack:///./src/index.js', 'src/index.js'],
    [
      'Next.js dev',
      'webpack-internal:///(app-pages-browser)/./src/app/page.tsx',
      'src/app/page.tsx',
    ],
    ['Vite dev', '/Users/me/proj/src/App.tsx', '/Users/me/proj/src/App.tsx'],
    ['Vite build', '../../src/App.tsx', 'src/App.tsx'],
    ['esbuild', 'src/App.tsx', 'src/App.tsx'],
  ];

  for (const [tool, raw, want] of cases) {
    it(`normalises what ${tool} emits`, () => {
      expect(normalizeSourcePath(raw)).toBe(want);
    });
  }

  it('keeps an absolute path absolute', () => {
    // FlowSnap hands flows to an AI on the same machine, so an absolute path
    // from a dev server is directly openable — better than a guessed relative one.
    expect(normalizeSourcePath('file:///Users/me/proj/src/App.tsx')).toBe(
      '/Users/me/proj/src/App.tsx',
    );
  });

  it('drops the bundler namespace but keeps everything under the root', () => {
    expect(normalizeSourcePath('webpack://my-app/./packages/ui/src/Button.tsx')).toBe(
      'packages/ui/src/Button.tsx',
    );
  });

  it('keeps node_modules visible, since that is what marks a dependency', () => {
    expect(normalizeSourcePath('webpack://app/./node_modules/@mui/Button.js')).toBe(
      'node_modules/@mui/Button.js',
    );
  });

  it('collapses . and .. inside a path', () => {
    expect(normalizeSourcePath('src/components/../hooks/./useCart.ts')).toBe(
      'src/hooks/useCart.ts',
    );
  });

  it('leaves a Windows drive path alone', () => {
    expect(normalizeSourcePath('C:/Users/me/src/App.tsx')).toBe('C:/Users/me/src/App.tsx');
  });

  it('survives an empty or degenerate source', () => {
    expect(normalizeSourcePath('')).toBe('');
    expect(normalizeSourcePath('/')).toBe('/');
  });
});
