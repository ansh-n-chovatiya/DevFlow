# Spike: Vue 3 / Nuxt adapter feasibility

Measurement spike. Every claim below is backed by output printed by a running
program in a real Chromium. Nothing here was read off documentation. Anything I
did not run is listed under **What I could not measure**.

Throwaway apps: `/private/tmp/claude-502/-Users-user2-Desktop-Personal-context-ledger/d28d5ec8-3953-47ee-89df-a7a46fafbc43/scratchpad/spike-vue/`
(nothing was written into this repo except this file).

---

## Verdict

A Vue adapter on the React model is **feasible**, and the reusable half of the
engine — needle → bundle search → source map → editor URL — works unchanged: a
`.toString()` slice off the right Vue function was found byte-for-byte in the
served bundle in **14 of 14** component/build combinations measured, dev and
production, plain Vue and Nuxt.

The single biggest obstacle is **DOM → component in a default production
build**: Vue strips `__vueParentComponent` and `__vnode` from every element
unless `__VUE_PROD_DEVTOOLS__` was true at *build* time, and setting the devtools
hook at runtime does not bring them back. The adapter must fall back to walking
the vnode tree from `container.__vue_app__` / `container._vnode`, which works but
is O(tree) per click and must follow `suspense.activeBranch` or it reaches
nothing on Nuxt.

Second obstacle, smaller but real: the needle must be taken from
`instance.render`, **not** `instance.type.setup`. The `setup` function's start
offset mapped to the *wrong source file* in 3 of 4 production cases; the
`instance.render` start offset mapped to the right file in 4 of 4.

---

## What was actually run

Versions (printed from the installed `package.json`s):

```
vue-app:  vue 3.5.42 | vite 8.2.2 | @vitejs/plugin-vue 6.0.8
nuxt-app: nuxt 4.5.2 | vue 3.5.42 | vite 8.2.2
node v24.14.0
playwright 1.62.1
~/Library/Caches/ms-playwright: chromium-1234, chromium_headless_shell-1234
```

Four components in the plain-Vue app, deliberately covering all three authoring
styles: `App.vue` (`<script setup>`, root), `MidLevel.vue` (`<script setup>`,
slot wrapper), `DeepLeaf.vue` (`<script setup>` leaf, inside the slot),
`OptionsStyle.vue` (Options API `export default {}`), `RenderFnStyle.js`
(`defineComponent` + `h()`, no SFC). Nuxt app: `app.vue` (template only),
`pages/index.vue`, `components/NuxtDeepLeaf.vue`, and
`components/islands/SpikeIsland.vue` with `experimental.componentIslands`.

Servers and builds:

| target | command | URL |
|---|---|---|
| vue dev | `npx vite --port 5731` | `http://localhost:5731/` |
| vue prod (default) | `npx vite build --outDir dist-plain` + `npx vite preview` | `http://localhost:5732/` |
| vue prod `__VUE_PROD_DEVTOOLS__=true` | `SPIKE_PROD_DEVTOOLS=1 npx vite build --outDir dist-devtools` + preview | `http://localhost:5733/` |
| nuxt dev | `npx nuxt dev --port 5743` | `http://localhost:5743/` |
| nuxt prod (SSR) | `npx nuxt build` + `PORT=5742 node .output/server/index.mjs` | `http://localhost:5742/` |

The vite config used for both prod builds:

```js
export default defineConfig({
  plugins: [vue()],
  define: { __VUE_PROD_DEVTOOLS__: JSON.stringify(process.env.SPIKE_PROD_DEVTOOLS === '1') },
  build: { sourcemap: true },
})
```

Harness: `run.mjs` drives Chromium via Playwright, injects `probe.js`, evaluates
it against a list of CSS selectors, then re-fetches **every response the browser
treated as a script** (by `content-type`, not by URL extension) and greps each
one for needles built with DevFlow's own constants copied verbatim from
`src/shared/constants.ts` (`NEEDLE_HEAD_LEN=200`, `NEEDLE_BODY_LEN=80`,
`MIN_NEEDLE_LEN=12`, `MAX_FN_SOURCE_LEN=65536`) and DevFlow's own `buildNeedle`
logic from `src/core/react/needle.ts`. Source-map lookups use a hand-written VLQ
decoder (`srcmap.mjs`) that reproduces `lookupOriginal`'s "no segment on this
generated line → null" semantics.

Two harness bugs I hit and fixed rather than reporting as findings, both of which
would have produced a false negative:

1. Filtering responses by `.js` extension misses Vite's dev SFC modules, which
   are served from `.vue` URLs with `content-type: text/javascript`. Before the
   fix the dev grep reported "NO HIT" for every SFC.
2. Latching the vnode walk on the *shallowest* `vnode.el === target` match
   mis-attributes a component's root element to its parent — it named `MidLevel`
   for `#leaf-1`. Deepest match wins, and a component vnode owns its own root
   element.

Everything was run headless. One control run headed
(`SPIKE_HEADED=1`, real Chromium window) against vue prod:

```
headless flag: false
own props: []
instanceSource: vnode-walk-from-__vue_app__ owner: DeepLeaf
q4: {"type___name":"DeepLeaf","ctor_name":"Object","vnodeTypeString":"DeepLeaf"}
```

