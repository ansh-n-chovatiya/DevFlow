# spike-rsc — measurement spike: what React Server Components actually put on the wire

Everything below was produced by running a real Next.js App Router app and printing
what came out of it. Nothing here is read off a specification. Where I did not run
something, it is in **What I could not measure**.

---

## Verdict

1. **An RSC reader is feasible, and it is a protocol reader — but only in `next dev`
   does the protocol carry component identity.** In dev the payload names every
   server component, its owner chain, its props, and a `file:line:col` that maps back
   to the original `.tsx` through a source map the browser can fetch over HTTP. I did
   that whole round trip and it landed on `app/components/ServerOnlyWidget.tsx:7:5`.
2. **It is genuinely cheaper than a runtime adapter — the reader is a line-oriented
   parser over ~10 row types, not a tree walker.** But it is only cheaper because it
   is *smaller*, not because it is more capable: in production it can tell you almost
   nothing.
3. **The single biggest obstacle: in `next build && next start` a server component
   leaves no identity on the wire at all.** Not a name, not a module id, not a file.
   The `<div>` it rendered arrives as an anonymous row. Client components survive as
   an opaque *numeric* module id whose file name lives only in a manifest on disk that
   is never served to the browser (404 on every path I tried).

---

## What was actually run

```
next 16.3.4
react 19.2.8
react-dom 19.2.8
@vercel/otel 2.1.3
@opentelemetry/api 1.9.1
node v24.14.0   playwright 1.62.1 (chromium 151)
```

Throwaway app at `…/scratchpad/spike-rsc/` (not in the repo). Shape:

- `app/page.tsx` — server component, `export const dynamic = 'force-dynamic'`
- `app/components/ServerOnlyWidget.tsx` — pure server component holding a marker
  constant `SPIKE_SERVER_ONLY_SECRET_9f2a`
- `app/components/ClientCounter.tsx` — `'use client'`, `useState`
- `app/components/ActionForm.tsx` — `'use client'`, calls a server action
- `app/actions.ts` — `'use server'`, `echoAction`
- `app/components/SlowServerData.tsx` — `await sleep(1500)`, inside `<Suspense>`
- `instrumentation.ts` — `registerOTel({ serviceName: 'spike-rsc' })`
- `collector.mjs` — a 25-line node http server on :4318 that logs OTLP it receives

Commands:

```
npx next dev -p 3000                              # dev
npx next build && npx next start -p 3001          # prod
npx next build && npx next start -p 3002          # prod + productionBrowserSourceMaps:true
curl / curl -H 'RSC: 1' '…/?_rsc'                 # raw wire
node stream.mjs <port> [rsc|html]                 # per-chunk arrival timing
node probe.mjs / probe2.mjs / probe3.mjs          # playwright, reads fibers off real elements
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
OTEL_EXPORTER_OTLP_PROTOCOL=http/json NEXT_OTEL_VERBOSE=1
```

One environment note that cost a restart and is worth writing down: with Turbopack
(the Next 16 default), a `package.json` **without `"type": "module"`** makes every
`.tsx` in the app fail to compile with *"Specified module format (CommonJs) is not
matching the module format of the source code"* and the route 500s. Observed:

```
⨯ ./app/page.tsx
Error: Specified module format (CommonJs) is not matching the module format of the source code (EcmaScript Modules)
 GET / 500 in 690ms
```

---

## Findings

### 1. What is on the wire

Two carriers, same bytes.

**(a) `Content-Type: text/x-component`** — a dedicated RSC response, reached by
`RSC: 1`. Note the redirect: `curl -H 'RSC: 1' http://localhost:3000/` returns

```
HTTP/1.1 307 Temporary Redirect
location: /?_rsc
```

so the query parameter, not the header, is what actually selects the payload. With it:

```
HTTP/1.1 200 OK
Vary: rsc, next-router-state-tree, next-router-prefetch, next-router-segment-prefetch, Accept-Encoding
Cache-Control: no-cache, must-revalidate
Content-Type: text/x-component
Transfer-Encoding: chunked
```

