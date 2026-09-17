/**
 * Guards ADR 0001 — `src/core/` stays pure — which until now was a rule with no
 * gate behind it.
 *
 * `core/` has two consumers. In the extension `chrome.*`, `window` and the DOM
 * all exist; bundled by `mcp-bundle.ts` into `mcp-server/core.js` it is imported
 * by a Node process where none of them do. The audit that prompted this file
 * (report.md §3.6 P1) made the gap concrete: it added
 * `chrome.storage.local.get(...)`, a bare `fetch` and `window.location.href` to
 * a real `core/` module and `npm run verify` came back green. Nothing in the
 * chain was looking. `eslint.config.js` hands `globals.browser` and
 * `globals.webextensions` to the whole tree, `tsconfig.json` puts the ambient
 * `chrome` types over all of `src/`, and the Vite MCP build only fails on an
 * import it cannot *resolve* — a bare global reference resolves to nothing at
 * build time and to a `ReferenceError` on the server's first tool call, inside a
 * package published separately from the extension.
 *
 * So this reads references, not imports. That is the distinction that makes it
 * worth a script.
 *
 * ## Why an AST and not a regex
 *
 * The six sibling gates match text, and text is wrong here — not marginally, but
 * on three real files in the tree as it stands today:
 *
 *   - `locate/search.ts` names a local variable `window` and calls
 *     `window.lastIndexOf(...)` on it. Pure code; a `\bwindow\.` pattern reports
 *     it.
 *   - `export/playwright.ts` emits `import { test } from '@playwright/test';`
 *     as generated source inside a template literal. It is a string, not an
 *     import.
 *   - `locate/editor.ts` matches the URL scheme `chrome[\w-]*:` inside a regex
 *     literal, and `mcp-bundle.ts` re-exports `./navigator/index.js` — a
 *     directory in this repo, not the DOM's `navigator`.
 *
 * A gate that fires on those is a gate somebody switches off, which is the
 * failure `check-vocab.mjs` already documents about over-broad bans. TypeScript
 * is a devDependency here anyway (`npm run typecheck` runs it), so the parser is
 * free: an identifier the parser hands back is a real reference in real code,
 * never a word inside a comment, a string, a template or a regex.
 *
 * ## The shadow rule, and what it trades away
 *
 * A banned name that the file itself declares — `locate/search.ts`'s `window` —
 * is exempt for that whole file. That is deliberately coarser than real scope
 * analysis: it costs the ability to catch `const chrome = …` in one function and
 * a genuine `chrome.*` in another, and it buys a gate with no scope-tracker to
 * get subtly wrong. The obvious way to abuse the exemption is
 * `const chrome = globalThis.chrome`, which is why `globalThis` itself is banned
 * below rather than just its DOM-flavoured properties.
 *
 * ## The clock, and why it is not in `BANNED`
 *
 * ADR 0001 also forbids a clock and randomness. That half sat here unenforced
 * until `core/flow/index.ts`'s `defaultFilename(now = new Date())` was fixed
 * (report.md §3.6 P2); it is live now, but not as a banned identifier, because
 * `Date` is not what impurity looks like. Six modules in `core/` read `Date`
 * today and every one of them is pure: `deploy/`, `forensics/`, `telemetry/`,
 * `export/markdown.ts` and `export/json.ts` write `now?: Date` as a type or
 * format a timestamp they were handed with `new Date(ms)`, and `state/snapshot`
 * calls `Date.prototype.toISOString` on a value it was given. Banning the name
 * would report all six and the gate would be off by Friday.
 *
 * What is impure is the *zero-argument* call — the one that asks the host what
 * time it is, or for a number nobody passed in: `new Date()` with no arguments,
 * `Date.now`, `performance.now`, `Math.random`, `crypto.randomUUID`. So the
 * arguments decide for the constructor, and `CLOCK` below keys the rest by the
 * member rather than the object. `Date.parse(s)` and `new Date(ms)` stay legal
 * for the same reason they are pure: the instant comes in as an argument.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dir = resolve(root, 'src/core');

/**
 * Globals that do not exist in the MCP server's Node process, or that ADR 0001
 * forbids core from reaching for even where they do.
 *
 * The list is short on purpose. `parent`, `top`, `name`, `origin`, `status`,
 * `length`, `event` and `close` are all window properties and all ordinary
 * identifiers in this codebase — banning them would produce noise at a rate that
 * gets the whole gate disabled, and none of them is how impurity actually
 * arrives. What arrives is storage, the network and the document.
 */
