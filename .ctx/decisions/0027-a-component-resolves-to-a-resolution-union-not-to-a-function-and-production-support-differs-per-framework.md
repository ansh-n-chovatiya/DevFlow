---
ctx_schema: 1
adr: 27
title: a component resolves to a Resolution union, not to a function, and production support differs per framework
status: accepted
date: 2026-09-04
---

# 0027. a component resolves to a Resolution union, not to a function, and production support differs per framework

## Context
Wave 0 has to settle what a 'component' means when it is not a fiber, for three runtimes. Three measurement spikes ran real apps in dev and production builds and printed what each runtime exposes (.ctx/spike-vue.md, .ctx/spike-svelte.md, .ctx/spike-rsc.md, all 2026-09-04).

The finding none of the three spikes was asked to look for, and all three returned independently: every one of these runtimes is rich in development and stripped in production, and they are stripped by different amounts.

DEV. Vue puts __vueParentComponent on every rendered element and type.__file on the component. Svelte puts __svelte_meta = {loc:{file,line,column}, parent:<chain>} on elements, which is strictly richer than React's own _debugSource. Next.js dev puts _debugInfo on the fiber carrying name, env:'Server', owner chain, props and a stack that resolves through /__nextjs_source-map to app/components/ServerOnlyWidget.tsx:7:5 — measured end to end.

PRODUCTION. Vue strips __vueParentComponent and __vnode from every element; only the mount container keeps __vue_app__ and _vnode, and an O(tree) walk from there does still resolve, provided it follows suspense.activeBranch or it reaches nothing on Nuxt. Installing the devtools hook at runtime does not restore the element links — measured, Vue only writes to the hook when the build already enabled it. Svelte production elements have zero own properties; the only element-to-function edge is element[Symbol(events)][name], which exists solely for the 23 delegated events, yields the handler rather than the component, and produced a 9-character needle against MIN_NEEDLE_LEN = 12. SvelteKit's default production build ships zero source maps — verified by building twice, 0 .map files and no sourceMappingURL without build.sourcemap: true. RSC production server components leave no name, no module id and no file anywhere on the wire; client components survive only as an opaque integer whose file name lives in .next/server/*-manifest.js, which 404s on every served path.

Separately measured and relevant: @vercel/otel with NEXT_OTEL_VERBOSE=1 produced 30 real spans carrying zero component or file identity in any attribute.

## Decision
The adapter contract's central type is a Resolution union, not 'element to component function':

  declared  — the runtime already knows the source. Svelte's __svelte_meta.loc, Vue's type.__file, React's _debugSource, the compiler plugin's stamp, RSC dev's _debugInfo stack. This arm skips the search engine entirely and is the best answer wherever it exists.
  searchable — a JavaScript function whose toString appears in a served bundle. This is the existing needle path and it is proven on all three runtimes.
  absent    — the identity is not present in this build, with a reason that says which of the measured cases it is: stripped-by-build, server-rendered, not-hydrated, or no-source-map.

'absent' is a first-class, explainable outcome rather than a failure, because for Svelte production it is the common path rather than the edge case. ComponentSource.via — 'debug-source' | 'bundle-search' | 'plugin' — is already this union in disguise, and generalising it is the whole change. needle.ts already returns 'too-short' as a reason rather than a silence, which is the same instinct.

Identity is separate from the searchable function, because Vue's instance.type is an object rather than a function, and its needle must be taken from instance.render — measured: through the real source map, setup's start resolved to the wrong file in 3 of 4 production cases, once landing in runtime-dom.esm-bundler.js, while render was correct 4 of 4.

fromElement is permitted to be expensive and to fail with a reason. Vue production needs an O(tree) walk; Nuxt island interiors have no client vnode at all.

What each adapter honestly delivers is written into the roadmap per build mode rather than as one tick. All three work in development. In production Vue degrades to a tree walk that works, RSC degrades to client components only and needs mcp-server to read manifests the browser cannot, and Svelte degrades to nothing.

## Consequences
ADR 0017's rule — three together or not at all — is satisfiable and is being satisfied. But 'a Svelte adapter' cannot mean in production what it means in development, and a roadmap tick that hid that would be the exact defect this project keeps catching: a claim nobody ran.

The RSC bullet's stated reasoning in ROADMAP 5.1 and in 0017 is wrong in both directions and is corrected in the roadmap: a server component does leave a runtime tree in dev (_debugInfo, richer than the wire), and in production there is no protocol to read either. core/otel is not where the RSC case starts, because its spans carry no attribution.

A prod RSC adapter is forced across the extension/mcp-server boundary, because only the server half has a filesystem. That is the split mcp-server/otel.js already represents, and it is forced by measurement rather than taste.

Svelte's honest production answer may be to report absent with a reason naming build.sourcemap, which is a one-line fix in the user's own config. That is a better product than a confident wrong file.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
