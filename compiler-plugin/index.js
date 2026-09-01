/**
 * A build-time record of where each React component was defined.
 *
 * ## Why a static property and not a JSX prop
 *
 * The obvious stamp is an attribute on the JSX — `data-devflow-source` — and it
 * is the one thing this plugin may never do. That attribute reaches the DOM, so
 * it changes the user's application: it lands in their snapshot tests, their
 * CSS attribute selectors and their accessibility tree. DevFlow's first
 * invariant is that it needs no app changes; a plugin is already a change to the
 * build, and a change to the rendered output on top of that is a different
 * product.
 *
 * `Cart.__devflow = { f, l }` is inert. It is a property on a function the app
 * already owns, evaluated once at module scope, invisible to React, invisible to
 * the DOM, and removable by deleting the plugin.
 *
 * ## Why the component function and not a registry
 *
 * A module-level registry keyed by name would need a lookup, and a lookup needs
 * the name to be unique across an app — which it is not. DevFlow already holds
 * the component *function* off the fiber (`getComponentFn` in
 * `src/core/react/fiber.ts`), so a property on that function is read with no
 * React internals at all. That is the one part of this feature that cannot rot
 * when React moves something: it already survived `_debugSource` being dropped
 * in React 19, because it never depended on it.
 *
 * ## What it deliberately does not stamp
 *
 * Lowercase names, class components, anonymous default exports, and anything
 * defined below module scope. A stamp on a non-component is a row in DevFlow's
 * component table that names nothing, and a stamp inside a function body is an
 * assignment that runs on every call. The README says which of these are gaps
 * and which are refusals.
 *
 * ## Development builds only, by default
 *
 * Stamping ships the source layout of the repo in the bundle. Handing every
 * visitor a customer's directory tree is a decision they make deliberately, so
 * it is `includeInProduction`, and it is off.
 */

import { isAbsolute, relative, sep } from 'node:path';

/**
 * The property name.
 *
 * Lowercase and prefixed, matching the `~/.devflow` and `devflow-mcp-server`
 * identifiers the rest of the product already answers to. It is read back by
 * `readStamp` in `src/core/react/stamp.ts`, and the two must agree — that pair
 * is the whole contract between this package and the extension.
 */
const STAMP_KEY = '__devflow';

/**
 * The wrappers whose result is the value the app exports.
 *
 * `forwardRef(fn)` and `memo(fn)` return an object, not a function, so the stamp
 * on `const Cart = forwardRef(…)` lands on that object. DevFlow reads the inner
 * function's stamp first and this one second, which is why `memo(Cart)` — where
 * `Cart` is a stamped declaration of its own — still reports the line `Cart` was
 * written on rather than the line it was memoised on.
 */
const WRAPPERS = new Set(['forwardRef', 'memo']);

/** React's own rule for what may be rendered as a component. */
function isComponentName(name) {
  return typeof name === 'string' && /^[A-Z]/.test(name);
}

/**
 * Whether this build is a production one.
 *
 * Read from the environment at transform time rather than through `api.env()`,
 * because Babel caches a plugin's configuration and a cached answer to this
 * question is the one that ships source paths to production.
 *
 * `||` rather than `??`, and the difference is the whole failure this guards:
 * `??` keeps an empty `BABEL_ENV`, so a shell that exports it blank would mask
 * `NODE_ENV=production` and stamp the production build anyway.
 */
function isProduction() {
  return (process.env.BABEL_ENV || process.env.NODE_ENV) === 'production';
}

/**
 * The file, repo-relative and POSIX-separated, or null if it cannot be said.
 *
 * A file outside the root is skipped rather than stamped with an absolute path.
 * `f` is defined as repo-relative; a machine path in a bundle is both a leak and
 * a value the reader would have to guess the meaning of.
 */
function relativeFilename(state, root) {
  const filename = state.file.opts.filename;
  if (typeof filename !== 'string' || filename === '') return null;

  const base = root ?? state.file.opts.root ?? state.cwd ?? process.cwd();
  const rel = relative(base, filename);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null;

  return rel.split(sep).join('/');
}

/** 1-based, as Babel records it and as `Pos1` means it. No arithmetic here. */
function lineOf(node) {
  const line = node.loc?.start?.line;
  return Number.isInteger(line) && line > 0 ? line : null;
}

/** TypeScript and parentheses around an expression, which say nothing about it. */
function unwrapExpression(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion' ||
      current.type === 'ParenthesizedExpression')
  ) {
    current = current.expression;
  }
  return current;
}

function isFunctionExpression(node) {
  return node?.type === 'ArrowFunctionExpression' || node?.type === 'FunctionExpression';
}

function calleeName(node) {
  const callee = node.callee;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' && !callee.computed && callee.property.type === 'Identifier') {
    return callee.property.name;
  }
  return null;
}

