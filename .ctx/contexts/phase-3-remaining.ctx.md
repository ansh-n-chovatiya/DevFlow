---
ctx_bundle: 1
name: phase-3-remaining
scope: project
created: 2026-09-02
project: DevFlow
tags: [phase-3, work-stream-3.3, work-stream-3.5, costing, scope, resolved]
---

# Context — phase-3-remaining

> **RESOLVED 2026-09-03. Do not act on the "Resume here" section as written —
> it has been replaced at the bottom of this file.** 3.3 is built and merged
> (`614252d`, merge `54ae8a4`); 3.5 is deferred to Phase 5 §5.4 as three work
> streams. Phase 3 is closed as scoped. What is kept below is the *costing* that
> led there, because one of its central claims turned out to be true and
> load-bearing in the opposite direction from how it was written — see the
> replacement.

## Situation

Phase 3 of `ROADMAP_AND_PHASES.md` has five work streams. Three are shipped and
on `main`: 3.4 (Temporal Diff), 3.1 (trace headers through OTel Tier 2) and 3.2
(value lineage to the backend, merged in `50fb793` on 2026-09-02). The two that
remain — **3.3 Living Architecture Map** and **3.5 Framework-Agnostic Adapters** —
are the two the previous three deliberately went ahead of, and neither is a
smaller job than the ones already done. Both need costing before either is
promised, and neither should be started on the momentum of 3.2.

## Established facts

**Work Stream 3.3 — Living Architecture Map (`[ ]`, nothing exists)**

- What the roadmap asks for (lines 430–439): a *real-time* component graph —
  "which components are **currently mounted**, subscribed state stores, active
  API calls", "updates in real-time as the developer navigates the app" — plus
  interactive graph queries and an MCP tool `get_living_architecture()`.
- **"Real-time" and "currently mounted" describe a live connection to an open
  page, not a graph query. Nothing shipped so far works that way.**
  `get_app_architecture` reads the ARKG, which is an *accumulation* over past
  recordings — it answers "what has been seen", never "what is mounted now".
- `get_living_architecture` is not declared, stubbed or referenced anywhere in
  `src/` or `mcp-server/`.
- **The data direction is wrong for it, and this is the cost.** Every path into
  the MCP server is the extension *pushing* over loopback HTTP: `POST /flows`,
  `POST /config`, `POST /arkg/ingest-component`, `POST /v1/traces`,
  `DELETE /flows/:id`, `GET /health`. There is **no channel from the server back
  to an open tab**. A model calling `get_living_architecture()` needs an answer
  synchronously from a page the server cannot address.
- The page-side reading it would need does partly exist, but only *inside a
  step*: `src/injected/` samples fibers and stores twice per interaction (once in
  the click, once after the app settles) and never subscribes, patches or
  installs anything — the refusal in `src/injected/state.ts`. A continuous map
  wants either a commit hook (which that file refuses, for the reason `v3.2.0`
  was reverted) or a poll (whose CPU cost lands on every recorded page against
  the <2% NFR).
- So the honest options to cost are roughly: (a) a persistent extension↔server
  channel plus a page-side sampler bounded like `recording.renderNodeCap`;
  (b) narrowing "living" to *the last observation* — a snapshot the panel already
  could take on demand — and correcting the roadmap's wording the way 3.2's
  `get_full_lineage(domNodeId)` and 3.4's `compare_flows_across_deploys` wordings
  were corrected; (c) refusing it and writing the argument down.

**Work Stream 3.5 — Framework-Agnostic Adapters (`[ ]`, nothing exists)**

- Three bullets (lines 457–460): a Vue 3 / Nuxt adapter (reactivity proxy +
  template AST mapper), a Svelte 5 / SvelteKit adapter (runes and signals), and
  Next.js App Router / React Server Components across the RSC wire protocol.
- **Vue 3, Svelte 5 and RSC do not share React's fiber tree, and nothing in
  `src/core/react/` transfers.** That directory is fifteen modules — `fiber.ts`,
  `owner.ts`, `table.ts`, `chains.ts`, `classify.ts`, `needle.ts`, `stamp.ts`,
  `search.ts` and the source-map engine — and its entry points are all *fiber*
  shaped.
- **It is three Phase-1-sized work streams, not one**, and the roadmap says so in
  the Phase 3 preamble (lines 288–290): *"Starting one and leaving two would be
  worse than starting none."*
- The project's own "What NOT to Build" table (line 572) already flags
  Vue/Svelte before Phase 3 with: *"Each adapter is a major investment. Deep
  React beats shallow multi-framework."* Phase 5's Work Stream 5.4 carries the
  same three frameworks again, at deeper scope.

**Common ground**