Identical to the headless result. Nothing measured here touches layout,
rasterisation, or GPU, so I would not expect a headed/headless difference in any
of it; the control run is the only evidence I have for that.

---

## Findings

### 1. DOM → component

Enumerating own properties + own symbols of the real `<button id="leaf-1">` in
**vue dev**:

```
=== Q1 ownPropertyNames ===
["__vnode","__vueParentComponent"]
=== Q1 symbols ===
["Symbol(_vei)"]
=== Q1 typeofs ===
{ "__vnode": "object", "__vueParentComponent": "object" }
```

`Symbol(_vei)` is the event-invoker cache and holds no component. There is
nothing else — no `_vnode` on a non-mount element, no `__vue__` (that was Vue 2).

Ancestor scan in **vue dev**, showing the two distinct shapes:

```
[
 {"hop":0,"tag":"BUTTON","id":"leaf-1", "own":["__vnode","__vueParentComponent"]},
 {"hop":1,"tag":"SECTION","id":"mid",   "own":["__vnode","__vueParentComponent"]},
 {"hop":2,"tag":"DIV","id":"root-app",  "own":["__vnode","__vueParentComponent"]},
 {"hop":3,"tag":"DIV","id":"app",       "own":["_vnode","__vue_app__"]},
 {"hop":4,"tag":"BODY","id":null,"own":[]},
 {"hop":5,"tag":"HTML","id":null,"own":[]}
]
```

So: every rendered element carries `__vueParentComponent` (its owning component
instance) and `__vnode`; the **mount container** instead carries `_vnode` (the
root vnode) and `__vue_app__` (the app object).

**It does not survive a default production build.** Same element, vue prod:

```
elementFound true
Q1 own: []
Q1 syms: ["Symbol(_vei)"]
Q1 ancestors: [{"hop":0,"tag":"BUTTON","id":"leaf-1","own":[]},
               {"hop":1,"tag":"SECTION","id":"mid","own":[]},
               {"hop":2,"tag":"DIV","id":"root-app","own":[]},
               {"hop":3,"tag":"DIV","id":"app","own":["_vnode","__vue_app__"]},
               {"hop":4,"tag":"BODY","id":null,"own":[]},
               {"hop":5,"tag":"HTML","id":null,"own":[]}]
hasVueParentComponent: false
```

Only the mount container survives. The fallback — nearest ancestor with
`__vue_app__`, then walk `container._vnode` looking for `vnode.el === target` —
does work:

```
#### #leaf-1        src=vnode-walk-from-__vue_app__ own=[] name=DeepLeaf
#### #options-p     src=vnode-walk-from-__vue_app__ own=[] name=OptionsStyleComponent
#### #render-fn-div src=vnode-walk-from-__vue_app__ own=[] name=RenderFnStyleComponent
#### #title         src=vnode-walk-from-__vue_app__ own=[] name=App
```

Two traps in that fallback, both measured:

- **`app._instance` is `null` in a default prod build.** Observed:
  `{"appInstanceTypeof":"object","appInstanceNull":true}`. The root instance is
  still reachable as `container._vnode.component`. The key `_instance` *is* in
  `Object.keys(app)`, so a truthiness check is required, not a `in` check.
  With `__VUE_PROD_DEVTOOLS__` it is populated (`q1b.appInstNull=false`).
- **`Suspense` breaks a naive walk.** See §7.

Full app object shape (prod, `Object.keys(el.__vue_app__)`):

```
["_uid","_component","_props","_container","_context","_instance","version",
 "config","use","mixin","component","directive","mount","onUnmount","unmount",
 "provide","runWithContext"]     app.version === "3.5.42"
```

With `__VUE_PROD_DEVTOOLS__: true` at build time, the element markers come back
in production:

```
#### #leaf-1 instanceSource=__vueParentComponent ownProps=["__vnode","__vueParentComponent"] q1b.appInstNull=false
```

### 2. The tree

`Object.keys(instance)` in **vue dev** (61 keys; prod is identical minus the last
one, `devtoolsRawSetupState`):

```
["uid","vnode","type","parent","appContext","root","next","subTree","effect",
 "update","job","scope","render","proxy","exposed","exposeProxy","withProxy",
 "provides","ids","accessCache","renderCache","components","directives",
 "propsOptions","emitsOptions","emit","emitted","propsDefaults","inheritAttrs",
 "ctx","data","props","attrs","slots","refs","setupState","setupContext",
 "suspense","suspenseId","asyncDep","asyncResolved","isMounted","isUnmounted",
 "isDeactivated","bc","c","bm","m","bu","u","um","bum","da","a","rtg","rtc",
 "ec","sp","devtoolsRawSetupState"]
```

Upward: `instance.parent` climbs, `instance.root` jumps to the app root, and the
root has `parent === null`. A real climb from `#leaf-1` to root, **vue dev**:

```
[
 {"typeDunderName":"DeepLeaf","typeDunderFile":".../src/components/DeepLeaf.vue",
  "typeDunderHmrId":"e52f6bd3","typeKeys":["__name","props","setup","__hmrId","render","__file"],
  "uid":2,"hasParent":true,"isRootOfApp":false},
 {"typeDunderName":"MidLevel","typeDunderFile":".../src/components/MidLevel.vue",
  "typeDunderHmrId":"7f196590","typeKeys":["__name","setup","__hmrId","render","__file"],
  "uid":1,"hasParent":true,"isRootOfApp":false},
 {"typeDunderName":"App","typeDunderFile":".../src/App.vue",
  "typeDunderHmrId":"7a7a37b1","typeKeys":["__name","setup","__hmrId","render","__file"],
  "uid":0,"hasParent":false,"isRootOfApp":true}
]
rootProp: {"rootUid":0,"rootName":"App"}
```

Note the climb goes `DeepLeaf → MidLevel → App` even though `DeepLeaf` is passed
into `MidLevel` as *slot content authored in App*. `instance.parent` is the
**render-tree** parent, not the lexical owner. React's fiber `_debugOwner` gives
the lexical owner; Vue has no equivalent that I found.

Downward: `instance.subTree` is a vnode; `vnode.component` is the child instance
when the vnode is a component; `vnode.children` is an array for element vnodes.
Descending from the app root, **vue dev**:

```
depth 0  type "div"                   (string) el=DIV      shapeFlag 17
depth 1  type "h1"                    (string) el=H1       shapeFlag 9
depth 1  type MidLevel                (object) el=SECTION  shapeFlag 36  hasComponent
depth 2  type "section"               (string) el=SECTION  shapeFlag 17
depth 3  type Symbol                  (symbol) el=#text    shapeFlag 16
depth 4  type DeepLeaf                (object) el=BUTTON   shapeFlag 4   hasComponent
depth 5  type "button"                (string) el=BUTTON   shapeFlag 9
depth 1  type OptionsStyleComponent   (object) el=P        shapeFlag 4   hasComponent
depth 2  type "p"                     (string) el=P        shapeFlag 9
depth 1  type RenderFnStyleComponent  (object) el=DIV      shapeFlag 4   hasComponent
depth 2  type "div"                   (string) el=DIV      shapeFlag 9
```

The tree is intact in production too — that is exactly what the §1 fallback walk
uses.

### 3. The function — and does it appear in the served bundle?

**`instance.type` is an object, not a function.** This is the structural
difference from React, where the fiber's `type` *is* the component function.
Vue's candidates and what they are:

**vue dev**, `#leaf-1` (`<script setup>` SFC):

```
type keys: ["__name","props","setup","__hmrId","render","__file"]
  instance.type (itself)  :: typeof=object
  instance.type.setup     :: fn name="setup"      srcLen=469
     "setup(__props, { expose: __expose }) {\n  __expose();\n\nconst props = __props\nconst leafState = ref(41)\nconst leafComputedValue = computed(() => leafState.value + 1 + 'DEEP_LEAF_UNIQUE_MARKER_7b21')\nfun"
  instance.type.render    :: fn name="_sfc_render" srcLen=321
     "function _sfc_render(_ctx, _cache, $props, $setup, $data, $options) {\n  return (_openBlock(), _createElementBlock(\"button\", {\n    id: $setup.props.idAttr,\n    class: \"deep-leaf-btn\",\n    onClick: $set"
  instance.render         :: same function as type.render
  instance.effect.fn      :: fn name="componentUpdateFn" srcLen=3694   <-- Vue internal, NOT the component
  instance.update         :: fn name="bound run" srcLen=29  "function () { [native code] }"
```

**vue prod**, same component. Note that `@vitejs/plugin-vue` switches to *inline*
template compilation for production, so `type.render` disappears and the render
function becomes the arrow **returned by `setup`**, reachable as
`instance.render`:

```
type keys: ["__name","props","setup"]
  instance.type.setup  :: fn name="setup" srcLen=205
     "setup(e){let t=e,n=Rt(41),r=aa(()=>n.value+1+`DEEP_LEAF_UNIQUE_MARKER_7b21`);function i(){n.value+=1}return(e,n)=>(Si(),Di(`button`,{id:t.idAttr,class:`deep-leaf-btn`,onClick:i},` Leaf `+A(r.value),9,"
  instance.type.render :: undefined
  instance.render      :: fn name="" srcLen=97
     "(e,n)=>(Si(),Di(`button`,{id:t.idAttr,class:`deep-leaf-btn`,onClick:i},` Leaf `+A(r.value),9,$a))"
```

Options-API and plain-`defineComponent` components keep a separate `render`:

```
#options-p  prod  typeKeys=["name","data","methods","render"]
  instance.type.render :: fn name="ao" srcLen=172
     "function ao(e,t,n,r,i,a){return Si(),Di(`p`,{id:`options-p`,onClick:t[0]||=(...e)=>a.bumpTheOptionsCounter&&a.bumpTheOptionsCounter(...e)},A(i.optionsMarker)+` `+A(i.n),1)}"
  instance.type.data   :: fn name="data" srcLen=68
     "data(){return{optionsMarker:`OPTIONS_STYLE_UNIQUE_MARKER_c4d8`,n:0}}"

#render-fn-div prod typeKeys=["name","setup"]
  instance.type.setup :: "setup(){return()=>oa(`div`,{id:`render-fn-div`},`RENDER_FN_UNIQUE_MARKER_a19e`)}"
  instance.render     :: "()=>oa(`div`,{id:`render-fn-div`},`RENDER_FN_UNIQUE_MARKER_a19e`)"
```

