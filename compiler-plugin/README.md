# `@devflow/compiler-plugin`

A Babel plugin that writes, into each React component function, the file and line
it was defined in:

```js
function Cart() { … }
try { Cart.__devflow = { f: "src/Cart.tsx", l: 12 }; } catch {}
```

DevFlow reads that property back and reports the component's source exactly,
instead of searching the page's bundles for it.

## What this is for, and what it is not for

**It is for builds DevFlow cannot answer for.** DevFlow needs no plugin and no
app changes: it finds a component's source by searching the page's own bundles
and decoding their source maps, and that is the path it is built and tested
around. There are builds where that path cannot reach an answer, and this is for
those:

- **The bundle ships no source map** — the answer stops at a compiled position.
- **Source maps are hosted somewhere the browser will not fetch from**, so they
  cannot be read from the page at all.
- **The component's compiled code is genuinely ambiguous** — the same function
  body appears in more than one place, and DevFlow reports the first match with
  a sentence saying the path may be the wrong one.

**It is not the fix for poor attribution generally.** If DevFlow reports a
component as `not-found`, the usual cause is a lazy chunk the page never loaded,
and nothing here changes that: a chunk that did not load carries no stamp
either.

**Nothing in DevFlow requires it.** Every feature works with the plugin absent,
which is the point — the rule is written down in `ROADMAP_AND_PHASES.md` §1.1
and there is a test that fails if it stops being true.

What the plugin may not do is produce a *kind* of answer DevFlow could not: a
stamped attribution is the same shape with the same statuses, and there is no
field only the plugin can fill. In individual cases it does answer where DevFlow
alone cannot — the three builds listed above are exactly that, and it is the
whole reason this package exists. Saying otherwise would be a tidier sentence
and a false one.

Attributions that came from the stamp are labelled. `ComponentSource.via` is
`'plugin'`; the panel shows `build stamp` beside the path, and so does the MCP
server's `get_step_detail`, so no recording silently depends on this being
installed — whether a person or a model is reading it.

## Install

```sh
npm install --save-dev @devflow/compiler-plugin
```

### Vite

`@vitejs/plugin-react` accepts Babel plugins:

```js
// vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import devflow from '@devflow/compiler-plugin';

export default defineConfig({
  plugins: [react({ babel: { plugins: [devflow] } })],
});
```

### Anything else that runs Babel

Add `@devflow/compiler-plugin` to the `plugins` list of your Babel config.

## The gaps, named

**SWC builds are not covered.** `@vitejs/plugin-react-swc` and Next.js compile
with SWC, which takes no Babel plugin. There is no way to use this package with
either. An SWC port is a separate piece of work and does not exist; this serves
a real but partial audience, and saying otherwise would send people to a config
option that is not there.

**This package is ESM-only.** A CommonJS `babel.config.js` cannot `require()` it
— use `babel.config.mjs`, or pass the imported plugin inline as the Vite example
above does.

**Class components are not stamped.** `class Cart extends React.Component` is
skipped along with everything else that is not a function; adding it is a small
change and has not been made, because nothing in DevFlow has asked for it yet.

**Components defined below module scope are not stamped.** A component declared
inside a function body would need an assignment that re-runs on every call to
that function, and this plugin does not emit code on a hot path.

**Anonymous default exports are not stamped.** `export default () => …` binds no
name, so there is nothing to hang a property on. Give it a name.

## What is stamped

At module scope, when the name begins with a capital letter:

| Shape | Stamped |
| --- | --- |
| `function Cart() {}` | yes |
| `export function Cart() {}` | yes |
| `export default function Cart() {}` | yes |
| `const Cart = () => {}` | yes |
| `const Cart = function () {}` | yes |
| `const Cart = (() => {}) as React.FC` | yes |
| `const Cart = forwardRef((p, ref) => …)` | yes — written here |
| `const Cart = memo(() => …)`, `React.memo(…)` | yes — written here |
| `const Fast = memo(Cart)` | **no** — see below |
| `function helper() {}` | no — lowercase |
| `const CONFIG = {}` | no — not a function |
| `class Cart extends Component {}` | no — see the gaps |

**A wrapper is stamped only when the component is written inside it.**
`forwardRef((props, ref) => …)` binds no inner name, so the wrapper is the only
place the stamp can go and it truthfully names where that component was written.
`memo(Cart)` is different: if `Cart` is local it already carries its own, better
stamp, and if `Cart` is imported — `memo(SomeLibraryIcon)`, the common case —
the wrapper's stamp would name *your* file while React names the fiber after the
library's function. DevFlow would then report that library component as living
in your file, resolved and confident. So a wrapper around a name is left alone
and the answer falls through to the paths that can be right about it.

`f` is relative to the Babel `root` (your repo root, unless you pass a `root`
option), with POSIX separators. A file outside the root is skipped rather than
stamped with a machine path.

`l` is the line the binding begins on — for a `const`, its declarator's line,
which differs from the `const` keyword's only when a declaration is broken
across lines.

A capitalised `const` holding a plain function is stamped whether or not it is a
component — nothing at build time can tell `const Multiply = (a, b) => a * b`
from a component. The cost is a property on a function DevFlow will never look
at, which is why the rule is the permissive one.

## Options

| Option | Default | Meaning |
| --- | --- | --- |
| `includeInProduction` | `false` | Stamp production builds too. |
| `root` | Babel's `root` | The directory `f` is relative to. |

**Development builds only, by default.** A stamp puts the source layout of your
repository into the bundle, and shipping your directory tree to every visitor is
a decision to make deliberately rather than one to inherit from a dev
dependency. Production is detected from `BABEL_ENV` / `NODE_ENV`, which is what
`vite build` sets.

## What it does to your application

Nothing that renders. The stamp is one property assignment per component, at
module scope, evaluated once when the module is first imported. It touches no
JSX, so nothing reaches the DOM: no attribute in your markup, your DOM snapshot
tests, your CSS selectors or your accessibility tree. React never reads it.

**It is an ordinary enumerable own property, and that is worth knowing.** It
shows up in `Object.keys(Cart)` and in `{...Cart}`, and `hoist-non-react-statics`
copies it onto HOC wrappers — which is useful, and is the reason it is not
hidden. If you assert on a component's static shape, that assertion will see it.
Making it non-enumerable needs `Object.defineProperty`, which reads a global a
module can shadow; the same reasoning keeps the guard below a `try` rather than
an `Object.isExtensible` check.

The assignment is wrapped in a `try`, and that is not caution for its own sake.
A module is strict code, so assigning a new property to a frozen or sealed
object throws there rather than failing quietly — a wrapper of yours that hands
back a frozen object would otherwise take your development build down at import,
with a stack pointing at code you did not write. That component goes unstamped
instead, and the ones after it are unaffected.

The stamp lands on the value the module binds. For `forwardRef` and `memo` that
is the wrapper object rather than the function inside it, which is why DevFlow
reads the inner function's stamp first and the wrapper's second: `const Fast =
memo(Cart)` reports the line `Cart` was written on, because `Cart` carries its
own stamp and the wrapper carries none at all.
