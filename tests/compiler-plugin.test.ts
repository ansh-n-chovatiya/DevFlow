/**
 * `@devflow/compiler-plugin`: source in, transformed source out.
 *
 * Run through real Babel rather than against a hand-built AST, because every
 * failure mode this plugin has is a failure to agree with Babel about
 * something: which node a `const` arrow is, where a declarator's `loc` starts,
 * whether a TypeScript overload signature has a body. A fake AST agrees with
 * whatever the test author believed.
 *
 * The suite is the plugin's own, and it is deliberately not the fixture of any
 * existing test — see `ROADMAP_AND_PHASES.md` §1.1, rule 4. The reader is tested
 * separately in `react-stamp.test.ts`, and what joins the two is that both
 * spell `__devflow`.
 */

import { transformAsync } from '@babel/core';
import { afterEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import plugin, { type DevflowStampOptions } from '../compiler-plugin/index.js';
import { readStamp } from '../src/core/react/stamp.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function transform(
  source: string,
  { file = 'src/Cart.jsx', options = {} }: { file?: string; options?: DevflowStampOptions } = {},
): Promise<string> {
  const result = await transformAsync(source, {
    filename: resolve(ROOT, file),
    root: ROOT,
    cwd: ROOT,
    configFile: false,
    babelrc: false,
    parserOpts: { plugins: ['jsx', 'typescript'] },
    plugins: [[plugin, options]],
  });
  return result?.code ?? '';
}

/** The exact expression the plugin must emit, whitespace-normalised. */
function stamps(code: string): string[] {
  return [...code.matchAll(/(\w+)\.__devflow = \{\s*f: "([^"]*)",\s*l: (\d+)\s*\}/g)].map(
    (m) => `${m[1]} ${m[2]}:${m[3]}`,
  );
}

const ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ENV;
  delete process.env.BABEL_ENV;
});

describe('what is stamped', () => {
  it('stamps a function declaration with the line it begins on', async () => {
    const code = await transform('\nfunction Cart() {\n  return null;\n}\n');
    expect(stamps(code)).toEqual(['Cart src/Cart.jsx:2']);
  });

  it('stamps an arrow const, a function-expression const, and both exports', async () => {
    const code = await transform(
      [
        'const Header = () => null;', // 1
        'const Panel = function () { return null; };', // 2
        'export function Footer() { return null; }', // 3
        'export default function App() { return null; }', // 4
      ].join('\n'),
    );

    expect(stamps(code)).toEqual([
      'Header src/Cart.jsx:1',
      'Panel src/Cart.jsx:2',
      'Footer src/Cart.jsx:3',
      'App src/Cart.jsx:4',
    ]);
  });

  /*
   * The wrappers, and the asymmetry inside them.
   *
   * `forwardRef` and `memo` return an object, not a function, so a stamp on the
   * const names the wrapper. That is the only place to put it when the argument
   * is an inline arrow. When the argument is a declaration of its own, that
   * declaration is stamped too — which is why `readStamp` reads the inner
   * function before the wrapper, and why `memo(Cart)` reports where `Cart` was
   * written rather than where it was memoised.
   */
  it('stamps a wrapper whose component is written inside it, member expressions included', async () => {
    const code = await transform(
      [
        'const Row = forwardRef((props, ref) => null);', // 1
        'const Ref2 = React.forwardRef((p, r) => null);', // 2
        'const Both = memo(forwardRef((p, r) => null));', // 3
        'const Named = memo(function Inner() { return null; });', // 4
        'const Typed = memo((() => null) as never);', // 5
      ].join('\n'),
      { file: 'src/Cart.tsx' },
    );

    expect(stamps(code)).toEqual([
      'Row src/Cart.tsx:1',
      'Ref2 src/Cart.tsx:2',
      'Both src/Cart.tsx:3',
      'Named src/Cart.tsx:4',
      'Typed src/Cart.tsx:5',
    ]);
  });

  /*
   * The rule that keeps a wrapper's stamp honest, and it is worth stating as a
   * failure rather than as a restriction.
   *
   * `memo(SomeIcon)` where `SomeIcon` is imported: the wrapper would carry a
   * stamp naming *this* file, while React names the fiber after the library's
   * function. DevFlow would then report `SomeIcon` as living in `src/Icons.ts`,
   * resolved, `via: 'plugin'`, ahead of `_debugSource` and instead of a bundle
   * search — a confidently wrong file, which `table.ts` calls the one outcome
   * worse than no file. It would also refute the argument for putting the stamp
   * first, since it is a position in the parent's file after all.
   *
   * A local declaration passed by name needs no wrapper stamp: it has its own,
   * naming the line it was written on, and `readStamp` reads the inner function
   * before the wrapper precisely so that one wins.
   */
  it('refuses a wrapper around a name, because the name may not have been written here', async () => {
    const code = await transform(
      [
        'import { Icon } from "@acme/icons";', // 1
        'const Fast = memo(Icon);', // 2
        'const Slow = React.memo(Icon);', // 3
        'const Ref = forwardRef(Icon);', // 4
      ].join('\n'),
    );

    expect(stamps(code)).toEqual([]);
  });

  it('leaves the local declaration to carry its own, better line', async () => {
    const code = await transform(
      ['function Cart() {', '  return null;', '}', 'const Fast = memo(Cart);'].join('\n'),
    );

    // `Cart` and nothing else: the wrapper is silent, and `readStamp` finds
    // `Cart`'s own stamp through it.
    expect(stamps(code)).toEqual(['Cart src/Cart.jsx:1']);
  });

  it('stamps a const the type annotation is wrapped around', async () => {
    const code = await transform(
      ['const Cart = (() => null) as never;', 'const Header = (() => null)!;'].join('\n'),
      { file: 'src/Cart.tsx' },
    );

    expect(stamps(code)).toEqual(['Cart src/Cart.tsx:1', 'Header src/Cart.tsx:2']);
  });
});