`instance.update` is `bound run` → `[native code]` → DevFlow's own
`needleRejection()` classifies it `native`. `instance.effect.fn` is Vue's shared
`componentUpdateFn` and is the *same function for every component* — it hits the
Vue runtime chunk, never the component. Both are traps; neither is usable.

#### The bundle grep — the headline result

Needles built with DevFlow's exact `buildNeedle`, searched in the bytes actually
served over the wire (re-fetched from the page context), and additionally in the
build output on disk.

**vue dev** (Vite serves each SFC from its own `.vue` URL):

```
##### #leaf-1
  instance.type.setup  (srcLen=469) -> HIT  /src/components/DeepLeaf.vue    headIdx=301  bodyIdx=351  fileLen=4597
  instance.type.render (srcLen=321) -> HIT  /src/components/DeepLeaf.vue    headIdx=967  bodyIdx=1017 fileLen=4597
  instance.render      (srcLen=321) -> HIT  /src/components/DeepLeaf.vue    headIdx=967  bodyIdx=1017 fileLen=4597
##### #options-p
  instance.type.render (srcLen=365) -> HIT  /src/components/OptionsStyle.vue headIdx=513 bodyIdx=563 fileLen=3743
  instance.type.data   (srcLen=77)  -> HIT  /src/components/OptionsStyle.vue headIdx=212 bodyIdx=237 fileLen=3743
##### #render-fn-div
  instance.type.setup  (srcLen=138) -> HIT  /src/components/RenderFnStyle.js headIdx=149 bodyIdx=195 fileLen=1607
##### #title
  instance.type.setup  (srcLen=304) -> HIT  /src/App.vue                     headIdx=466 bodyIdx=516 fileLen=5296
  instance.render      (srcLen=520) -> HIT  /src/App.vue                     headIdx=1107 bodyIdx=1157 fileLen=5296
```

**vue prod** (single minified chunk, greps identical over the wire and on disk):

```
##### #leaf-1
  instance.type.setup (srcLen=205) -> HIT  served /assets/index-BWQeyHwh.js  idx=61474  (fileLen 62659)
                                           ondisk index-BWQeyHwh.js          idx=61474
  instance.render     (srcLen=97)  -> HIT  served /assets/index-BWQeyHwh.js  idx=61581
##### #options-p
  instance.type.render (srcLen=172) -> HIT idx=62048       instance.type.data (srcLen=68) -> HIT idx=61934
##### #render-fn-div
  instance.type.setup (srcLen=80)  -> HIT idx=62287        instance.render (srcLen=65) -> HIT idx=62301
##### #title
  instance.type.setup (srcLen=177) -> HIT idx=62422        instance.render (srcLen=149) -> HIT idx=62449
```

**nuxt prod** (code-split; the component chunk is separate from the vue runtime
chunk, and the grep correctly finds each in its own file):

```
##### #leaf-1
  instance.type.setup (srcLen=206) -> HIT served /_nuxt/m0EL_ZEO.js idx=11314 (fileLen 11803)
  instance.render     (srcLen=95)  -> HIT served /_nuxt/m0EL_ZEO.js idx=11424
  instance.effect.fn  (srcLen=1006)-> HIT served /_nuxt/GoX6kfTn.js idx=58944 (fileLen 93909)   <-- vue runtime chunk
##### #title
  instance.type.setup (srcLen=144) -> HIT served /_nuxt/m0EL_ZEO.js idx=11598
  instance.render     (srcLen=117) -> HIT served /_nuxt/m0EL_ZEO.js idx=11624
```

**nuxt dev**: `instance.type.setup`, `instance.type.render` and `instance.render`
all HIT in `/_nuxt/components/NuxtDeepLeaf.vue` and `/_nuxt/pages/index.vue`.

Score: **every** component function candidate (`setup`, `render`,
Options-API `data`) was found byte-for-byte in a served script, in every build,
in both frameworks. `Function.prototype.toString()` round-trips through Vue
exactly as it does through React.

#### Where the hit actually maps to — a correctness caveat

Feeding the hit offsets through the production source map (`srcmap.mjs`,
reproducing `lookupOriginal`) shows the two candidates are **not** equivalent:

```
--- vue prod, function-start offsets ---
61474 (DeepLeaf   type.setup)     -> node_modules/@vue/runtime-dom/...esm-bundler.js : line 2051   WRONG FILE
62422 (App        type.setup)     -> src/main.js : line 3 col 10 (name=App)                        WRONG FILE
62287 (RenderFn   type.setup)     -> src/components/RenderFnStyle.js : line 4 col 2                correct

61581 (DeepLeaf   instance.render)-> src/components/DeepLeaf.vue     : line 6 col 57               correct file
62048 (OptionsSty instance.render)-> src/components/OptionsStyle.vue : line 6 col 0                correct file
62301 (RenderFn   instance.render)-> src/components/RenderFnStyle.js : line 6 col 4                correct file
62449 (App        instance.render)-> src/App.vue                     : line 7 col 19               correct file
```