const BANNED = new Map([
  ['chrome', 'the extension APIs; they belong behind src/chrome/'],
  ['browser', 'the WebExtension APIs; they belong behind src/chrome/'],
  ['window', 'the DOM; core is imported by a Node process that has none'],
  ['document', 'the DOM; core is imported by a Node process that has none'],
  ['navigator', 'the DOM; core is imported by a Node process that has none'],
  ['location', 'the DOM; pass the URL in as an argument'],
  ['self', 'a worker/DOM global; core is imported by a Node process'],
  ['globalThis', 'the escape hatch that would make every rule below optional'],
  ['localStorage', 'storage belongs to src/features/'],
  ['sessionStorage', 'storage belongs to src/features/'],
  ['indexedDB', 'storage belongs to src/features/'],
  ['caches', 'caching belongs to a BundleProvider'],
  ['fetch', 'fetching belongs to a BundleProvider, injected as an argument'],
  ['XMLHttpRequest', 'fetching belongs to a BundleProvider, injected as an argument'],
  ['WebSocket', 'the network belongs to src/features/'],
  ['EventSource', 'the network belongs to src/features/'],
  ['alert', 'the DOM; core returns data and renders nothing'],
  ['confirm', 'the DOM; core returns data and renders nothing'],
  ['prompt', 'the DOM; core returns data and renders nothing'],
  ['getComputedStyle', 'the DOM; core is imported by a Node process that has none'],
  ['matchMedia', 'the DOM; core is imported by a Node process that has none'],
  ['requestAnimationFrame', 'the DOM; core is imported by a Node process that has none'],
  ['requestIdleCallback', 'the DOM; core is imported by a Node process that has none'],
  ['customElements', 'the DOM; core is imported by a Node process that has none'],
  ['DOMParser', 'the DOM; core is imported by a Node process that has none'],
  ['MutationObserver', 'the DOM; core is imported by a Node process that has none'],
  ['IntersectionObserver', 'the DOM; core is imported by a Node process that has none'],
  ['ResizeObserver', 'the DOM; core is imported by a Node process that has none'],
  ['FileReader', 'the DOM; core is imported by a Node process that has none'],
]);

/**
 * The other half of ADR 0001: the clock and randomness, keyed by member.
 *
 * `Date`, `performance`, `Math` and `crypto` are all fine to name — see the
 * header. `Date.now` is not, and neither is a `new Date()` with nothing in the
 * parentheses, which `clockRead()` below handles separately because there the
 * arguments are the rule.
 */
export const CLOCK = new Map([
  ['Date.now', 'the clock; take the timestamp as an argument, or read it in src/features/'],
  ['performance.now', 'the clock; take the timestamp as an argument, or read it in src/features/'],
  ['Math.random', 'randomness; take the value as an argument, or generate it in src/features/'],
  ['crypto.randomUUID', 'randomness; take the id as an argument, or generate it in src/features/'],
  [
    'crypto.getRandomValues',
    'randomness; take the bytes as an argument, or generate them in src/features/',
  ],
]);

/** Directories under `src/` that exist precisely because they are not pure. */
const IMPURE_DIRS = ['chrome', 'background', 'content', 'injected', 'ui', 'features'];

/**
 * `mcp-bundle.ts` re-exports the settings field table out of `src/features/`.
 *
 * That is the one deliberate crossing and it is the bundle's entry point, not a
 * core module: `features/settings/{fields,resolve,render,stamp}.ts` are pure
 * data and pure functions over it, and the MCP server needs the same table the
 * options page uses or the two drift. Keyed to the file *and* the subdirectory,
 * so re-exporting `features/store.ts` from the same file still fails.
 */
const CROSSING = { file: 'mcp-bundle.ts', prefix: 'features/settings/' };

/** Node builtins: core also runs in a browser, where none of these resolve. */
const BUILTIN = /^(node:|(fs|path|url|os|http|https|crypto|child_process|worker_threads|zlib|stream|util|events)$)/;

const errors = [];

/** Every name the file binds anywhere in it — see "the shadow rule" above. */
function declaredNames(source) {
  const names = new Set();

  const visit = (node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isClassDeclaration(node) ||
        ts.isImportClause(node) ||
        ts.isImportSpecifier(node) ||
        ts.isNamespaceImport(node) ||
        ts.isTypeParameterDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    ) {
      names.add(node.name.text);
    }
    ts.forEachChild(node, visit);
  };

  visit(source);
  return names;
}

/**
 * True when the identifier is a *name* rather than a reference to a value.
 *
 * `step.window`, `{ window: 1 }` and `import { window } from …` all mention the
 * word without reading the global, and `interface X { document: string }` is a
 * field of this repo's own data.
 */