describe('what is not stamped', () => {
  it('leaves a lowercase function alone, however component-shaped it looks', async () => {
    const code = await transform('function helper() { return null; }\nconst render = () => null;');
    expect(stamps(code)).toEqual([]);
    expect(code).not.toContain('__devflow');
  });

  it('leaves a capitalised non-function const alone', async () => {
    const code = await transform('const CONFIG = { a: 1 };\nconst Rows = [1, 2];\nconst Total = 3;');
    expect(stamps(code)).toEqual([]);
  });

  /*
   * Named gaps, not oversights — `compiler-plugin/README.md` lists all three.
   * Asserted so that adding any of them is a deliberate act with a test to
   * update, rather than something that drifts in.
   */
  it('leaves classes, nested components and anonymous default exports alone', async () => {
    const code = await transform(
      [
        'class Legacy extends React.Component { render() { return null; } }',
        'function useThing() { const Inner = () => null; return Inner; }',
        'export default () => null;',
      ].join('\n'),
    );

    expect(stamps(code)).toEqual([]);
  });

  it('leaves a TypeScript overload signature and a declare alone', async () => {
    const code = await transform(
      ['declare function Cart(): null;', 'declare const Header: () => null;'].join('\n'),
      { file: 'src/Cart.ts' },
    );

    expect(stamps(code)).toEqual([]);
  });

  /*
   * A file Babel is given without a filename, or one outside the root, cannot
   * produce a repo-relative `f`. Stamping it with an absolute machine path is
   * the thing this refuses: it leaks a directory layout and it is not what `f`
   * is defined to hold.
   */
  it('stamps nothing when the file is outside the root it would be relative to', async () => {
    const result = await transformAsync('function Cart() { return null; }', {
      filename: '/somewhere/else/Cart.jsx',
      root: ROOT,
      cwd: ROOT,
      configFile: false,
      babelrc: false,
      plugins: [plugin],
    });

    expect(result?.code ?? '').not.toContain('__devflow');
  });
});

describe('production builds', () => {
  it('stamps nothing when NODE_ENV is production', async () => {
    process.env.NODE_ENV = 'production';
    const code = await transform('function Cart() { return null; }');
    expect(code).not.toContain('__devflow');
  });

  it('stamps nothing when BABEL_ENV is production, whatever NODE_ENV says', async () => {
    process.env.NODE_ENV = 'development';
    process.env.BABEL_ENV = 'production';
    const code = await transform('function Cart() { return null; }');
    expect(code).not.toContain('__devflow');
  });

  /*
   * An empty `BABEL_ENV` is not an answer, it is the absence of one. Under `??`
   * it counts as set and masks `NODE_ENV`, which stamps the production build —
   * the one outcome the default exists to prevent, caused by a shell exporting
   * a variable blank.
   */
  it('falls through an empty BABEL_ENV to NODE_ENV rather than treating it as set', async () => {
    process.env.NODE_ENV = 'production';
    process.env.BABEL_ENV = '';
    const code = await transform('function Cart() { return null; }');
    expect(code).not.toContain('__devflow');
  });

  it('stamps a production build when the option asks for it, and only then', async () => {
    process.env.NODE_ENV = 'production';
    const code = await transform('function Cart() { return null; }', {
      options: { includeInProduction: true },
    });
    expect(stamps(code)).toEqual(['Cart src/Cart.jsx:1']);
  });
});

describe('the path', () => {
  it('is POSIX-separated and relative to the root option when one is given', async () => {
    const code = await transform('function Cart() { return null; }', {
      file: 'src/ui/locator/Cart.jsx',
    });
    expect(stamps(code)).toEqual(['Cart src/ui/locator/Cart.jsx:1']);
  });

  /*
   * The one claim in this file that cannot be behavioural here.
   *
   * `f` is defined as POSIX-separated, and on Windows `path.relative` returns
   * backslashes. On this machine `sep` is already `/`, so deleting the
   * conversion changes nothing any transform can show — a mutation that
   * survives every test in the suite. So the expression is asserted literally,
   * exactly as written, because a grep for a nearby phrase passes against the
   * deletion of the line under it. It is the weakest kind of test and here it
   * is the only kind.
   */
  it('converts native separators to POSIX ones, asserted through the source', () => {
    const source = readFileSync(resolve(ROOT, 'compiler-plugin/index.js'), 'utf8');
    expect(source).toContain("return rel.split(sep).join('/');");
  });

  it('honours an explicit root over Babel’s', async () => {
    const code = await transform('function Cart() { return null; }', {
      file: 'src/ui/locator/Cart.jsx',
      options: { root: resolve(ROOT, 'src') },
    });
    expect(stamps(code)).toEqual(['Cart ui/locator/Cart.jsx:1']);
  });
});

