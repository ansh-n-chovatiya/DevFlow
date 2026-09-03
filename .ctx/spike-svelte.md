# Spike: Svelte 5 runtime — what a DevFlow adapter can actually reach

Measurement spike. Every claim below is backed by output from a program that
actually ran. Anything not measured is listed under "What I could not measure".

## Verdict

1. **A Svelte adapter is NOT feasible on the React model in production builds.** There is no
   property, symbol, or global on a production Svelte 5 element that leads to its component
   function. Production elements have **zero own properties** — measured, not inferred.
2. **A dev-mode adapter is feasible and is *better* than the React model**: dev elements carry
   `__svelte_meta` with `{file, line, column}` plus a full component ancestry chain, so the
   needle/bundle/source-map engine is not even needed in dev.
3. **The single biggest obstacle is that DOM→component is dev-only.** The runtime *does* keep a
   component tree (the effect tree, with a `ctx` parent chain), but it is reachable only from
   *inside* a running component, never from a DOM node, and its `.function` back-reference is
   compiled out of production. The only production element→function edge is
   `element[Symbol('events')][eventName]`, which exists solely on elements bound to one of 23
   delegated events, and yields the *event handler*, not the component.

---

## What was actually run

Everything was built in
`/private/tmp/claude-502/.../scratchpad/spike-svelte/` — nothing was installed or built inside
the DevFlow repo.

