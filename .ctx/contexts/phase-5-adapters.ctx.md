---
ctx_bundle: 1
name: phase-5-adapters
scope: project
created: 2026-09-04
project: DevFlow
tags:
  - phase-5
  - adapters
---

## Situation

Phase 5 §5.1's three framework adapters are **built, tested and merged to `main`
at `4e10040`**, and **not wired into the recorder**. `npm run verify` exits 0 —
166 files / 3670 tests, up from the 156 / 3437 baseline. The roadmap boxes are
`[~]`, deliberately.

## Established facts

- **The source-map engine is framework-neutral and now lives in
  `src/core/locate/`** — nine modules moved out of `core/react/`. ADR 0026.
  `npm run lint:locate` fails if anything there imports `core/react/`, and it is
  mutation-checked. `core/react/` keeps six modules: fiber, owner, attribution,
  classify, table, stamp.
- **ADR 0017's "nothing transfers" was false**, measured twice: ten of fifteen
  modules carried no React reference in code, and all three spikes hit real
  production bundles byte-for-byte with DevFlow's own `buildNeedle` constants.
  ADR 0017's *rule* (three together or not at all) stands and was satisfied.
- **A component is a `Resolution`** — `declared` / `searchable` / `absent` with a
  reason. `src/core/locate/adapter.ts`. ADR 0027. `declared.line` is **optional**
  because Vue records a file and no line; `at: 'declaration' | 'call-site'`
  exists because RSC's reachable frame is the call site.
- **Each runtime is rich in dev and stripped in prod, by different amounts.**
  Vue keeps a tree walk from `__vue_app__` (must follow `suspense.activeBranch`
  or Nuxt yields nothing). Svelte keeps **nothing** — zero own properties, and
  SvelteKit ships zero source maps by default. RSC keeps client components only;
  server components leave no identity at any price.
- **Measured traps worth not re-deriving:** Svelte's `__svelte_meta` records a
  1-based line beside a 0-based column in one object. Vue's needle must come from
  `instance.render`, never `type.setup` (`setup` resolved to the wrong file 3 of
  4 prod cases). RSC's flight grammar is `<hexid>:<tag>`, not `<hexid><tag>:`, and
  dev element tuples have **three** extra slots, not two. `self.__next_f` is
  drained to length 0 by hydration — read the inline `<script>` tags.
- **`lint:changelog` is deliberately not in `verify`** — its header says why.

## Open questions

- [ ] **The wiring chain, which is what `[~]` means.** (1) an adapter registry in
      `src/injected/agent.ts` + `src/content/index.ts`, merging with
      `preferResolution` where two runtimes claim one element — real for every
      Next.js page, which is React *and* RSC; (2) additive `vue?`/`svelte?`/`rsc?`
      keys on the persisted flow, on `react`'s own terms; (3) the MCP join, which
      cannot be called until (2) gives it data.
- [ ] **`lookupOriginal` returns null at every function start in a Vite dev SFC
      map** — the dev map has segments only on statement lines. Hits React on Vite
      too. Needs a forward scan; the right window needs measuring, so it was
      recorded rather than guessed.
- [ ] **`AbsentReason` may still be short one value** for Svelte production: a
      `<div>` the framework never touched is byte-identical to one it rendered.
      `not-rendered-here` was added for it; whether it can ever be *detected* in
      prod is unresolved.
- [ ] `docs/CONTRACTS.md` and `docs/MERGE-PLAN.md` name `core/react/positions.ts`
      and `core/react/editor.ts`, which have moved. Both are frozen — CONTRACTS by
      instruction, MERGE-PLAN because it declares itself the record of intent. Say
      they are wrong; do not fix locally.
- [ ] `main` is **42 commits ahead of `origin/main`**, unpushed. Nobody has asked.

## Resume here

Read `ROADMAP_AND_PHASES.md` §5.1's *"What is not wired"* section — it is the
whole of what is left, in order. Then `src/core/locate/adapter.ts`. The three
spikes in `.ctx/spike-{vue,svelte,rsc}.md` are the measured record and should be
trusted over any documentation about those runtimes.