**(b) inside the HTML**, as `self.__next_f.push([1, "<rows>"])` script tags.

**The line format.** The stream is newline-delimited rows of
`<hex-id><optional-type-tag>:<payload>`. The id is **lowercase hex, not decimal** —
row `45` is followed by row `46` … `4e` … `5c`. Real rows, verbatim, from prod:

```
1:"$Sreact.fragment"
2:I[39756,["/_next/static/chunks/3fntmmi971322.js"],"default"]
6:"$Sreact.suspense"
e:I[68027,["/_next/static/chunks/3fntmmi971322.js"],"default",1]
b:[["$","meta","0",{"charSet":"utf-8"}],["$","meta","1",{"name":"viewport","content":"width=device-width, initial-scale=1"}]]
7:["$","div",null,{"id":"slow-server-data","children":[["$","h2",null,{"children":"SlowServerData"}],["$","p",null,{"children":"marker=SPIKE_SUSPENDED_PAYLOAD_ARRIVED"}]]}]
```

Row types I actually observed: **no tag** (a JSON model row), **`I`** (a client-module
import reference), **`D`** (debug info — dev only), **`J`** (an async/awaited debug
record — dev only, seen on the debug channel). Inside a model row, `"$"` opens a JSX
element tuple, `"$L<id>"` is a *lazy* forward reference to a row not yet sent, `"$<id>"`
is a resolved back-reference, `"$S<symbol>"` is a React symbol, `"$@<id>"` is a promise,
`"$undefined"` is the literal undefined, `"$Y"` is an omitted/deferred value.

The element tuple is longer in dev than in prod, and this is the shape difference that
matters most:

```
prod : ["$","p",null,{"children":"marker=SPIKE_SERVER_RENDERED_TEXT"}]
dev  : ["$","p",null,{"children":"marker=SPIKE_SERVER_RENDERED_TEXT"},"$37","$39",1]
                                                                      ^owner ^stack ^validated
```

A parser written against prod bytes will silently mis-index dev bytes, and vice versa.

### 2. Component identity on the wire

**Dev — the `I` row carries a real path and export name:**

```
3f:I["[project]/app/components/ClientCounter.tsx [app-client] (ecmascript)",["/_next/static/chunks/node_modules_next_dist_20wefz_._.js","/_next/static/chunks/_098lxtj._.js"],"default"]
41:I["[project]/app/components/ActionForm.tsx [app-client] (ecmascript)",["…"],"default"]
```

**Prod — the same row is a bare number:**

```
4:I[56850,["/_next/static/chunks/3fntmmi971322.js","/_next/static/chunks/0h52v0jkvejiz.js"],"default"]
5:I[7523,[…],"default"]
```

So `I` rows go from `path + export` to `opaque integer + chunk urls + export`. The
export name (`"default"`, `"OutletBoundary"`, `"ViewportBoundary"`, `"MetadataBoundary"`)
survives in both.

**Server components are named in neither.** Not in prod, and not in the HTTP stream in
dev either. What dev has instead is a **separate debug channel over the HMR websocket**,
and that is where the identity lives. The HTTP stream only holds *references* to it:

```
32:D"$34"
32:D"$33"
32:["$","div",null,{"id":"server-only","data-computed":29,…},"$33","$35",1]
```

Rows `33`, `34`, `35` do not exist in the HTTP response. I checked every id present:

```
=== row ids present in dev RSC stream ===
0: 15: 17: 19: 2: 2a: 32: 3b: 3d: 3f: 4: 41: 45: 4a: 4c: 4e: 53: 58: 59: 5c: 6: 62: 64:
=== are 33,35,10,7,12 present? ===
33 -> 0   35 -> 0   10 -> 0   7 -> 0   12 -> 0
```

They arrive on `ws://localhost:3000/_next/hmr?id=<html-request-id>`. Captured frames,
verbatim:

```
2f:{"name":"Page","key":null,"env":"Server","stack":[["Promise.all","",0,0,0,0,true]],"props":{"params":"$@30","searchParams":"$@31"}}
33:[["Page","…/.next/dev/server/chunks/ssr/[root-of-the-server]__0f3blm3._.js",188,263,187,1,false]]
37:{"name":"ServerOnlyWidget","key":null,"env":"Server","owner":"$2f","stack":[["Page","…/[root-of-the-server]__0f3blm3._.js",198,264,187,1,false]],"props":{"label":"from-page"}}
39:[["ServerOnlyWidget","…/[root-of-the-server]__0f3blm3._.js",93,263,91,1,false]]
b:{"name":"RootLayout","key":null,"env":"Server","stack":[],"props":{…}}
15:[["RootLayout","…/.next/dev/server/chunks/ssr/_109tciv._.js",17,263,16,1,false]]
74:J{"name":"SlowServerData","start":1.294625000009546,"end":1503.296000000002,"env":"Server","stack":"$75","owner":"$46","value":"$@76"}
```

So the dev debug channel gives, per server component: **name, `env:"Server"`, an owner
back-reference forming the full render chain, the props it was called with, a stack
frame `[fnName, absFile, line, col, enclosingLine, enclosingCol, isAsync]`, and (via `J`)
start/end timings.** `SlowServerData` reports `start 1.29ms → end 1503.29ms`, which is
the 1.5s sleep I wrote.

**The debug-channel framing would have been guessed wrong.** These are *binary* websocket
frames with a length-prefixed multiplexing header, not text:

```
frame 2  first bytes: " v5WticMZ6f7VOREa2rv6i:N1788462440035.4…"   charCode[0]=0
frame 5  first bytes: " v5WticMZ6f7VOREa2rv6i75:[[\"SlowServerD…"   charCode[0]=0
frame 6  first bytes: " v5WticMZ6f7VOREa2rv6i"                      charCode[0]=0
frame 10 first bytes: " \b50f75e59:N1788462442132.1802\n"                 charCode[0]=0
```

`0x00`, then a **uint8 length**, then that many ASCII bytes of request id, then the
flight rows with **no separator**. `0x15` = 21 = the length of the
`x-nextjs-html-request-id` header value; `0x08` = 8 = the length of the
`x-nextjs-request-id` on the server-action POST. A frame whose body is empty after the
id (frame 6, frame 12) closes that request's channel. Ordinary HMR JSON frames on the
same socket start with `{` (charCode 123), so the discriminator is byte 0.

### 3. Server vs client

**Of a server-only component, the browser sees the rendered DOM and nothing else.**
Measured by grepping every served client asset for markers I planted:

```
SPIKE_SERVER_ONLY_SECRET_9f2a    hits in .next/static: 0
ServerOnlyWidget                 hits in .next/static: 0
SlowServerData                   hits in .next/static: 0
SPIKE_SERVER_RENDERED_TEXT       hits in .next/static: 0
SPIKE_ACTION_SERVER_MARKER       hits in .next/static: 0
ClientCounter                    hits in .next/static: 1   ← only my own <h2> text
echoAction                       hits in .next/static: 1   ← see §5
```

and in the page itself (`htmlHasServerSecret` is a real `document.documentElement.outerHTML.includes(…)`):

```
htmlHasServerSecret: false
htmlHasServerMarker: true          (the rendered text, obviously)
htmlHasActionServerMarker: false
```

**The normal fiber path is intact, in both dev and prod, on server-rendered elements too.**
Read off real elements:

```
dev  serverOnlyFiberKeys : ["__reactFiber$rsss5gi9t1","__reactProps$rsss5gi9t1"]
prod serverOnlyFiberKeys : ["__reactFiber$g1ovzz6trz4","__reactProps$g1ovzz6trz4"]
prod serverOnlyReactProps: ["id","data-computed","children"]
```

`__reactFiber$…` exists on `<div id="server-only">` — a div a server component produced.
DevFlow's existing `core/react/fiber.ts` entry point therefore still *attaches*. What
changes is what it finds once attached.

**The big one, and it argues against the project's stated position: in dev, a server
component's identity is readable directly off the DOM element's fiber.** Walking up from
`<div id="server-only">` and dumping `_debugInfo`:

```json
{ "d": 0, "tag": 5, "type": "div",
  "_debugInfo": [
    { "time": 7.060126953125291 },
    { "name": "ServerOnlyWidget", "key": null, "env": "Server",
      "owner": { "name": "Page", "key": null, "env": "Server", "props": {…} },
      "stack": [["Page","…/.next/dev/server/chunks/ssr/[root-of-the-server]__0f3blm3._.js",198,264,187,1,false]],
      "props": { "label": "from-page" } },
    { "time": 7.096710953125239 } ],
  "keysOnFiber": ["_debugInfo","_debugOwner","_debugStack","_debugTask","_debugNeedsRemount","_debugHookTypes"] }
```

No wire parsing needed for that. It is a tree walk, in the browser, that yields server
component names, owners, props and source frames. The `<main>` above it carries the same
for `Page`.

**In prod every one of those fields is gone.** Same probe, `next start`:

```
walk-up debug fields still empty? true
0 5 div  | _debugInfo= null | _debugOwner= null | debugKeys= []
1 5 main | _debugInfo= null | _debugOwner= null | debugKeys= []
```

and the client component's own fiber `type` is minified to nothing usable:

```
dev  names: <button> > <div> > ClientCounter > <main> > SegmentViewNode > … > OuterLayoutRouter > <body> > <html> > …
prod names: <button> > <div> > anon-fn      > <main> > null            > … > T                 > <body> > <html> > …
prod: any hasDebugStack? false   any hasDebugOwner? false
```

Also worth knowing operationally: **`self.__next_f` is empty by the time you can read it.**

```
dev : { next_f_isArray: true, next_f_length: 0, next_f_hasPushOverride: true,
        inlineFlightScriptTagsStillInDOM: 3, totalInlineFlightBytes: 7753 }
prod: { next_f_isArray: true, next_f_length: 0, next_f_hasPushOverride: true,
        inlineFlightScriptTagsStillInDOM: 3, totalInlineFlightBytes: 4584 }
```

The flight client replaces `push` and drains the array, so the global is a dead end. The
inline `<script>` tags **do** remain in the DOM, so an extension must re-read the payload
out of the DOM (or intercept the response), never out of `self.__next_f`.

### 4. Source location

**Dev: yes, and entirely from the browser.** Full round trip, all three legs run.

Leg 1 — the debug channel gives a frame in the *compiled server chunk*:

```
[["ServerOnlyWidget","…/.next/dev/server/chunks/ssr/[root-of-the-server]__0f3blm3._.js",93,263,91,1,false]]
```

Leg 2 — dev serves that chunk's source map over HTTP:

```
GET /__nextjs_source-map?filename=<uri-encoded abs path>
status=200 ct=application/json size=7413
```

It is an **indexed (`sections`) map**, not a flat one — `sources` at top level is `[]` and
`mappings` is `""`; a reader that only handles flat maps will conclude there is nothing there:

```
keys: [ 'version', 'sources', 'sections', 'sourceRoot' ]
sources: []          mappings length: 0          sections: 9
```

Its sections do carry the originals, with `sourcesContent`:

```
file:///…/spike-rsc/app/components/ServerOnlyWidget.tsx
file:///…/spike-rsc/app/components/SlowServerData.tsx
file:///…/spike-rsc/app/page.tsx
file:///…/spike-rsc/app/components/ActionForm.tsx/__nextjs-internal-proxy.mjs
file:///…/spike-rsc/app/components/ClientCounter.tsx/__nextjs-internal-proxy.mjs
sourcesContent? true
```