Installed versions (printed from each package's own `package.json`):

```
svelte 5.57.0
vite 8.2.2
vite-plugin-svelte 7.3.0
@sveltejs/kit 2.70.3
@sveltejs/adapter-node 5.5.7
node v24.14.0
npm 11.9.0
```

Two apps, four running targets:

| target | app | mode | command | URL |
|---|---|---|---|---|
| `plain-dev` | Vite + Svelte 5 runes | dev | `npx vite --port 5199` | http://localhost:5199/ |
| `plain-prod` | same | prod | `npx vite build` then `npx http-server -p 5200 dist` | http://localhost:5200/ |
| `kit-dev` | SvelteKit (adapter-node, SSR) | dev | `npx vite dev --port 5201` | http://localhost:5201/ |
| `kit-prod` | same | prod | `npx vite build` then `npx vite preview --port 5202` | http://localhost:5202/ |

Component graph in the plain app: `App.svelte` → `Counter.svelte`, `App.svelte` →
`DeepChild.svelte` → `GrandChild.svelte`. SvelteKit app: `+layout.svelte` → `+page.svelte` →
`$lib/KitCounter.svelte`.

Browser: Playwright `chromium` from `~/.npm/_npx/e41f203b7505f1fb/node_modules/playwright`,
`chromium-1234` from `~/Library/Caches/ms-playwright`. Probe scripts `probe.mjs` … `probe8.mjs`
in the scratchpad drive the page and print `page.evaluate` results to stdout.

**Headed vs headless was checked, not assumed.** Every measurement here is of a JS object graph,
not of rendering, and the two agree:

```
$ node headed.mjs http://localhost:5200/     # prod
headless=true  {"ownProps":[],"symbols":["Symbol(events)"],"svelteGlobal":["5"],"metaPresent":false}
headless=false {"ownProps":[],"symbols":["Symbol(events)"],"svelteGlobal":["5"],"metaPresent":false}
$ node headed.mjs http://localhost:5199/     # dev
headless=true  {"ownProps":["__svelte_meta"],"symbols":["Symbol(events)"],"svelteGlobal":["5"],"metaPresent":true}
headless=false {"ownProps":["__svelte_meta"],"symbols":["Symbol(events)"],"svelteGlobal":["5"],"metaPresent":true}
```

---

## Findings

### 1. DOM → component

**Dev (plain):** every element rendered by a component gets exactly one own property,
`__svelte_meta`. Elements bound to a delegated event additionally carry `Symbol(events)`.

```
===== plain-dev :: Q1 DOM->component: own + symbol props on real elements =====
  { "sel": "#app-heading",     "tag": "H1",     "ownCount": 1, "extraOwn": ["__svelte_meta"], "symbols": [] }
  { "sel": "#counter-value",   "tag": "SPAN",   "ownCount": 1, "extraOwn": ["__svelte_meta"], "symbols": [] }
  { "sel": "#counter-button",  "tag": "BUTTON", "ownCount": 1, "extraOwn": ["__svelte_meta"],
    "symbols": [ { "sym": "Symbol(events)", "valueType": "object", "preview": "[\"click\"]" } ] }
  { "sel": "#grand-child-em",  "tag": "EM",     "ownCount": 1, "extraOwn": ["__svelte_meta"], "symbols": [] }
  { "sel": "#app-main",        "tag": "MAIN",   "ownCount": 1, "extraOwn": ["__svelte_meta"], "symbols": [] }
  { "sel": "body",             "tag": "BODY",   "ownCount": 0, "extraOwn": [],                "symbols": [] }
```

**Production (plain):** every element has **zero own properties**. Only the two delegated-event
buttons carry anything at all, and it is `Symbol(events)`.

```
===== plain-prod :: Q1 DOM->component: own + symbol props on real elements =====
  { "sel": "#app-heading",    "tag": "H1",     "ownCount": 0, "extraOwn": [], "symbols": [] }
  { "sel": "#counter-value",  "tag": "SPAN",   "ownCount": 0, "extraOwn": [], "symbols": [] }
  { "sel": "#counter-button", "tag": "BUTTON", "ownCount": 0, "extraOwn": [],
    "symbols": [ { "sym": "Symbol(events)", "valueType": "object", "preview": "[\"click\"]" } ] }
  { "sel": "#grand-child-em", "tag": "EM",     "ownCount": 0, "extraOwn": [], "symbols": [] }
  { "sel": "#app-main",       "tag": "MAIN",   "ownCount": 0, "extraOwn": [], "symbols": [] }
```

**SvelteKit production:** the same — 2 of 22 elements carry anything, and it is only
`Symbol(events)`:

```
===== kit-prod :: Q1: every element with own props / symbols, after hydration =====
{ "withProps": 2, "total": 22,
  "res": [ { "selector": "#kit-button",         "own": [], "symbols": [ { "sym": "Symbol(events)", "keys": ["click"] } ] },
           { "selector": "#kit-counter-button", "own": [], "symbols": [ { "sym": "Symbol(events)", "keys": ["click"] } ] } ] }
```

I also swept for any *global* element→component map. There is none. In `plain-prod` the complete
set of non-builtin `window` keys (diffed against a fresh same-origin iframe's `window`) is:

```
"__ALL_NON_BUILTIN_WINDOW_KEYS__": [ "0", "__svelte", "__SPIKE_MOUNT_RESULT__", "__SPIKE_APP_CTOR__" ]
```

(`__SPIKE_*` are my own test hooks, not something a real app has.)

**Answer: in production there is nothing. The honest answer is "no path exists."** In dev the
answer is better than React's: `__svelte_meta` is the file and line directly.

#### The one production edge: `Symbol(events)`

`element[Symbol('events')][name]` holds the real handler function. Measured in dev and prod:

```
===== plain-dev :: Symbol(events) handler functions on elements =====
[ { "selector": "#app-button",     "event": "click", "fnName": "click",
    "fnToString": "function click() {\n\t\treturn $.update(clicks);\n\t}" },
  { "selector": "#counter-button", "event": "click", "fnName": "incrementTheCounterByOne",
    "fnToString": "function incrementTheCounterByOne() {\n\t\t$.set(count, $.get(count) + 1);\n\t}" } ]

===== plain-prod :: Symbol(events) handler functions on elements =====
[ { "selector": "#app-button",     "event": "click", "fnName": "",  "fnToStringLen": 9,  "fnToString": "()=>wn(t)" },
  { "selector": "#counter-button", "event": "click", "fnName": "i", "fnToStringLen": 25, "fnToString": "function i(){C(n,$(n)+1)}" } ]
```

Its reach is narrow, and I measured the boundary rather than guessing it. Svelte delegates
exactly 23 events (`src/utils.js`, `DELEGATED_EVENTS`: `beforeinput, click, change, dblclick,
contextmenu, focusin, focusout, input, keydown, keyup, mousedown, mousemove, mouseout, mouseover,
mouseup, pointerdown, pointermove, pointerout, pointerover, pointerup, touchend, touchmove,
touchstart`). I added a `<div onmouseenter={…}>` (not in the list) and a bare `<div>` and measured:

```
===== plain-prod :: delegated vs NON-delegated vs no-handler =====
{ "app-button":      { "ownProps": [], "symbols": ["Symbol(events)"],
                       "delegatedHandlers": { "click": { "name": "", "src": "()=>wn(t)" } }, "reachableFunction": true },
  "mouseenter-div":  { "ownProps": [], "symbols": [], "delegatedHandlers": null, "reachableFunction": false },
  "no-handler-div":  { "ownProps": [], "symbols": [], "delegatedHandlers": null, "reachableFunction": false },
  "app-heading":     { "ownProps": [], "symbols": [], "delegatedHandlers": null, "reachableFunction": false },
  "counter-button":  { "ownProps": [], "symbols": ["Symbol(events)"],
                       "delegatedHandlers": { "click": { "name": "i", "src": "function i(){C(n,$(n)+1)}" } }, "reachableFunction": true } }
```

A non-delegated event leaves **nothing** on the element — it goes through `addEventListener`,
which is invisible to page script.

### 2. Is there a tree at all?

**Yes — but not one you can enter from a DOM node.** I measured this three ways.

**(a) What the compiler emits.** Fetched straight from the dev server
(`curl http://localhost:5199/src/lib/Counter.svelte`):

```js
Counter[$.FILENAME] = 'src/lib/Counter.svelte';

var root = $.add_locations($.from_html(`<section id="counter-section">…</section>`),
                           Counter[$.FILENAME], [[8, 0, [[9, 2], [10, 2], [11, 2]]]]);

function Counter($$anchor, $$props) {
	$.check_target(new.target);
	$.push($$props, true, Counter);

	let start = $.prop($$props, 'start', 3, 0);
	let count = $.tag($.state($.proxy(start())), 'count');
	let counterName = 'CounterInstanceName';

	function incrementTheCounterByOne() { $.set(count, $.get(count) + 1); }

	var $$exports = { ...$.legacy_api() };
	var section = root();
	…
	$.delegated('click', button, incrementTheCounterByOne);
	$.append($$anchor, section);

	return $.pop($$exports);
}

if (import.meta.hot) { Counter = $.hmr(Counter); … }
export default Counter;
$.delegate(['click']);
```

The real internal names are `$.push` / `$.pop` (confirmed — not guessed), plus
`$.add_locations`, `$.add_svelte_meta`, `$.check_target`, `$.tag`, `$.delegated`, `$.FILENAME`.

**(b) What `push`/`pop` leave behind** (`node_modules/svelte/src/internal/client/context.js`):

```js
export function push(props, runes = false, fn) {
	component_context = { p: component_context, i: false, c: null, e: null,
	                      s: props, x: null, r: active_effect,
	                      l: legacy_mode_flag && !runes ? { s: null, u: null, $: [] } : null };
	if (DEV) { component_context.function = fn; dev_current_component_function = fn; }
}

export function pop(component) {
	var context = component_context;
	…
	component_context = context.p;          //  <-- restored to the parent
	if (DEV) { dev_current_component_function = component_context?.function ?? null; }
	return mark_as_component(component);
}
```

`component_context` is a module-scoped cursor with a `p` parent pointer, unwound on `pop`. Note
`.function` — the component function back-reference — is inside `if (DEV)`.

Confirmed empirically that the cursor is spent after mount. From the running dev page I imported
the internals module the dev server serves and read the live bindings:

```
===== plain-dev :: component_context after mount (imported svelte internals live binding) =====
{ "importedFrom": "http://localhost:5199/node_modules/.vite/deps/svelte_internal_client.js?v=f0443e45",
  "active_effect_after_mount": "null",
  "exportSample": [ "active_effect", "add_locations", "add_svelte_meta", …, "pop", "push", "state", "tag", … ] }
```

**(c) The tree that *does* persist: the effect tree.** `create_effect`
(`reactivity/effects.js`) captures `ctx: component_context` unconditionally, and
`effect.component_function = dev_current_component_function` under `if (DEV)`. To observe it I
instrumented `GrandChild.svelte` with an `$effect` that stashes `active_effect` on `window`
(routed through a plain `.js` module — see "What I could not measure" — the Svelte compiler
*rejects* `import … from 'svelte/internal/*'` inside a `.svelte` file with
`import_svelte_internal_forbidden`). Observed:

```
===== plain-dev :: A live Effect node captured from inside a real component =====
{ "effectOwnKeys": [ "ctx","deps","nodes","f","first","fn","last","next","parent","b","prev",
                     "teardown","wv","ac","component_function" ],
  "hasCtx": true, "ctxIsNull": false,
  "ctxKeys": [ "p","i","c","e","s","x","r","l","function" ],
  "hasParentEffect": true }

===== plain-dev :: Walk the component_context chain UP from that effect =====
[ { "depth": 1, "fnName": "wrapper", "fnFilenameSymbol": "Symbol(filename),Symbol(hmr)", "filename": "src/lib/GrandChild.svelte" },
  { "depth": 2, "fnName": "wrapper", "fnFilenameSymbol": "Symbol(filename),Symbol(hmr)", "filename": "src/lib/DeepChild.svelte" },
  { "depth": 3, "fnName": "wrapper", "fnFilenameSymbol": "Symbol(filename),Symbol(hmr)", "filename": "src/App.svelte" },
  { "depth": 4, "fnName": null, "filename": null } ]
```

That is a genuine component tree with filenames. Walking the effect tree *down* from the root
shows it also spans the DOM:

```
===== plain-dev :: Walk the EFFECT tree UP to root, and DOWN from root =====
"downFromRoot": [
  { "depth": 3, "componentFn": null,      "hasNodes": true,  "nodeStart": "MAIN#app-main" },
  { "depth": 5, "componentFn": "wrapper", "hasNodes": true,  "nodeStart": "SECTION#counter-section" },
  { "depth": 5, "componentFn": "wrapper", "hasNodes": true,  "nodeStart": "DIV#deep-child" },
  { "depth": 7, "componentFn": "wrapper", "hasNodes": true,  "nodeStart": "EM#grand-child-em" },
  { "depth": 8, "componentFn": "wrapper", "hasNodes": true,  "nodeStart": "EM#grand-child-em" } ]

===== plain-dev :: Does the root effect reference DOM nodes? (effect -> DOM is one-way) =====
[ { "depth": 3, "start": "MAIN",    "end": "MAIN",    "startId": "app-main" },
  { "depth": 5, "start": "SECTION", "end": "SECTION", "startId": "counter-section" }, … ]
```

**The edge is one-way.** Effects point at DOM (`nodes.start` / `nodes.end`); DOM points at
nothing. Confirmed by an exhaustive 4-deep object-graph crawl outward from an element:

```
===== plain-dev :: Can a component STATE signal be reached from the DOM? =====
{ "signalsReachableFromElement": [], "count": 0 }
```

And in production the tree survives but is anonymous — `ctx` is kept, the DEV fields are gone.
Grepped the production bundle:

```
component_function       0
ctx:                     1
dev_current              0
```

### 3. The devtools hook

**There is no devtools hook.** Svelte 5 registers exactly one global, and it is a version
disclosure, not a hook. The complete set of `window.__*` registrations in the entire Svelte
source tree:

```
$ grep -rn "window\.__\|globalThis\.__" src/
src/internal/disclose-version.js:5:  ((window.__svelte ??= {}).v ??= new Set()).add(PUBLIC_VERSION);
src/internal/server/renderer.js:916:  let prelude = `const h = (window.__svelte ??= {}).h ??= new Map();`;
src/internal/client/hydratable.js:19: const store = window.__svelte?.h;
src/internal/client/dom/template.js:397: (window.__svelte ??= {}).uid ??= 1;
```

`grep -rni devtool src/` returns only three unrelated code comments (about the CSS panel and
transition timing) — no integration point.

Measured in all four running targets:

```
$ node gv.mjs http://localhost:5199/ plain-dev
plain-dev  {"present":true,"keys":["v"],"v_type":"Set","v_contents":["5"],"isDevtoolsHookShaped":false}
$ node gv.mjs http://localhost:5200/ plain-prod
plain-prod {"present":true,"keys":["v"],"v_type":"Set","v_contents":["5"],"isDevtoolsHookShaped":false}
$ node gv.mjs http://localhost:5201/ kit-dev
kit-dev    {"present":true,"keys":["v"],"v_type":"Set","v_contents":["5"],"isDevtoolsHookShaped":false}
$ node gv.mjs http://localhost:5202/ kit-prod
kit-prod   {"present":true,"keys":["v"],"v_type":"Set","v_contents":["5"],"isDevtoolsHookShaped":false}
```

I probed the obvious candidate names explicitly. All absent, in dev *and* prod:

```
===== plain-dev :: Q3 devtools hook: enumerate known candidate globals =====
{ "__svelte": { "type": "object", "detail": { "v": "object keys=[]" } },
  "__SVELTE__": "ABSENT", "__svelte__": "ABSENT",
  "__SVELTE_DEVTOOLS_GLOBAL_HOOK__": "ABSENT", "__svelte_devtools_global_hook__": "ABSENT",
  "__SVELTE_HMR": "ABSENT", "__sveltekit": "ABSENT", "__SVELTE_DEVTOOLS__": "ABSENT" }
```

**Real global names observed: `window.__svelte`, and its only key is `v`, a `Set(["5"])`.**
This is useful for exactly one thing — *framework detection*, in both dev and prod. It carries no
component information whatsoever. (SvelteKit adds `__sveltekit_dev` / `__sveltekit_<hash>` with
`{base, env}`, plus ~17 `__SVELTEKIT_*` build-flag constants — also no component information.)

### 4. The function

**Dev: yes, and it is fully identified.** The exported component is wrapped for HMR; the real
function is one hop behind `Symbol(hmr)`:

```
===== plain-dev :: Q4 =====
"appCtor": { "type": "function", "name": "wrapper", "length": 2,
  "toStringFirst200": "function wrapper(initial_anchor, props) {\n\t\tlet component = {};\n…",
  "symbols": [ "Symbol(filename)", "Symbol(hmr)" ] }

===== plain-dev :: DEEP: try unwrap HMR to the true component fn =====
{ "filename": "src/App.svelte",
  "hmrKeys": [ "fn", "current", "update" ],
  "current.v": { "type": "function", "name": "App", "totalLen": 1086,
                 "syms": [ "Symbol(filename)" ] },
  "current.v.Symbol(filename)": "src/App.svelte" }
```

Full dev `toString()` (length 1086):

```js
function App($$anchor, $$props) {
	$.check_target(new.target);
	$.push($$props, true, App);

	let title = 'Spike App Title';
	let clicks = $.tag($.state(0), 'clicks');
	const doubled = $.tag($.derived(() => $.get(clicks) * 2), 'doubled');
	var $$exports = { ...$.legacy_api() };
	var main = root();
	var h1 = $.child(main);
	h1.textContent = 'Spike App Title';
	…
	$.add_svelte_meta(() => Counter(node, { start: 5 }), 'component', App, 13, 2, { componentTag: 'Counter' });
```

**Production: the function still exists and `toString()` still works — but only if you already
have a reference to it.** I only had one because `src/main.js` stashed it on `window`; a real app
has no such handle.

```
===== plain-prod :: Q4 =====
"appCtor": { "type": "function", "name": "$r", "length": 1, "toStringLen": 307,
  "ownProps": [ "length", "name", "prototype" ], "symbols": [] }
```

```js
function $r(e){let t=q(0);const r=cn(()=>k(t)*2);var n=_i(),i=ze(n);i.textContent="Spike App Title";
var s=re(i,2),a=nt(s),o=re(s,2),c=nt(o),v=re(o,2);fi(v,{start:5});var y=re(v,2);vi(y,{label:"deep"}),
Fe(n),_t(()=>{st(a,`doubled=${k(r)??""}`),st(c,`App click ${k(t)??""}`)}),mr("click",o,()=>mn(t)),Ae(e,n)}
```

Note `symbols: []` — `Symbol(filename)` is gone in prod.

#### Bundle grep — it hits

I took the production `App` function's `toString()` and searched the served bundle with
DevFlow-style head/body needles.

```
$ node grep-bundle.mjs appctor-plain-prod.txt plain/dist/assets/index-DTbf6477.js
fn source length = 307
bundle length = 38986

--- HEAD needle (first 120 chars) ---
"function $r(e){let t=q(0);const r=cn(()=>k(t)*2);var n=_i(),i=ze(n);i.textContent=\"Spike App Title\";var s=re(i,2),a=nt(s"
HEAD hit index = 38505 FOUND

--- BODY needle (60 chars @ offset 153) ---
"v,{start:5});var y=re(v,2);vi(y,{label:\"deep\"}),Fe(n),_t(()="
BODY hit index = 38658 FOUND
unique? occurrences of BODY = 1

FULL fn source hit index = 38505 FOUND

bundle position of fn start: line 2 (1-based), column 7168 (0-based)

DECODED SOURCE LOCATION for fn start: {
  "genLine": 2, "genCol": 7168,
  "source": "../../src/App.svelte", "srcLine": 1, "srcCol": 0, "name": null }
```

**Byte-for-byte hit, unique, and the source map resolves it to `src/App.svelte`.** The same works
from the one production-reachable handler, and lands on the correct line:

```
$ node grep-bundle.mjs counter-handler-plain-prod.txt plain/dist/assets/index-DTbf6477.js
--- HEAD needle --- "function i(){I(n,k(n)+1)}"
HEAD hit index = 37811 FOUND
unique? occurrences of BODY = 1
DECODED SOURCE LOCATION for fn start: {
  "source": "../../src/lib/Counter.svelte", "srcLine": 5, "srcCol": 2 }
```

`Counter.svelte` line 5 is exactly where `incrementTheCounterByOne` is written. And in SvelteKit
production, against its own route chunk:

```
$ node grep-bundle.mjs kit-counter-handler.txt kit/.svelte-kit/output/client/_app/immutable/nodes/2.D-wtbrBO.js
fn source length = 25 / bundle length = 833
--- HEAD needle --- "function v(){a(_,l(_)+1)}"
HEAD hit index = 353 FOUND
unique? occurrences of BODY = 1
DECODED SOURCE LOCATION for fn start: {
  "source": "../../../../../../src/lib/KitCounter.svelte", "srcLine": 4, "srcCol": 2 }
```

`KitCounter.svelte` line 4 — correct. **The needle → bundle-search → source-map half of DevFlow
works on Svelte unchanged.** The problem is exclusively the first half.

One caution the numbers make plain: production handler needles are *tiny*. `()=>wn(t)` is
**9 characters**, below DevFlow's `MIN_NEEDLE_LEN = 12` (`src/shared/constants.ts:349`), so
DevFlow would correctly reject it as `too-short`. `function i(){C(n,$(n)+1)}` is 25 characters —
unique in a 39 KB bundle, but that is not evidence it would be unique in a real one.

### 5. Source location

**Dev leaves an excellent breadcrumb: `__svelte_meta`.** It is written by
`$.add_locations(...)` (see the emitted code in Finding 2) via
`internal/client/dev/elements.js`:

```js
function assign_location(element, filename, location) {
	element.__svelte_meta = {
		parent: dev_stack,
		loc: { file: filename, line: location[0], column: location[1] }
	};
	if (location[2]) assign_locations(element.firstChild, filename, location[2]);
}
```

Measured on every element in the running dev app — note `parent` is a full ancestry chain with
`componentTag`:

```
===== plain-dev :: DEEP: __svelte_meta full contents =====
#app-main        {"parent":null,"loc":{"file":"src/App.svelte","line":9,"column":0}}
#app-heading     {"parent":null,"loc":{"file":"src/App.svelte","line":10,"column":2}}
#app-button      {"parent":null,"loc":{"file":"src/App.svelte","line":12,"column":2}}
#counter-section {"parent":{"type":"component","file":"src/App.svelte","line":13,"column":2,
                            "parent":null,"componentTag":"Counter"},
                  "loc":{"file":"src/lib/Counter.svelte","line":8,"column":0}}
#counter-button  {"parent":{"type":"component","file":"src/App.svelte","line":13,"column":2,
                            "parent":null,"componentTag":"Counter"},
                  "loc":{"file":"src/lib/Counter.svelte","line":11,"column":2}}
#grand-child-em  {"parent":{"type":"component","file":"src/lib/DeepChild.svelte","line":8,"column":2,
                            "parent":{"type":"component","file":"src/App.svelte","line":14,"column":2,
                                      "parent":null,"componentTag":"DeepChild"},
                            "componentTag":"GrandChild"},
                  "loc":{"file":"src/lib/GrandChild.svelte","line":4,"column":0}}
```

That is file + line + column for the element *and* the full component call chain that produced
it — strictly more than React's `_debugSource` gives.

**Production leaves nothing.** Audit of the production bundle
(`plain/dist/assets/index-wkcOVnSl.js`), counts are `grep -c`:

```
=== prod bundle dev-breadcrumb audit ===
__svelte_meta        0
add_locations        0
add_svelte_meta      0
componentTag         0
check_target         0
legacy_api           0
component_function   0
dev_stack            0
.label               2
FILENAME             0
.svelte              2
```

The two `.label` and two `.svelte` hits are not breadcrumbs — I checked each in context:

```
=== context of '.label' hits ===
…function $t(e,t){return e.label=t,en(e.v,t),e}…          <- tree-shaken-in body of tag(), never called
…ht(()=>ri(r,"data-label",t.label))…                       <- my own data-label attribute
=== context of '.svelte' hits ===
(none)     # the matches are the CSS scope class `svelte-1n46o8q`, not a filename
```

Confirmed in the running production page, on every element:

```
===== kit-prod :: Q5: __svelte_meta on every element =====
{ "count": 0, "r": [] }
```

**Precisely what is dev-only:** `__svelte_meta` (and its whole `add_locations` machinery),
`Symbol(filename)` / `$.FILENAME` on component functions, `Symbol(hmr)`, `componentTag`,
`component_context.function`, `effect.component_function`, `$.check_target`, and the `$.tag(...)`
signal labels. All of it is gated behind `if (DEV)` / `import.meta.hot` and vanishes.

**A near-miss worth recording:** the scoped-style hash class *does* survive to production —

```
===== plain-prod :: svelte-<hash> scope classes in the DOM =====
{ "count": 1, "totalElements": 21, "r": [ { "sel": "#app-main", "classes": ["svelte-1n46o8q"] } ] }
===== plain-dev :: svelte-<hash> scope classes in the DOM =====
{ "count": 6, "totalElements": 22, "r": [ {"sel":"#app-main"}, {"sel":"#app-heading"}, {"sel":"#app-doubled"},
                                          {"sel":"#app-button"}, {"sel":"#no-handler-div"}, {"sel":"#mouseenter-div"} ] }
```

It is not usable as component identity: it only exists on components that have a `<style>` block
(`Counter`, `DeepChild`, `GrandChild` have none and carry no class at all), the hash is derived
from CSS content rather than the filename, and prod prunes it from 6 elements to 1.

### 6. Runes and signals

Reactive state is plain objects with a fixed shape. Created one through the internals module in
the live dev page:

```
===== plain-dev :: REAL signal object: create one via internals and print its shape =====
{ "ownKeys": [ "f", "v", "reactions", "equals", "rv", "wv", "label" ],
  "symbols": [],
  "dump": { "f": 0, "v": 42, "reactions": null, "equals": "[fn equals$1]",
            "rv": 0, "wv": 0, "label": "myLabelledSignal" } }
```

And here are *real* component state signals, harvested by walking `deps` across the whole effect
tree of the running app:

```
===== plain-dev :: REAL component state signals found by walking the effect tree =====
{ "signalCount": 7, "signals": [
  { "ownKeys": ["f","v","reactions","equals","rv","wv"], "label": null,
    "value": "function App($$anchor, $$props) {\n\t$.check_target(new.target", "ownerComponentFile": null },
  { "ownKeys": ["f","v","reactions","equals","rv","wv"], "label": null,
    "value": "function Counter($$anchor, $$props) {…", "ownerComponentFile": "src/App.svelte" },
  { "ownKeys": ["f","v","reactions","equals","rv","wv","label"], "label": "count", "value": "5",
    "reactionCount": 1, "ownerComponentFile": "src/lib/Counter.svelte" },
  { "ownKeys": ["f","v","reactions","equals","rv","wv"], "label": null,
    "value": "function DeepChild($$anchor, $$props) {…", "ownerComponentFile": "src/App.svelte" },
  … ] }
```

**In dev, state IS identifiable by name.** `count` is labelled `"count"` and attributed to
`src/lib/Counter.svelte`, because the compiler emits `$.tag($.state(...), 'count')`. The naming
comes from `internal/client/dev/tracing.js`:

```js
export function tag(source, label) { source.label = label; tag_proxy(source.v, label); return source; }
```

**In production it is anonymous.** `$.tag(...)` calls are not emitted (`add_locations`/`tag`
call-sites are dev-only; the `tag` function body survives tree-shaking but is never invoked), so
signals carry no `label` key at all — they are `{f, v, reactions, equals, rv, wv}` and nothing
more.

Either way this is moot for the adapter: signals are not reachable from a DOM element in either
mode (Finding 1's crawl returned `count: 0`), only from inside a component.

### 7. SvelteKit differences

**Everything in Findings 1–6 holds identically for SvelteKit.** The differences that matter:

**(a) SSR + hydration.** The server ships fully-rendered HTML with hydration comment markers, and
the client hydrates it rather than mounting fresh. Raw response body from `kit-prod`:

```html
<body data-sveltekit-preload-data="hover"><div><!--[--><!--[0--><!--[--><div id="kit-layout">
<span id="kit-layout-span">kit-layout-unique-marker-5512</span><!--[--><main id="kit-main">
<h1 id="kit-heading">Kit Page Title</h1> <button id="kit-button">kit click 0</button>
<section id="kit-counter"><span id="kit-counter-value">3</span>
<button id="kit-counter-button">inc</button></section><!----></main><!--]--><!----></div>
<!--]--><!--]--> <!--[-1--><!--]--><!--]-->
```

```
===== kit-prod :: Q7: hydration markers present in DOM? =====
{ "commentCount": 13, "comments": ["\"[\"","\"[0\"","\"[\"","\"[\"","\"\"","\"]\"","\"\"","\"]\"",
                                   "\"]\"","\"[-1\"","\"\"","\"]\"","\"]\""] }
```

These 13 comment nodes are the only structural trace of component boundaries in production HTML.
They are unlabelled — `[`, `]`, `[0`, `[-1` — so they delimit *blocks*, not named components.
**Practical consequence:** a Svelte adapter must tolerate an element existing in the DOM *before*
hydration has attached anything to it. Server HTML has no `Symbol(events)` and no
`__svelte_meta`; both appear only after the client bundle runs. An adapter must wait for
hydration or report "not yet hydrated".

**(b) The dev ancestry chain runs through generated framework files.** SvelteKit dev
`__svelte_meta` is just as rich, but the parent chain passes through synthetic components:

```
===== kit-dev :: Q1 =====
#kit-counter-button  {"parent":{"type":"component","file":"src/routes/+page.svelte","line":9,"column":2,
                      "parent":{"type":"component","file":".svelte-kit/generated/root.svelte","line":52,"column":10,
                        "parent":{"type":"render","file":"src/routes/+layout.svelte","line":5,"column":69,
                          "parent":{"type":"component","file":".svelte-kit/generated/root.svelte","line":50,"column":7,
                            "parent":{"type":"if","file":".svelte-kit/generated/root.svelte","line":47,"column":0,
                                      "parent":null},
                            "componentTag":"Pyramid_0"}},
                        "componentTag":"Pyramid_1"},
                      "componentTag":"KitCounter"},
                     "loc":{"file":"src/lib/KitCounter.svelte","line":8,"column":2}}
```

An adapter must filter `.svelte-kit/generated/*` frames and the synthetic `Pyramid_N` tags, and
must handle non-component `type` values — `"component"`, `"if"`, and `"render"` all appear above.
`#svelte-announcer` is a framework-injected element whose `loc` is inside generated code.

**(c) Per-route chunks export the component.** Kit production chunks end
`…export{y as component};`, and `grep -rl` located the `KitCounter` handler in exactly one
chunk (`nodes/2.D-wtbrBO.js`, 833 bytes). Route code-splitting means the adapter must search
*several* chunks, not one bundle — but it also means the search space per chunk is small.

**(d) SvelteKit's default production build ships NO source maps at all.** This is the operational
landmine. Measured by building twice, once with and once without `build.sourcemap`:

```
=== SvelteKit DEFAULT (no build.sourcemap): client .map files ===
0
=== sourceMappingURL in default-build chunk ===
-- 0.DkyF5aUr.js
out-unique-marker-5512`;var u=t(l);i(u,()=>s.children),n(c),a(r,c)}export{s as component};
-- 2.D-wtbrBO.js
kit click ${l(a)??``}`)),u(`click`,m,()=>e(a)),h(n,c)}m([`click`]);export{y as component};
=== restore sourcemap:true config and rebuild ===
8
```

Zero `.map` files and no `sourceMappingURL` comment by default; 8 maps once `build.sourcemap:
true` is set. Every production result in Finding 4 depended on the app having opted in.

---

## What I could not measure

- **Whether the `Symbol(events)` handler needle stays unique in a real, large application.** Both
  handlers were unique in my bundles, but those bundles are 39 KB (plain) and 833 bytes (Kit
  route chunk). `()=>wn(t)` at 9 characters is the kind of string that will collide many times
  over in a 2 MB bundle. Not measured; would need a real app.
- **Whether the effect tree can be entered from page script without cooperation from the app.** I
  reached `active_effect` only by adding an `$effect` to my own component that imported
  `svelte/internal/client` through a `.js` shim. A content script injected into someone else's
  page has no such foothold, and Svelte actively blocks the direct route — the compiler rejects
  `import … from 'svelte/internal/*'` inside a `.svelte` file:
  `` `Imports of `svelte/internal/*` are forbidden. It contains private runtime code which is
  subject to change without notice.` `` I did not find a way in from outside, and I did not
  exhaustively prove none exists.
- **Any third-party Svelte DevTools browser extension.** I measured what the *framework*
  registers (nothing but `window.__svelte = {v: Set(["5"])}`). I did not install the community
  Svelte DevTools extension, so I cannot say whether it injects a hook of its own or how it works.
  Finding 3 is a statement about Svelte, not about the extension ecosystem.
- **Svelte 4 and the legacy (non-runes) compiler.** Everything here is Svelte 5.57.0 in runes
  mode. Svelte 4 had real component class instances and would likely behave very differently.
  Not measured at all.
- **Other bundlers and minifiers.** Only Vite 8.2.2 (rolldown) with `minify: 'esbuild'` for the
  plain app and SvelteKit's default for Kit. Terser, SWC, Rollup-without-Vite, webpack and
  `vite-plugin-svelte`'s other options were not tried. Minifier choice directly determines needle
  shape, so this could matter.
- **Vite 8 is very new.** Most real Svelte apps today are on Vite 5–7. I did not verify that
  their output is byte-similar; the general dev/prod split almost certainly holds, but the exact
  emitted helper names were only observed under this toolchain.
- **`{#each}`, `{#if}`, `<svelte:component>`, slots/snippets, `<svelte:element>`, custom
  elements, and `@html`.** My apps used plain nesting and props only. Block-level constructs
  create additional effect types and, per `dom/blocks/svelte-element.js:78` and
  `dom/blocks/html.js:32`, do their own `__svelte_meta` handling that I never exercised.
- **Whether a page with multiple independent Svelte roots, or Svelte embedded in a non-Svelte
  host page, changes any of this.** Single-root apps only.
- **Real minified SvelteKit source maps for anything but the happy path.** I decoded exactly
  three positions. My VLQ decoder in `grep-bundle.mjs` is a from-scratch ~30-line implementation
  written for this spike; it agreed with expectations three times, which is not the same as being
  correct.
- **`hydratable` / `window.__svelte.h`.** `internal/client/hydratable.js` reads `window.__svelte?.h`
  and the server renderer writes it. My apps never populated it and I did not investigate what it
  holds.

---

## Consequences for the adapter contract

### Can DevFlow's existing engine be reused? Yes, entirely.

`src/core/react/search.ts` (`searchBundle(content, needle)`), `src/core/react/sourcemap.ts`
(`extractSourceMappingURL`, `parseSourceMap`, `lookupOriginal`), `needle.ts` and `vlq.ts` take
strings and needles, not fibers. They are already framework-neutral in signature and were proven
against real Svelte output three times above. Nothing in them needs to change; they should be
**moved out of `src/core/react/` into a shared `src/core/resolve/`**, because their current
location is now the only thing that makes them look React-specific.

The React-specific part that must be abstracted is exactly `src/core/react/fiber.ts` —
`getFiber` / `getComponentFn` / `getDisplayName` / `getDebugSource` / `collectChain`.

### The shape a `FrameworkAdapter` must have

The React adapter's implicit contract is *"element → component function; the engine does the
rest."* **Svelte cannot satisfy that contract, and forcing it to would be the mistake here.**
Svelte's best answer (`__svelte_meta`) skips the engine entirely, and its production answer isn't
a component function at all.

So the interface must be a *result* type, not a function type — an adapter returns a located
source, and says how it got there:

```ts
type Resolution =
  | { kind: 'direct';   file: string; line: number; column: number }   // Svelte dev: __svelte_meta
  | { kind: 'needle';   fn: Function; displayName: string }            // React: fiber -> fn -> engine
  | { kind: 'none';     reason: 'not-hydrated' | 'no-runtime-metadata' | 'production-build' };
```

Three consequences fall out of the measurements:

1. **`kind: 'direct'` must exist.** Svelte dev gives file/line/column with no bundle search, and
   with a *better* ancestry chain than React's. An interface that only accepts a function would
   throw away the single best thing Svelte offers. (React would benefit too — `getDebugSource`
   in `fiber.ts:185` is already a `direct` result wearing a fiber costume.)
2. **`kind: 'none'` must be a first-class, explainable outcome, not a silent miss.** This is the
   normal case for Svelte production, and DevFlow already has the right instinct here — the
   `NeedleRejection` type in `needle.ts` exists precisely so a component can carry a *sentence*
   instead of a blank. Svelte needs the same at the adapter layer: "this element was rendered by
   a Svelte component, but production builds keep no runtime link from DOM to source."
   `not-hydrated` must be distinguishable from `no-runtime-metadata`, because SSR means an
   element can legitimately exist before anything is attached to it.
3. **The chain is per-element, not per-component.** React walks fibers upward to build
   `collectChain`. Svelte dev's `__svelte_meta.parent` is already a materialized chain of
   `{type, file, line, column, componentTag}` frames — but the frames include non-component types
   (`"if"`, `"render"` observed) and framework-generated files
   (`.svelte-kit/generated/root.svelte`, `componentTag: "Pyramid_0"`). The adapter interface must
   let an adapter return a chain directly and must have a filtering step; `MAX_COMPONENT_CHAIN`
   applies but "host fibers are never chain entries" needs a Svelte analogue ("generated frames
   and non-component block types are never chain entries").

### Can Svelte be served by the same abstraction as React and Vue?

**Partly — and the honest answer is that the abstraction has to be widened, not that Svelte fits
into the existing one.**

Widened as above (a `Resolution` union with a `direct` arm and an explaining `none` arm), one
interface covers all three, and Vue almost certainly lands in the same shape — Vue keeps
`__vueParentComponent` on elements with a `type` carrying `__file` in dev, which is a `direct`
result, and strips it in production, which is a `none`. The React/Vue/Svelte trio then differ in
*which arm they return*, not in what the interface is.

But the widening is not cosmetic, and one consequence should be stated plainly rather than
buried: **for Svelte, DevFlow is a development-mode tool.** In dev it is excellent and cheap. In
production it can locate an element only when that element is bound to one of 23 delegated
events, only when the app opted into source maps (which SvelteKit does *not* do by default), and
even then it reports the location of the *event handler*, not the component. Every other
element — headings, spans, divs, anything without a delegated listener — is unreachable, and no
amount of adapter design changes that, because the information is not present in the page.

If the product promise is "click any element in any deployed app and get its source", Svelte
cannot honour it and no adapter shape will make it. If the promise is "click any element in a dev
server and get its source", Svelte honours it better than React does. That distinction should be
decided before the adapter interface is frozen, because `kind: 'none'` going from a rare edge
case to the common path for a whole framework is a product decision, not an implementation
detail.