function isName(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent)) return true;
  if (ts.isQualifiedName(parent) && parent.right === node) return true;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true;
  if (parent.propertyName === node) return true;
  // A declaration's own name, an object literal key, a class member's name.
  // `{ window }` shorthand is *not* caught here: `name` is the node only for a
  // ShorthandPropertyAssignment, which genuinely does read the variable.
  return parent.name === node && !ts.isShorthandPropertyAssignment(parent);
}

/**
 * The clock or randomness this node reads, as a message, or null.
 *
 * Two shapes, and the difference between them is the entire rule. `new Date()`
 * with no arguments asks the host for the time; `new Date(ms)` formats an
 * instant the caller passed in, and `now?: Date` names a type — both pure, both
 * present in `core/` today. The rest are flagged on the property access rather
 * than on the call, so that `const now = Date.now;` followed by `now()` two
 * lines later is not a way around the gate.
 *
 * `shadowed` is the same file-scoped exemption `BANNED` uses: a module that
 * declares its own `Date` or `performance` is talking about its own binding.
 */
function clockRead(node, shadowed) {
  if (
    ts.isNewExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'Date' &&
    !shadowed.has('Date') &&
    (node.arguments?.length ?? 0) === 0
  ) {
    return (
      'constructs `new Date()` with no argument — the host clock; construct from an ' +
      'explicit timestamp, or read the clock in src/features/'
    );
  }

  if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
    const name = `${node.expression.text}.${node.name.text}`;
    const why = CLOCK.get(name);
    if (why && !shadowed.has(node.expression.text)) return `reads \`${name}\` — ${why}`;
  }

  return null;
}

/** The module specifier of any import or export that names one. */
function specifierOf(node) {
  if (
    (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
    node.moduleSpecifier &&
    ts.isStringLiteral(node.moduleSpecifier)
  ) {
    return node.moduleSpecifier.text;
  }
  if (
    ts.isCallExpression(node) &&
    node.expression.kind === ts.SyntaxKind.ImportKeyword &&
    node.arguments.length &&
    ts.isStringLiteral(node.arguments[0])
  ) {
    return node.arguments[0].text;
  }
  return null;
}

const modules = readdirSync(dir, { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.ts'))
  .sort();

let references = 0;

for (const file of modules) {
  const absolute = resolve(dir, file);
  const text = readFileSync(absolute, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const shadowed = declaredNames(source);
  const lines = text.split('\n');

  const at = (node) => {
    const { line } = ts.getLineAndCharacterOfPosition(source, node.getStart(source));
    return { where: `src/core/${file}:${line + 1}`, text: (lines[line] ?? '').trim() };
  };

  const visit = (node) => {
    if (ts.isIdentifier(node) && !isName(node)) {
      references += 1;
      const why = BANNED.get(node.text);
      if (why && !shadowed.has(node.text)) {
        const { where, text: line } = at(node);
        errors.push(`${where} reads \`${node.text}\` — ${why}\n      ${line}`);
      }
    }

    const clock = clockRead(node, shadowed);
    if (clock) {
      const { where, text: line } = at(node);
      errors.push(`${where} ${clock}\n      ${line}`);
    }

    const specifier = specifierOf(node);
    if (specifier) {
      if (BUILTIN.test(specifier)) {
        const { where } = at(node);
        errors.push(`${where} imports \`${specifier}\` — a Node builtin; core also runs in the page`);
      } else if (specifier.startsWith('.')) {
        const target = relative(resolve(root, 'src'), resolve(dirname(absolute), specifier));
        const [top, ...rest] = target.split('/');
        const crossing = file === CROSSING.file && target.startsWith(CROSSING.prefix);
        if (IMPURE_DIRS.includes(top) && !crossing) {
          const { where } = at(node);
          errors.push(
            `${where} imports \`src/${top}/${rest.join('/')}\` — src/${top}/ is impure by design`,
          );
        }
      }
    }

    ts.forEachChild(node, visit);
  };

  visit(source);
}

if (errors.length) {
  console.error('src/core is not pure:\n');
  for (const error of errors) console.error(`  ✘ ${error}`);
  console.error(
    '\ncore/ is bundled into mcp-server/core.js and imported by a Node process\n' +
      'with no chrome object, no window and no DOM. A reference like this passes\n' +
      'the build and throws on the server’s first tool call that reaches it.\n' +
      'A clock or a random number does not throw there — it quietly makes the\n' +
      'same input give a different answer twice, which is worse to find.\n' +
      'Pass the capability in as an argument, or put it behind a provider in\n' +
      'src/features/. See ADR 0001 (.ctx/decisions/0001-src-core-stays-pure.md).',
  );
  process.exit(1);
}

console.log(`core: pure (${modules.length} modules, ${references} references)`);