describe('what it does to the application', () => {
  /*
   * The whole reason the stamp is a static property and not a JSX prop. An
   * attribute would reach the DOM and change the user's app — their snapshot
   * tests, their attribute selectors, their accessibility tree — which
   * Invariant 1 forbids outright. Asserted on the rendered output rather than
   * argued for in a comment.
   */
  it('adds nothing to the JSX', async () => {
    const code = await transform(
      'function Cart() {\n  return <div className="cart"><span>1</span></div>;\n}',
    );

    expect(stamps(code)).toEqual(['Cart src/Cart.jsx:1']);
    // The JSX is returned exactly as written: no extra attribute, no wrapper.
    expect(code).toContain('<div className="cart"><span>1</span></div>');
  });

  it('emits the assignment after the declaration, not inside it', async () => {
    const code = await transform('function Cart() {\n  return null;\n}');
    expect(code.indexOf('Cart.__devflow')).toBeGreaterThan(code.indexOf('return null'));
  });

  /*
   * A module is strict code, so assigning a new property to a frozen or sealed
   * object throws a TypeError rather than failing silently. Without the guard
   * that takes somebody's development build down at import, with a stack
   * pointing at code they did not write — the harm Invariant 1 forbids
   * outright, caused by the tool that promised not to cause it.
   *
   * The reachable shape is a *wrapper* that freezes, not an `Object.freeze`
   * further down the file: the stamp is emitted immediately after the
   * declaration, so it always runs before any later statement. React's own
   * `memo` and `forwardRef` return extensible objects; a shim or a library
   * standing in for them need not.
   */
  it('cannot throw when a wrapper hands back a frozen object', async () => {
    const code = await transform(
      [
        'const memo = (c) => Object.freeze({ type: c });', // 1
        'const Fast = memo(() => null);', // 2
        'function Header() { return null; }', // 3
      ].join('\n'),
    );

    // The stamp is attempted — this is not a case the plugin skipped.
    expect(stamps(code)).toEqual(['Fast src/Cart.jsx:2', 'Header src/Cart.jsx:3']);

    expect(() => evaluate(code, 'Fast', 'Header')).not.toThrow();

    const { Fast, Header } = evaluate(code, 'Fast', 'Header');
    expect(readStamp(Fast)).toBeNull();
    // And the refusal does not cost the components after it their stamps.
    expect(readStamp(Header)).toEqual({ source: 'src/Cart.jsx', line: 3 });
  });
});

// ── The seam between the two packages ────────────────────────────────────────

/*
 * The plugin writes `__devflow` and `src/core/react/stamp.ts` reads it, and
 * nothing else joins them: they are separate packages, one plain JS and one
 * TypeScript, and the property name is a string in each. A rename in the
 * *reader* breaks the whole feature and fails nothing — every test in
 * `react-stamp.test.ts` builds its own fixture with the same literal, so it
 * renames along with the code it is testing.
 *
 * (A rename in the plugin does fail the tests above, because `stamps()` greps
 * for the literal key. Half a seam is covered by accident; this covers the
 * other half on purpose, by running the plugin's actual output through the
 * actual reader.)
 */
/**
 * Runs transformed output and hands back the named bindings.
 *
 * `'use strict'` is not decoration. `runInNewContext` evaluates a *script*, and
 * a sloppy script fails silently where a module throws — assigning to a frozen
 * object being exactly that case. Without this the frozen-wrapper test below
 * passes whether or not the guard it is testing exists, which is what it did.
 */
function evaluate(code: string, ...names: string[]): Record<string, unknown> {
  return runInNewContext(`'use strict';${code};({${names.join(',')}})`) as Record<string, unknown>;
}

describe('the plugin and the reader agree', () => {
  it('produces a stamp readStamp reads back, for a plain component', async () => {
    const code = await transform('function Cart() {\n  return null;\n}');
    const { Cart } = evaluate(code, 'Cart');

    expect(readStamp(Cart)).toEqual({ source: 'src/Cart.jsx', line: 1 });
  });

  it('produces a stamp readStamp reads back off a forwardRef wrapper', async () => {
    const code = await transform(
      'const forwardRef = (render) => ({ render });\nconst Row = forwardRef((p, r) => null);',
    );
    const { Row } = evaluate(code, 'Row');

    // The wrapper object, which is what the const bound — the arrow inside it
    // has no binding of its own to stamp.
    expect(readStamp(Row)).toEqual({ source: 'src/Cart.jsx', line: 2 });
    expect(readStamp((Row as { render: unknown }).render)).toBeNull();
  });
});