```
--- nuxt prod, function-start offsets (chunk m0EL_ZEO.js) ---
11314 (NuxtDeepLeaf type.setup)     -> node_modules/nuxt/dist/components/runtime/server-component.js : 31   WRONG FILE
11424 (NuxtDeepLeaf instance.render)-> components/NuxtDeepLeaf.vue : line 6 col 61                          correct file
11598 (index        type.setup)     -> components/NuxtDeepLeaf.vue : line 10 col 29                         WRONG FILE
11624 (index        instance.render)-> pages/index.vue : line 4 col 19                                      correct file
```

The cause, measured by stepping the offset forward one character at a time:

```
offset 61460..61480 -> runtime-dom.esm-bundler.js : 2051   (stale carried-over segment)
offset 61490        -> src/components/DeepLeaf.vue : 3 col 14
offset 61500        -> src/components/DeepLeaf.vue : 5 col 6
```

The *first* character of a minified `setup(` sits inside the trailing mapping
segment of whatever preceded it in the chunk; roughly 16 characters later the
mapping is correct. `instance.render` does not have this problem because in the
inline-compiled output it starts at a token that carries its own segment.

Line precision is approximate even when the file is right — `DeepLeaf.vue:6` is
the last line of the `<script setup>` block, and the button is on line 9. **File
attribution is reliable; line attribution is "somewhere in the right file,
usually the end of the script block".** That is a real degradation versus React,
where the function start is the component declaration.

**In Vite dev, the function-start lookup returns `null` outright.** Vite's dev
SFC module has a source map that only covers the *statement* lines of the script
body and the *expression* lines of the template — not the function-declaration
lines:

```
map lines with content (generated line index -> mapping segments):
  genLine 0, 8, 9, 10, 11, 24, 25, 26, 27, 28     (29 map lines; module is 50 lines)

offset 301  (setup start,       gen 5:2)   -> NO MAPPING
offset 351  (setup body needle, gen 6:11)  -> NO MAPPING
offset 967  (_sfc_render start, gen 23:0)  -> NO MAPPING
offset 1017 (render body needle, gen 23:50)-> NO MAPPING
offset 360  (gen 8:5)                      -> DeepLeaf.vue : line 3 col 5
offset 1080 (gen 24:43)                    -> DeepLeaf.vue : line 9 col 2
```

`lookupOriginal` (`src/core/react/sourcemap.ts:339-340`) returns `null` when the
generated line decodes to no segment, so the dev path for a Vite Vue app would
report "no source" unless the position is nudged forward into a mapped line.

Also, the dev map's `sources` is `["DeepLeaf.vue"]` — a bare basename with no
directory, so `normalizeSourcePath` produces `DeepLeaf.vue` and an editor URL
built from it cannot be opened. `sourcesContent` is present.

### 4. Display name

```
                        dev                            prod (default)          prod (__VUE_PROD_DEVTOOLS__)
DeepLeaf.vue            __name "DeepLeaf"              __name "DeepLeaf"       __name "DeepLeaf"
MidLevel.vue            __name "MidLevel"              __name "MidLevel"       __name "MidLevel"
App.vue                 __name "App"                   __name "App"            __name "App"
OptionsStyle.vue        name   "OptionsStyleComponent" name  "OptionsStyle..." name  "OptionsStyle..."
RenderFnStyle.js        name   "RenderFnStyleComponent"name  "RenderFnStyle..."name  "RenderFnStyle..."
nuxt pages/index.vue    __name "index"                 __name "index"          (n/a)
nuxt components/...vue  __name "NuxtDeepLeaf"          __name "NuxtDeepLeaf"   (n/a)
nuxt app.vue            null                           null                    (n/a)
```

**Names survive minification.** `@vitejs/plugin-vue` injects
`__name: 'DeepLeaf'` as a string literal derived from the filename, and terser
does not touch string values. An explicit `name:` option survives for the same
reason. Verbatim, vue prod:

```
Q4: {"type___name":"DeepLeaf","ctor_name":"Object","vnodeTypeString":"DeepLeaf"}
```

The lookup order that matched everything measured is `type.__name ?? type.name`.
Two gaps: a template-only SFC (`nuxt-app/app.vue`, no `<script>` block at all)
gets **no name in any build** — the climb shows `{"n":null,"keys":["__hmrId","render","__file"]}`
in dev and `{"name":null,"keys":["render"]}` in prod. And a page component is
named after its file, so `pages/index.vue` is displayed as `index`.

### 5. The devtools hook

**Nothing installed.** Measured on every one of the five targets, before any
probe ran:

```
hookBeforeAnyVue: {"present":false,"keys":null,"isSpikeFake":false,"appsLen":null}
```

`window.__VUE_DEVTOOLS_GLOBAL_HOOK__` is `undefined`. Vue does **not** create it.

**Hook installed before app boot.** I injected a fake hook via
`page.addInitScript` (keys `Vue, apps, events, on, once, off, emit, __SPIKE_FAKE`)
and re-measured:

```
### hook-vue-dev
  hookBeforeAnyVue: {"present":true,"keys":["Vue","apps","events","on","once","off","emit","__SPIKE_FAKE","enabled"],"appsLen":0}
  element own props: ["__vnode","__vueParentComponent"]
  instanceSource: __vueParentComponent

### hook-vue-prod-plain
  hookBeforeAnyVue: {"present":true,"keys":["Vue","apps","events","on","once","off","emit","__SPIKE_FAKE"],"appsLen":0}
  element own props: []
  instanceSource: vnode-walk-from-__vue_app__

### hook-vue-prod-devtools
  hookBeforeAnyVue: {"present":true,"keys":[...,"__SPIKE_FAKE","enabled"],"appsLen":0}
  element own props: ["__vnode","__vueParentComponent"]
  instanceSource: __vueParentComponent

### hook-nuxt-prod
  hookBeforeAnyVue: {"present":true,"keys":[...,"__SPIKE_FAKE"],"appsLen":0}
  element own props: []
  instanceSource: NONE   (walk needs the Suspense branch — see §7)
```

The diagnostic detail is the extra `"enabled"` key: Vue's devtools bridge wrote
to my object in **dev** and in the **`__VUE_PROD_DEVTOOLS__` prod build**, and
left it completely untouched in the default prod builds. That is a direct
measurement that the flag is compile-time and that installing the hook at
runtime changes nothing.

**Is the tree reachable without the hook?** Yes, in every configuration
measured. `treeReachableWithoutHook: true` in all runs where an instance was
found, and every §1–§4 result above was obtained with the hook absent.

**What exactly breaks without `__VUE_PROD_DEVTOOLS__`:**

| thing | default prod | `__VUE_PROD_DEVTOOLS__: true` |
|---|---|---|
| `el.__vueParentComponent` | **absent** | present |
| `el.__vnode` | **absent** | present |
| `app._instance` | **`null`** | populated |
| `type.__file` | **absent** | present (basename, e.g. `"DeepLeaf.vue"`) |
| `container.__vue_app__` / `container._vnode` | present | present |
| `instance.parent` / `.root` / `.subTree` | present | present |
| `type.__name` / `type.name` | present | present |
| `setup` / `render` `.toString()` in bundle | present | present |
| bundle size (this app) | 62.65 kB | 64.55 kB |

Nothing DevFlow strictly *needs* is gated — the walk covers `__vueParentComponent`
— but the fast O(1) path and `__file` both are.

### 6. Source location on the component

`__file` — set only by `@vitejs/plugin-vue`, only for SFCs, and it is an
**absolute filesystem path** in dev:

```
vue dev:
  #leaf-1        __file=/private/tmp/.../vue-app/src/components/DeepLeaf.vue
  #options-p     __file=/private/tmp/.../vue-app/src/components/OptionsStyle.vue
  #title         __file=/private/tmp/.../vue-app/src/App.vue
  #render-fn-div __file=undefined              <-- not an SFC
nuxt dev:
  #leaf-1        __file=/private/tmp/.../nuxt-app/components/NuxtDeepLeaf.vue
  #title         __file=/private/tmp/.../nuxt-app/pages/index.vue
  #island-root   __file=undefined              <-- NuxtIsland, from nuxt/dist
```

**Gone in a default production build**, in both frameworks:

```
vue prod:  [{"name":"DeepLeaf","__file":null,"__source":null,"__hmrId":null},
            {"name":"MidLevel","__file":null,...},{"name":"App","__file":null,...}]
nuxt prod: NuxtDeepLeaf __file=null, index __file=null, NuxtIsland __file=null
```

With `__VUE_PROD_DEVTOOLS__: true` it comes back, but only as a **basename**:

```
Q6: [{"name":"DeepLeaf","__file":"DeepLeaf.vue","__source":null,"__hmrId":null},
     {"name":"MidLevel","__file":"MidLevel.vue",...},
     {"name":"App","__file":"App.vue",...}]
```

`__source` is `null` everywhere — I never observed it on any component in any
build. `__hmrId` exists in dev only (`"e52f6bd3"` for DeepLeaf) and is an opaque
hash, not a path. The elements themselves carry no source attribute; the leaf
button's full attribute list in dev and prod alike is
`["id=leaf-1","class=deep-leaf-btn"]` — no `data-v-*` scope id, because none of
my components used `<style scoped>`.

So: `__file` is a nice fast path in dev, useless in default prod, and only a
basename in prod-devtools. It cannot replace the bundle-search route.

### 7. Nuxt differences

**The instance shape is identical.** Nuxt is plain Vue 3.5.42 under the hood
(`app.version === "3.5.42"`), and after hydration every element carries
`__vueParentComponent` in dev exactly as in a plain Vite app. SSR + hydration
does not change any property name.

```
nuxt dev ancestors of #leaf-1:
  BUTTON#leaf-1:["__vnode","__vueParentComponent"]
  DIV#page-root:["__vnode","__vueParentComponent"]
  DIV#root-app:["__vnode","__vueParentComponent"]
  DIV#__nuxt:["_vnode","__vue_app__"]         <-- mount container is #__nuxt
  BODY, HTML: []
```

**Difference 1 — the parent chain is full of framework wrappers with no source.**
Climbing from `#leaf-1` in nuxt dev:

```
NuxtDeepLeaf  __file=.../components/NuxtDeepLeaf.vue   keys=[__name,props,setup,__hmrId,render,__file]
index         __file=.../pages/index.vue               keys=[__name,setup,__hmrId,render,__file]
RouteProvider __file=null                              keys=[name,props,setup]
RouterView    __file=null                              keys=[name,inheritAttrs,props,compatConfig,setup]
NuxtPage      __file=null                              keys=[name,inheritAttrs,props,setup]
(app.vue)     __file=.../nuxt-app/app.vue  name=null    keys=[__hmrId,render,__file]
nuxt-root     __file=.../node_modules/nuxt/dist/app/components/nuxt-root.vue
```

Three of the seven links are `vue-router`/Nuxt internals, and the root two are
`node_modules`. An adapter needs the same "is this a dependency" filter DevFlow
already has in `src/core/react/classify.ts`.

**Difference 2 — `Suspense`, which is what actually broke my first walk.** Nuxt
wraps both the app root and every page in `<Suspense>`, and a Suspense vnode
keeps its content in `suspense.activeBranch`, **not** in `children`. A walk that
follows only `component.subTree` and `children[]` reaches nothing:

```
#### #leaf-1 instanceSource=NONE own=[] q1b: {"found":false,"appInstNull":true}
```

Following `suspense.activeBranch` / `suspense.pendingBranch` / `ssContent`
recovers the whole tree:

```
d=0  root       nuxt-root      el=DIV#root-app
d=1  subTree    Suspense       el=DIV#root-app   hasSuspense
d=2  activeBranch (app.vue)    el=DIV#root-app
d=3  subTree    div            el=DIV#root-app
d=4  children[] NuxtPage       el=DIV#page-root
d=5  subTree    RouterView     el=DIV#page-root
d=6  subTree    Suspense       el=DIV#page-root  hasSuspense
d=7  activeBranch RouteProvider el=DIV#page-root
d=8  subTree    index          el=DIV#page-root
d=9  subTree    div            el=DIV#page-root
d=10 children[] h1             el=H1#title
d=10 children[] NuxtDeepLeaf   el=BUTTON#leaf-1
d=11 subTree    button         el=BUTTON#leaf-1
```

**Difference 3 — islands are a hole, in dev and prod alike.** With
`experimental.componentIslands: true` and a server component
`components/islands/SpikeIsland.vue`, the SSR HTML is:

```html
<!--[--><!--[--><aside id="island-root" class="spike-island"
  data-island-uid="463aafe1-...."> ISLAND_UNIQUE_MARKER_d51c
  <span id="island-inner">inner</span></aside><!--]-->...
```

and the measurement, identical in nuxt dev and nuxt prod:

```
#island-root : src=__vueParentComponent (dev) / vnode-walk (prod)
               owner = NuxtIsland   typeKeys=["name","inheritAttrs","props","emits","setup"]
               __file = undefined   (it is nuxt/dist/app/components/nuxt-island.js)
#island-inner: src=NONE   own=[]    no vnode anywhere in the tree has el === #island-inner
```

The island's interior is raw HTML injected by `NuxtIsland`; there is no client
vnode and no client component for it. Clicking anything inside an island
attributes at best to Nuxt's own `NuxtIsland` wrapper, never to
`SpikeIsland.vue`. Its `setup.toString()` *does* hit the bundle
(`/_nuxt/m0EL_ZEO.js idx=8167`), which is worse than a miss: DevFlow would
confidently resolve to `nuxt/dist/app/components/nuxt-island.js`.

**Difference 4 — the served-script list is 40× longer in dev.** Nuxt dev served
**164** distinct script URLs versus **10** for the Vite Vue app, most of them
`/_nuxt/node_modules/...`. DevFlow's per-inventory search budget and its
`isDependencyPath` filter matter far more here than on a plain Vite app.

**Difference 5 — prod source maps are per-route chunks with good paths.** The
component chunk's map has relative sources and inlined content:

```
BseeHt1-.js.map sources: ["../../../components/NuxtDeepLeaf.vue","../../../pages/index.vue"]
sourcesContent: present (full SFC text)
```

That is *better* than the Vite dev map (bare basename) for building an editor URL.

---

## What I could not measure

- **Vue 2 / `@vue/compat`.** Not installed, not run. Vue 2's `el.__vue__` is a
  different mechanism entirely and none of this transfers.
- **Webpack + `vue-loader`.** Everything here is Rollup/Vite. `__file`
  injection, `__name` injection and inline-template compilation are
  `@vitejs/plugin-vue` behaviours; `vue-loader` may differ. **This is the
  biggest gap in the spike** — a large share of real Vue apps in the field are
  webpack-built.
- **A minifier configured with property mangling** (`terser mangle.properties`),
  which could rename `__name`/`__file`. Vite's default terser/esbuild config
  does not mangle properties, and I only measured the default.
- **`<style scoped>` / `data-v-*` scope ids.** None of my components used scoped
  styles, so I have no measurement of whether a `data-v-xxxxxxx` attribute or
  `type.__scopeId` offers an alternative identity route. `instance.type` did not
  contain a `__scopeId` key in any component I built, but that is because none
  had scoped styles.
- **`nuxt generate` (fully static / SSG)** and **`ssr: false` (SPA mode)**. I
  measured `nuxt build` + Nitro SSR only.