/**
 * A `forwardRef` or `memo` call whose component was written *here*.
 *
 * The argument has to be a function literal, and that restriction is the whole
 * of the rule rather than a detail of it. The stamp on a wrapper says "the
 * component this object wraps was defined on this line", and for
 * `forwardRef((props, ref) => …)` that is exactly true — there is no inner
 * binding to stamp and the arrow is written right there.
 *
 * For `memo(Cart)` it is not. If `Cart` is a local declaration it carries its
 * own, better stamp and this one is redundant; if `Cart` is imported — the
 * common case, `memo(SomeLibraryIcon)` — then the wrapper's stamp names the
 * *consumer's* file while `getDisplayName` reads the library's name off the
 * fiber. DevFlow would then report `SomeLibraryIcon` as living in
 * `src/Icons.ts`, as `status: 'resolved'`, `via: 'plugin'`, ahead of
 * `_debugSource` and instead of a bundle search. That is a confidently wrong
 * file, which `table.ts` calls the one outcome worse than no file — and it
 * would contradict the very argument for putting the stamp first, since it is
 * a position in the parent's file after all.
 *
 * So an identifier argument is left unstamped and the answer falls through to
 * the paths that can be right about it.
 */
function isInlineWrapperCall(node) {
  if (!node || node.type !== 'CallExpression') return false;

  const name = calleeName(node);
  if (name === null || !WRAPPERS.has(name)) return false;

  const argument = unwrapExpression(node.arguments[0]);
  // `memo(forwardRef((p, r) => …))` — nested, and still written here.
  return isFunctionExpression(argument) || isInlineWrapperCall(argument);
}

/** A `const` whose value could be a component: a function, or a wrapped one. */
function isComponentInit(init) {
  const node = unwrapExpression(init);
  if (!node) return false;
  if (isFunctionExpression(node)) return true;
  return isInlineWrapperCall(node);
}

/**
 * The bindings one top-level statement defines that are worth stamping.
 *
 * Returns `{ name, line }` pairs rather than emitting anything, so the decision
 * about *what* is a component is one function a reader can check against the
 * README's list.
 */
function stampsFor(node) {
  if (node.type === 'ExportNamedDeclaration') {
    return node.declaration ? stampsFor(node.declaration) : [];
  }

  if (node.type === 'ExportDefaultDeclaration') {
    // `export default function Cart() {}` binds `Cart`; `export default () => {}`
    // binds nothing, and there is no name to hang a property on.
    return node.declaration ? stampsFor(node.declaration) : [];
  }

  if (node.type === 'FunctionDeclaration') {
    // `body` is absent on a TypeScript overload signature and on `declare`.
    if (!node.body || !node.id || !isComponentName(node.id.name)) return [];
    const line = lineOf(node);
    return line ? [{ name: node.id.name, line }] : [];
  }

  if (node.type === 'VariableDeclaration') {
    if (node.declare) return [];

    const stamps = [];
    for (const declarator of node.declarations) {
      if (declarator.id?.type !== 'Identifier') continue;
      if (!isComponentName(declarator.id.name)) continue;
      if (!isComponentInit(declarator.init)) continue;

      const line = lineOf(declarator);
      if (line) stamps.push({ name: declarator.id.name, line });
    }
    return stamps;
  }

  return [];
}

/**
 * @param {object} api Babel's plugin API — `api.types` builds the assignment.
 * @param {{ includeInProduction?: boolean, root?: string }} options
 */
export default function devflowComponentStamp(api, options = {}) {
  const t = api.types;
  const { includeInProduction = false, root } = options;

  /**
   * `try { Cart.__devflow = {…}; } catch {}`.
   *
   * The `try` is not defensiveness for its own sake. A module is strict code,
   * and assigning a new property to a frozen, sealed or otherwise
   * non-extensible object throws a `TypeError` there rather than failing
   * silently — so a component somebody froze would take their development build
   * down at import, with a stack pointing at code they did not write. That is
   * exactly the class of harm Invariant 1 forbids, and it costs four tokens to
   * make impossible.
   *
   * `Object.isExtensible(Cart) && …` would be shorter and was rejected: it
   * reads a global, and a module that binds its own `Object` — or runs where
   * one has been shadowed — would have the guard mean something else entirely.
   * A `try` reads nothing.
   */
  const assignment = (name, file, line) =>
    t.tryStatement(
      t.blockStatement([
        t.expressionStatement(
          t.assignmentExpression(
            '=',
            t.memberExpression(t.identifier(name), t.identifier(STAMP_KEY)),
            t.objectExpression([
              t.objectProperty(t.identifier('f'), t.stringLiteral(file)),
              t.objectProperty(t.identifier('l'), t.numericLiteral(line)),
            ]),
          ),
        ),
      ]),
      t.catchClause(null, t.blockStatement([])),
    );

  return {
    name: 'devflow-component-stamp',
    visitor: {
      /*
       * Program, and only its direct body.
       *
       * On enter, so the positions read are positions in the file the developer
       * wrote — the JSX transform runs after this and replaces the nodes whose
       * `loc` this depends on. Iterating the body rather than visiting
       * `FunctionDeclaration` everywhere is what keeps the stamp at module
       * scope: a component declared inside a hook would otherwise get an
       * assignment that re-runs on every call.
       */
      Program(path, state) {
        if (!includeInProduction && isProduction()) return;

        const file = relativeFilename(state, root);
        if (!file) return;

        for (const statement of path.get('body')) {
          const stamps = stampsFor(statement.node);
          if (stamps.length === 0) continue;
          statement.insertAfter(stamps.map(({ name, line }) => assignment(name, file, line)));
        }
      },
    },
  };
}