Leg 3 — resolving the debug-channel frames through it (node's `module.SourceMap`):

```
ServerOnlyWidget @compiled 93:263  -> app/components/ServerOnlyWidget.tsx:7:5
ServerOnlyWidget @compiled 97:264  -> app/components/ServerOnlyWidget.tsx:8:7
SlowServerData   @compiled 139:11  -> app/components/SlowServerData.tsx:2:9
SlowServerData   @compiled 140:263 -> app/components/SlowServerData.tsx:4:5
Page             @compiled 188:263 -> app/page.tsx:11:5
Page             @compiled 198:264 -> app/page.tsx:13:7
```

Those are the exact lines I wrote. Note the client components resolve only to a generated
`__nextjs-internal-proxy.mjs`, not to their `.tsx` — the RSC-side map knows the proxy, and
the real client source is in the *client* chunk's map.

Next's own resolver endpoint did **not** do this for me — it accepted the request and
returned nulls, so it is not a shortcut:

```
POST /__nextjs_original-stack-frames
[{"status":"fulfilled","value":{"originalStackFrame":{"file":".next/dev/server/chunks/ssr/[root-of-the-server]__0f3blm3._.js","line1":null,"column1":null,"ignored":false,"methodName":"ServerOnlyWidget"},"originalCodeFrame":null}}, …]
```

**Prod, default config: no route at all.**

```
=== .map files in prod static ===   count: 0
=== sourceMappingURL in a prod client chunk? ===   (none — file ends mid-expression)
=== is /__nextjs_source-map available in prod? ===  404
=== prod server ssr chunk maps on disk ===  count: 37
```

Server-side maps exist **on disk under `.next/server/`** and are not served. The one
mapping from a prod wire fact to a file is likewise **on disk only**:

```
.next/server/app/page_client-reference-manifest.js
"[project]/app/components/ClientCounter.tsx" => {"id":56850,"name":"*","chunks":["/_next/static/chunks/3fntmmi971322.js","/_next/static/chunks/0h52v0jkvejiz.js"],"async":false}
"[project]/app/components/ActionForm.tsx"    => {"id":7523,"name":"*","chunks":[…],"async":false}
```

`56850` and `7523` are exactly the ids in the prod `I` rows. **This file is never served.**
I tried the three plausible paths:

```
/_next/server/app/page_client-reference-manifest.js -> 404
/_next/static/chunks/page_client-reference-manifest.js -> 404
/_next/app/page_client-reference-manifest.js -> 404
```

**Stated as plainly as I can, because it decides where the reader lives: in production the
only route from a wire fact to a source file is a build-time artifact on the filesystem.
DevFlow's extension cannot reach it. DevFlow's MCP server can.**

Two partial escapes, both measured:

- `productionBrowserSourceMaps: true` **does** serve client maps, and they resolve:
  ```
  map fetch status=200
  sources in the served map for the chunk holding client module 56850:
     turbopack:///[project]/app/components/ClientCounter.tsx
     turbopack:///[project]/app/components/ActionForm.tsx
     turbopack:///[project]/node_modules/next/src/build/webpack/loaders/next-flight-loader/action-client-wrapper.ts
  ```
  Watch the indirection: chunk `175t--9kp5cdv.js` points at `0n4ml1qi_z1-x.js.map`, a
  *differently named* file, so you must follow `//# sourceMappingURL=` rather than append
  `.map`. This gets **client** components back. It does **not** restore any server-component
  debug info — I re-ran the fiber probe against that build and every debug field was still
  null.
- The server action keeps its export name in prod; see §5.

### 5. Server actions

Request — captured from a real click in a real browser, prod:

```
POST http://localhost:3001/
next-action: 40f43782738bb9c45a0870d2dcbb114f82c8acb929
accept: text/x-component
content-type: text/plain;charset=UTF-8
next-router-state-tree: %5B%22%22%2C%7B%22children%22%3A%5B%22__PAGE__%22%2C%7B%7D%2Cnull%2Cnull%2C4096%5D%7D%2Cnull%2Cnull%2C4112%5D
POST BODY: ["SPIKE_ACTION_INPUT_7c1"]
```

Three things there are not what you would assume: it is a **POST to the page's own URL**,
not to any action endpoint; the content type is **`text/plain`**, not JSON; and the
arguments are a **bare positional JSON array**.

Response, prod (`content-type: text/x-component`):

```
0:{"a":"$@1","f":"","q":"","i":false,"b":"N6ERiiVOTKNd_ggvd4jqX"}
1:{"echoed":"SPIKE_ACTION_INPUT_7c1","at":"SPIKE_ACTION_SERVER_MARKER","len":22}
```

Same in dev, plus a debug row and `"b":"development"`:

```
0:{"a":"$@1","f":"","q":"","i":true,"b":"development"}
1:D"$2"
1:{"echoed":"SPIKE_ACTION_INPUT_7c1","at":"SPIKE_ACTION_SERVER_MARKER","len":22}
```

`"a"` is the action result as a promise reference; `"f"` would carry a re-rendered tree
when the action revalidates (empty here). The action id is **build-specific**: dev
`407b166389441c1666eec1bde1af6e797f736ab3f6`, prod `40f43782738bb9c45a0870d2dcbb114f82c8acb929`.

**Server actions are the one thing that keeps source identity in production**, from two
directions. On disk:

```
.next/server/server-reference-manifest.json
{"node":{"40f43782738bb9c45a0870d2dcbb114f82c8acb929":{
   "workers":{"app/page":{"moduleId":57526,"async":false,"codeHash":null}},
   "filename":"app/actions.ts","exportedName":"echoAction"}},"edge":{},"encryptionKey":"…"}
```

and, unusually, **in the minified prod client bundle itself**:

```js
let c=(0,n.createServerReference)("40f43782738bb9c45a0870d2dcbb114f82c8acb929",n.callServer,void 0,n.findSourceMapURL,"echoAction");
```

The literal `"echoAction"` survives minification because it is a string argument. So a
prod browser can map `next-action: 40f4378…` → the export name `echoAction` by reading the
served chunk, with no filesystem. The *file* still needs the manifest.

### 6. Streaming

Per-chunk arrival, prod, RSC-only response (timestamps are real):

```
[+0ms]    STATUS 200 content-type=text/x-component transfer-encoding=chunked
[+9ms]    CHUNK 1 (587 bytes)   — all the I rows and symbol rows
[+10ms]   CHUNK 2 (2799 bytes)  — row 0, the shell; contains "children":"$L7"
[+10ms]   CHUNK 3 (126 bytes)   — b: meta tags
[+10ms]   CHUNK 4 (54 bytes)    — 9:null / d: title
[+1511ms] CHUNK 5 (173 bytes)   — 7:["$","div",null,{"id":"slow-server-data",…}]
[+1512ms] END after 5 chunks
```

The stitch is by **row id alone**. Chunk 2 emits the Suspense element with
`"children":"$L7"` — a forward reference to a row that does not exist yet. 1.5 seconds
later a row whose id is `7` arrives and the reference resolves. There is no envelope, no
boundary marker, no ordering guarantee; ids are the only join key, and **a reference is
routinely seen before its referent**. (This is the same hazard as OTLP spans arriving
leaf-first — the reader must accumulate and resolve, never assume arrival order.)

The HTML response streams *two* things in parallel, and they are stitched differently:

```
[+12ms]   CHUNK 1 — …<!--$?--><template id="B:0"></template><div id="slow-fallback">LOADING_SPIKE_FALLBACK</div><!--/$--></main>…
[+12ms]   CHUNK 2 — <script>self.__next_f.push([1,"1:\"$Sreact.fragment\"\n2:I[39756,…"])</script>
[+1513ms] CHUNK 3 — <script>self.__next_f.push([1,"7:[\"$\",\"div\",null,{\"id\":\"slow-server-data\",…"])</script>
[+1513ms] CHUNK 4 — <div hidden id="S:0"><div id="slow-server-data">…</div></div><script>…$RC("B:0","S:0")</script>
[+1514ms] CHUNK 5 — </body></html>
```

DOM side: a `<!--$?-->` marker plus `<template id="B:0">`, then the real content delivered
out-of-order into `<div hidden id="S:0">` and moved by `$RC("B:0","S:0")`. Flight side: the
same content again as row `7`. **A reader watching the DOM and a reader watching the flight
stream will each see the suspended content, at the same moment, in different form.** In dev
the *third* channel (the websocket) delivers `74:J{"name":"SlowServerData","start":1.29,"end":1503.29,…}`
at the same instant.

### 7. Where `core/otel` fits

I wired `@vercel/otel` via `instrumentation.ts`, pointed `OTEL_EXPORTER_OTLP_ENDPOINT`
at my own collector on :4318, and ran both servers. Spans arrived:

```
[collector] listening on 4318
[collector] delivery=1 url=/v1/traces  ct=application/json      bytes=8258  parsedJSON=true
[collector] delivery=4 url=/v1/metrics ct=application/x-protobuf bytes=1732 parsedJSON=false
```

**Traces come as OTLP/JSON; metrics come as OTLP/protobuf on the same endpoint.** A
receiver that assumes one content type per port will choke on `/v1/metrics`.

Four facts `core/otel` already asserts, re-confirmed against this exporter:

```
typeof startTimeUnixNano: string "1788462676131000000"
exceeds MAX_SAFE_INTEGER: true
traceId: 8722dc6eb867fda320387e3e0c3a7128 len 32 | spanId: 5fc12689e4af0848 len 16
```

`traceparent` continuation works exactly as `core/trace` needs — I sent
`00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01`:

```
distinct traceIds: [ '4bf92f3577b34da6a3ce929d0e0e4736' ]
matches the traceparent we sent? true
root-ish: NextServer.getRequestHandler parentSpanId= 00f067aa0ba902b7
```

The root span parents on **DevFlow's own client span id**, which will never arrive — the
"parent not present" rooting rule in `buildSpanTree` is exactly right for Next.

**But there is no server-component span.** 30 spans across a page load and an action:

```
NextServer.getRequestHandler / getServerRequestHandler / GET / POST
BaseServer.render / renderToResponse / renderToResponseWithComponents / pipe
LoadComponents.loadComponents / resolve page components / resolve segment modules ×2
build component tree / NextNodeServer.clientComponentLoading
AppRender.renderToReadableStream ×2 / AppRender.waitShellReady ×2 / AppRender.renderToNodeFizzStream
render route (app) / / rendering page / start response
```

Every attribute key emitted, anywhere, even with `NEXT_OTEL_VERBOSE=1`:

```
http.method  http.status_code  http.target
next.clientComponentLoadCount  next.route  next.rsc  next.segment
next.span_category  next.span_name  next.span_type  operation.name
```

And the direct test:

```
=== any attribute value mentioning our component or file names? ===
NONE — no span attribute anywhere names a component, a file, or the server action.
```

The richest span is route-level, not component-level:

```json
{"name":"render route (app) /","kind":1,
 "startTimeUnixNano":"1788462676131000000","endTimeUnixNano":"1788462677634700584",
 "attributes":[{"key":"next.span_type","value":{"stringValue":"AppRender.getBodyResult"}},
               {"key":"next.route","value":{"stringValue":"/"}}]}
```

`next.segment` exists but is useless for identity — the only two values emitted were
`""` and `"__PAGE__"`. The server-action POST produces a span named `POST` with
`http.target: "/"` and **nothing naming the action** — the `next-action` id is not on the
span, so an OTel-only reader cannot tell one action from another.

One dev-mode complaint worth recording, printed by Next itself:

```
Unexpected root span type 'BaseServer.renderToResponseWithComponents'. Please report this Next.js issue
```

**Conclusion for question 7: OTel gives DevFlow the request→route→timing spine for free,
today, with no new code — and it gives zero component identity.** Server-component
attribution and OTel spans are disjoint sources; they join on the route and the trace id,
not on a component.

---

## What I could not measure

- **Webpack.** Next 16 defaults to Turbopack and I did not force the webpack builder.
  Module ids, chunk naming, the `[project]/…` path syntax and the indexed-source-map shape
  are all plausibly bundler-specific. Every §2/§4 claim about *format* should be re-checked
  before assuming it holds for a webpack app.
- **Client-side navigation.** Single `force-dynamic` route; I never made the router fetch a
  new segment. I did not observe `next-router-state-tree` round-tripping, segment prefetch
  payloads, or the `next-router-prefetch` variants that `Vary` advertises.
- **Any Next version other than 16.3.4 / React 19.2.8.** The debug channel and the `J` row
  type are recent React additions; I have no evidence about 14.x or 15.x, which is what most
  real apps run.
- **Whether the dev debug channel can be enabled in prod.** I did not find or test a flag. I
  tested `productionBrowserSourceMaps` only, which does not do it.
- **Error and rejection paths.** No server component threw, no action failed, no
  `error.tsx` rendered. `core/otel`'s finding 7 — that the failure path is the richest
  evidence — is exactly the path I did not exercise here.
- **`cache: 'force-cache'` / static prerender.** My page was `force-dynamic`; the prerendered
  `.rsc` file on disk for a static route is a different artifact I never looked at.
- **Deployed/serverless.** Everything was localhost. On Vercel, `.next/server/` may not be
  reachable even to a local MCP server, which would break the one prod route in §4.
- **Multiple concurrent requests on the debug channel.** The length-prefixed request id
  implies multiplexing; I only ever had one page in flight, so I never saw two ids interleave
  and cannot confirm rows never split across frames mid-row.
- **`react-server-dom-*`'s own client parser.** I wrote my own row splitter. I did not verify
  my reading against React's `createFromReadableStream`, so my row-type inventory is
  "everything I saw", not "everything that exists".
- **Vue/Svelte comparison.** Out of scope for this spike; nothing here says anything about
  whether their adapters would share an interface.

---

## Consequences for the adapter contract

**RSC does not fit a runtime-tree `FrameworkAdapter`, and the reason is sharper than
"it is a protocol".** The measured reason is that *the identity is in a different place in
dev and in prod, and in prod it is not in the browser at all*. A fiber adapter's contract —
"given an element, walk up and name the components" — is satisfiable for RSC in dev (§3,
`_debugInfo` is right there on the fiber, no protocol parsing) and is **unsatisfiable in
prod for server components at any price**. That is not a shape mismatch; it is a
capability mismatch that no interface can paper over.

So the honest contract has a fourth return value beyond "found / not found / not
applicable": **"this element was produced by a server component whose identity is not
present in this build"**. Any interface designed without it will make a prod RSC adapter
lie. This is the finding most likely to change a shared interface's design.

The project's position — *"a protocol to read, not a runtime tree to adapt"* — **half held
up**. It is right about prod, where there is genuinely nothing to walk and the only signal
is bytes on the wire. It is **wrong about dev**, where the cheapest and richest route is a
tree walk over `fiber._debugInfo` that never touches the wire, and where the wire actually
*lacks* the identity that the fiber has. A design that commits to protocol-reading only will
do more work than necessary in dev and still fail in prod.

Where the reader belongs, given §4:

- **`src/core/` — a pure `parseFlightRows(text) → Row[]`.** Row splitting, the
  `<hexid><tag>:` grammar, `$L`/`$`/`$S`/`$@` reference resolution, and accumulate-then-resolve
  for out-of-order rows (§6). This is exactly `core/otel`-shaped: pure, no port, no
  filesystem, decidable in a unit test. It is also the smallest piece.
- **The extension** can own: reading inline flight `<script>` tags out of the DOM (never
  `self.__next_f`, §3), reading `fiber._debugInfo` in dev, mapping `next-action` ids to
  export names out of the served chunk in prod (§5), and — with
  `productionBrowserSourceMaps` — resolving client components to `.tsx` via served maps.
- **`mcp-server/` must own everything else in prod**, because it is the only half with a
  filesystem: `page_client-reference-manifest.js` (numeric module id → file),
  `server-reference-manifest.json` (action id → `filename` + `exportedName`), and the 37
  unserved `.next/server/**/*.map` files. This is the same split `mcp-server/otel.js` already
  represents, and it is forced by measurement rather than taste.
- One shared piece is reusable as-is: the source-map decode. Both the dev
  `/__nextjs_source-map` response and the on-disk server maps are **indexed (`sections`)
  maps** whose top-level `sources`/`mappings` are empty (§4) — whatever `core/react/vlq.ts`
  and `sourcemap.ts` do today must handle `sections` or it will silently report "no mapping".