- `npm run verify` is green on `main`: 145 test files, 3218 tests. Six commits
  (3.1 Tier 2 and 3.2) are ahead of `origin/main` and **unpushed; pushing has not
  been asked for.**
- The habit that made 3.1, 3.2 and 3.4 good applies to both of these: **measure
  the foreign thing rather than reasoning about it.** A two-origin Playwright
  probe settled the CORS rule; a throwaway `@opentelemetry/sdk-trace-node`
  service settled four wire facts of which three would have been got wrong by
  reasoning; throwaway git repositories settled 3.4's parser. Playwright 1.62.1
  with real Chromium is reachable from this machine out of the npx cache
  (`find ~/.npm/_npx -path '*node_modules/playwright/index.js'`), which is what a
  Vue or Svelte adapter's first hour should spend itself on: print the real
  reactivity object, do not read about it.

## Decisions made

- **3.4 first, 3.1 second, 3.2 third — and the ordering was argued, not
  incidental.** 3.4 was cheapest (a commit join onto the existing
  `compare_flows`) and closed three Phase 0 items on the way; 3.1 went next
  because its header injection is the first thing DevFlow does that is not
  observation, and a change that can break somebody's application is one to take
  deliberately rather than in the tail of a phase. 3.3 and 3.5 were left because
  each is a new mechanism rather than a join onto an existing one.
- **Do not build a third tool beside two that already answer halves of a
  question.** This repo made that mistake once with two markdown renderers;
  `src/core/mcp-bundle.ts` exists because of it. 3.2 obeyed it by extending
  `get_value_provenance` instead of shipping `get_full_lineage`. If 3.3 turns out
  to be a snapshot rather than a live feed, the same test applies to
  `get_living_architecture` versus `get_app_architecture`.
- **A roadmap signature that does not survive contact gets corrected in the
  roadmap, with the finding written out.** Precedent:
  `get_full_lineage(domNodeId)` (a recording describes elements and addresses
  none) and `compare_flows_across_deploys(flowId, sha1, sha2)` (one flow id names
  one commit). `get_living_architecture()` should be expected to need the same
  treatment.
- **Nothing may be installed on the page.** `src/injected/state.ts` refuses to
  define, patch, wrap or subscribe to anything; "inert when not recording" is not
  maintained, it is unviolatable. Any 3.3 design that needs a commit hook is
  arguing against that, and has to beat it explicitly.
- **A `[~]` carrying a *condition* is not a decision.** Either meet the condition
  or write the refusal — the shape §1.2 and §2.1 were resolved into.

## Open questions — all answered on 2026-09-03; kept with their answers

- [x] Which of 3.3 and 3.5 is worth starting? **3.3, and it was built. 3.5 is
      deferred as three (ADR 0017).**
- [x] For 3.3: what is the mechanism for a live read, given the server can only
      be pushed to and the page may not be instrumented? Is a persistent
      extension↔server channel in scope at all?
      **Answered: there is no live read and there does not need to be. The extension pushes one bounded reading; the tool renders it with its age. No persistent channel.**
- [x] For 3.3: does "currently mounted" survive the <2% CPU / <15MB NFR without a
      commit hook, or does it reduce to a bounded sampler on demand?
      **Answered: it reduces to a bounded on-demand walk, under the recorder's own `recording.renderNodeCap`, costing nothing when nobody asks.**
- [x] For 3.3: if the answer is a snapshot rather than a feed, is that 3.3
      delivered with the wording corrected, or 3.3 refused? Say which, in the
      roadmap.
      **Answered: delivered, with the wording corrected in the roadmap — ADR 0016.**
- [x] For 3.5: is the RSC bullet even the same kind of work as the other two? A
      server component never mounts in the browser, so it is a wire-protocol
      reader rather than a runtime-tree adapter — possibly closer to `core/otel`
      than to `core/react`.
      **Answered: no. A server component never mounts in the browser, so it is a wire-protocol reader — closer to `core/otel` than to `core/react`, and the roadmap now says to scope it there.**
- [x] For 3.5: if one adapter is built, what stops the other two being read as
      promised? The refusal to start one of three has to be re-argued or held.
      **Answered: none was built, so the question does not arise. The refusal is held and re-argued in ADR 0017.**
- [x] Is Phase 3 declared complete-as-scoped with 3.3 and 3.5 written out as
      refusals or deferrals, so that Phase 4 can start? Phase 4 does not depend
      on either.
      **Answered: yes. 3.5 is a written deferral, Phase 3 is closed, Phase 4 is unblocked.**

## Constraints

- **Invariant 1 — zero app dependency.** No npm package and no build change in
  the user's app. This is what makes an adapter hard: reading Vue's reactivity or
  Svelte's signals must be as non-invasive as the fiber sampler is.