- **Async components, `defineAsyncComponent`, `<KeepAlive>`, `<Teleport>`,
  functional components, and `v-for` lists.** `asyncDep`/`asyncResolved` exist
  on the instance and `AsyncWrapper` appears in Vue's own `componentUpdateFn`
  source, but I built none of these, so I do not know whether the walk or
  `__vueParentComponent` behaves differently.
- **Vuetify / PrimeVue / Nuxt UI or any real component library.** Everything
  here is four hand-written components. Library components compiled ahead of
  time and shipped as pre-built ESM may have had `__name` stripped by *their*
  build.
- **The real Vue DevTools extension.** I injected a fake hook object; I did not
  install the actual extension, so I cannot say what its `apps` array or its
  backend API contain when genuinely connected. I measured only that Vue writes
  `enabled` onto whatever object is at `__VUE_DEVTOOLS_GLOBAL_HOOK__` in dev and
  in a `__VUE_PROD_DEVTOOLS__` build, and touches it not at all otherwise.
- **Whether DevFlow's actual `searchBundle` walk-back-to-function-start produces
  the same offsets my grep did.** I reproduced `buildNeedle` verbatim but
  reimplemented the search as a plain `indexOf`; I did not execute DevFlow's
  compiled `search.ts`. The head-needle offsets I report are the offsets of the
  function's first character, which is what `searchBundle` documents itself as
  returning for a head hit.
- **Performance of the prod fallback walk.** My trees are 13 vnodes deep and
  tiny. I did not measure the cost of the `container._vnode` walk on a large app,
  and it is the per-click cost of the whole prod path.
- **Multiple Vue apps on one page**, or Vue mounted inside a shadow root.
- **Headed vs headless beyond the one control run** described above.

---

## Consequences for the adapter contract

**The needle / bundle-search / source-map engine can be reused unchanged.**
`buildNeedle`, `searchBundle`, `parseSourceMap`, `lookupOriginal`,
`isDependencyPath` and `buildEditorUrl` all operate on a function's source text
and a bundle's bytes, and Vue's functions round-trip through `.toString()` into
the served bundle identically to React's — measured 14/14. Nothing in
`src/core/react/` needs a Vue branch except its directory name.

What must change is the shape of the *adapter*, which today is implicitly "fiber
→ function". Three concrete requirements fall out of the measurements:

**1. The adapter must return a function that is not `type`.** React's contract
can be `(el) => { fn, displayName }` where `fn === fiber.type`. Vue's
`instance.type` is an object; the searchable function is `instance.render` in
production and `instance.type.render ?? instance.type.setup` in dev. So the
interface needs an explicit "give me the searchable source function" step,
separate from "give me the component identity", because for Vue they are
different objects. Concretely:

```ts
interface FrameworkAdapter {
  /** Cheapest path from a clicked element to a component handle. */
  fromElement(el: HTMLElement): ComponentHandle | null;
  /** Stable identity for dedupe across clicks — Vue: instance.uid + app uid. */
  identity(h: ComponentHandle): string;
  /** Display name. Vue: type.__name ?? type.name; may be null. */
  displayName(h: ComponentHandle): string | null;
  /** The function whose .toString() is searched. MAY differ from identity. */
  sourceFunction(h: ComponentHandle): Function | null;
  /** Walk up, skipping framework-internal ancestors. */
  parent(h: ComponentHandle): ComponentHandle | null;
  /** Optional fast path: a path the framework already knows. Vue: type.__file. */
  declaredSource?(h: ComponentHandle): string | null;
}
```

**2. `fromElement` must be allowed to be expensive, and to fail.** React can
always read `el[Object.keys(el).find(k => k.startsWith('__reactFiber$'))]`. Vue
in a default production build has *nothing on the element* and requires an
O(tree) walk from the mount container, which additionally must follow
`suspense.activeBranch`. Two implications for the contract: `fromElement` should
be async-tolerant or at least budgeted, and it must be able to return `null`
with a *reason* (Nuxt island interiors genuinely have no component), so the
existing "one sentence saying why there is no path" discipline extends to
capture as well as resolution.

**3. `declaredSource` is an optional fast path, never a substitute.** Vue gives
an absolute `__file` in dev, a basename in a `__VUE_PROD_DEVTOOLS__` build, and
nothing in default prod. It is worth taking when present (it skips the whole
search) but it must not become a second, divergent code path — the observed
basename-only form is unusable for an editor URL on its own.

Two things that are *not* interface changes but will bite:

- **Position quality is worse than React's and the engine cannot fix it.** The
  function-start offset maps to the wrong *file* for `setup` and to roughly the
  end of the `<script>` block for `render`. Needling `instance.render` is
  mandatory, and even then the reported line should probably be presented as
  file-level. If line precision matters, the honest options are (a) accept
  file + approximate line, or (b) add a compile-time transform, which DevFlow
  already has infrastructure for in `compiler-plugin/`.
- **Vite dev returns `null` from `lookupOriginal` at every function start**,
  because the dev SFC map has no segment on declaration lines. Whatever fix
  that needs — scanning forward for the nearest mapped position — belongs in
  the shared engine and would benefit React-on-Vite too, so it is worth
  measuring the React dev case before deciding it is Vue-specific.
