---
ctx_schema: 1
adr: 26
title: the source-map engine is framework-neutral and moves out of core/react
status: accepted
date: 2026-09-04
---

# 0026. the source-map engine is framework-neutral and moves out of core/react

## Context
ADR 0017's Context states that nothing in src/core/react/ transfers — 'fifteen modules ... whose every entry point is fiber-shaped' — and ROADMAP_AND_PHASES.md 5.1 repeats it. Both are false, by two independent measurements taken 2026-09-04.

CODE. Ten of the fifteen modules carry zero React references in code (comments excluded): chains, editor, id, needle, owner, positions, search, sourcemap, stamp, vlq. provider.ts's five hits are settings key names inside doc comments. table.ts has one user-facing string. classify.ts has a 'react' category inside an otherwise neutral mechanism. Only fiber.ts (40 references) and attribution.ts (19) are genuinely fiber-shaped. Four core modules that have nothing to do with React — core/otel, core/architecture, core/provenance, core/source — already import core/react/positions.js today, so the tree already consumes this code as neutral from a React-named home.

RUNTIME. Three measurement spikes (.ctx/spike-vue.md, .ctx/spike-svelte.md, .ctx/spike-rsc.md) each grepped real production bundles for needles built with DevFlow's own buildNeedle constants. Vue: 14/14 byte-for-byte, dev and prod, Vue and Nuxt. Svelte: 3/3, decoding through the real source map to Counter.svelte:5 and KitCounter.svelte:4 exactly. RSC: client components resolve through served maps. Function.prototype.toString round-trips through all three runtimes exactly as through React. sourcemap.ts already handles indexed ('sections') maps, which is the shape Next.js emits — checked at line 228, before the mappings throw.

## Decision
The needle / bundle-search / source-map / editor-URL engine is framework-neutral and moves to a neutral home under src/core/. What stays in core/react/ is the fiber walk and the attribution rule built on it.

This does not overturn ADR 0017. 0017's rule is that the adapters are taken together or not at all, and its own overturn clause admits 'an argument for building all three', which is what is being built. What is corrected is a premise in its Context, and the correction makes 0017's decision cheaper to satisfy rather than wrong. ADR 0017 stands unedited; this ADR carries the measurement.

## Consequences
Each adapter is materially smaller than a Phase-1 work stream, because the expensive half is already built, already tested and already handles indexed source maps.

A neutral home is what prevents this repo's own named recurring mistake. With the engine left under core/react/, src/core/vue/ would import ../react/needle.js — which reads as Vue depending on React, is false, and is exactly the condition under which somebody makes a second copy. This project has grown a second markdown renderer and a second a11y renderer already.

The move is mechanical and wide: roughly 25 files change an import path, all inside src/ and mcp-server/. It is Wave 0 work, owned by one agent, and it is why Wave 0 exists.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