- **`src/core/` is pure** — no `chrome.*`, no DOM, no `fetch`, no clock, no
  `node:` imports; it is bundled into `mcp-server/core.js`. A framework adapter's
  decisions go in `core/`, its DOM and page access in `injected/`/`features/`.
- NFRs that bound 3.3 specifically: <2% CPU and <15MB heap during recording,
  <100ms for any ARKG query, <50ms element inspection.
- Do not build a module with no caller. Do not tick a roadmap box unless
  `npm run verify` proves it, and read its exit code directly, never a pipe.
- Any change touching `src/` or `public/` needs a `## Unreleased` entry in
  `CHANGELOG.md`.
- Commit on a branch and merge; never straight to `main`. Update
  `ROADMAP_AND_PHASES.md` in the same commit as the work it describes.
- If work is blocked, finish everything else in full and name what was left out —
  scaling the work down is the user's call.

## Artifacts

- `ROADMAP_AND_PHASES.md`: Phase 3 preamble, lines 268–290 (why 3.3 and 3.5 were
  left, and the "three work streams, not one" argument); Work Stream 3.3, lines
  430–439; Work Stream 3.5, lines 457–460; "What NOT to Build", line 572; NFRs,
  lines 545–560.
- `README.md` "Where DevFlow is going", the Phase 3 row — the user-facing
  statement that the Living Architecture Map "needs a live connection to an open
  page, which nothing here does yet".
- What 3.3 would have to reach: `src/injected/` (the page agent — sampling, and
  the refusal to install anything), `src/core/render/blame.ts` (bounded walk,
  `recording.renderNodeCap`), `mcp-server/server.js` lines 1667–2200 (every HTTP
  endpoint the extension pushes to, and `extensionOrigin` at 1662).
- What 3.5 would have to replace: `src/core/react/` (15 modules), and its two
  bundle providers in `src/features/react/providers/`.
- `.ctx/contexts/devflow-state.ctx.md` — the standing project state, including
  the five Phase 0–2 refusals and the named gaps.
- `git log --oneline aa98649..HEAD` — the whole of Phase 3 as built.

## Resume here

**Both open work streams are resolved. Phase 4 is what is next, and nothing
blocks it.**

**3.3 shipped, and the finding is worth carrying forward.** This bundle's
costing said the blocker was that "every path into the MCP server is the
extension *pushing*… there is **no channel from the server back to an open
tab**". That is entirely correct, and it is only a *cost* if the tool must
**pull**. It does not. A model calling a tool asks once, at a moment, and reads
one answer — so what the roadmap called a real-time feed can only ever be a
reading with an age on it, and the extension could already push one. Option (b)
in the costing above was the right one, and it was right for a sharper reason
than "narrowing": the snapshot is not a reduced feed, it is what the feed would
have degenerated to anyway at the point a model reads it.

The general shape is worth remembering: **when a mechanism looks blocked, check
which direction the requirement actually runs in before costing the channel.**
Three roadmap signatures have now failed contact in a row (`get_full_lineage`,
`compare_flows_across_deploys`, `get_living_architecture`) and all three failed
by assuming the caller could address something it cannot.

- ADR 0016 — the map is a reading with an age, not a feed. Also records what was
  refused: active API calls (an in-flight request leaves no trace on the fiber
  tree), ARKG accumulation, and any on-disk persistence.
- ADR 0017 — the three adapters are deferred to Phase 5 §5.4, not started as one.
- `ROADMAP_AND_PHASES.md` §3.3 and §3.5 carry both arguments in the roadmap's own
  voice.

**Nothing is open.** The one remaining gap — the animated *"show me everything
that renders when I click checkout"* graph — shipped as the **cascade** in Flow
review. `core/cascade` is the join; `ui/viewer/cascade.ts` draws it.

Two things in it were got wrong by reasoning and settled in minutes by printing
the real object, which is this project's most reliable habit and worth restating:

- `core/causal` writes a state event's ref as `state:<step>/<store id>/<n>`, not
  `state:N.1`. The rebuilt ref matched nothing, every render fell through to the
  weakest basis, and the picture looked entirely reasonable. `eventRef` exists so
  that nothing else builds a ref; the fix was to stop building one.
- A console line under a failing request has **two** parents — the step
  (`attributed medium`) and the request (`named high`). Layering by shortest path
  therefore drew the error beside the request rather than after it, hiding the
  only edge that said anything. Layers now come from the strongest incoming edge.

The refusal at the centre of it is the one to preserve: a component with no
observed subscription and no matching context name hangs off the **interaction**,
never off a store that merely moved in the same step.

**State at close:** `npm run verify` EXIT=0 on `main`, 146 test files, 3246
tests. Eleven commits ahead of `origin/main` and **unpushed; pushing has not been
asked for.**
