# DevFlow: Implementation Roadmap & Production Engineering Plan
### *Phased Delivery, Work Streams, and Technical Milestones*

---

## 🏛️ Core Design Invariants

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                       CORE ARCHITECTURAL INVARIANTS                         │
├──────────────────────────────────────┬──────────────────────────────────────┤
│ 1. ZERO-APP-DEPENDENCY (STANDALONE)  │ 2. HIGH-DENSITY TOKEN EFFICIENCY     │
│ • 0 npm packages required in user app│ • Hierarchical drill-down MCP tools  │
│ • 0 build configuration changes      │ • JSON Patch (RFC 6902) state deltas │
│ • 100% client-side Chrome hooks      │ • Out-of-band screenshot disk storage│
│ • Works out of the box on any app    │ • < 500 tokens per bug triage summary│
└──────────────────────────────────────┴──────────────────────────────────────┘
```

---

## Roadmap Overview

```
┌──────────────────────────────────────────────────────────────────────────────────────┐
│                              PHASED DELIVERY ROADMAP                                 │
├──────────────┬──────────────┬──────────────┬──────────────┬────────────┬─────────────┤
│   PHASE 0    │   PHASE 1    │   PHASE 2    │   PHASE 3    │  PHASE 4   │   PHASE 5   │
│ ARKG Schema  │Runtime-to-   │ Autonomous   │ Full-Stack   │ Production │ Framework   │
│ Foundation   │Source Intel  │ Bug Agent &  │ Wire &       │ & CI       │ Adapters    │
│              │              │ NL Navigator │ DB Lineage   │            │             │
│   shipped    │   shipped    │   shipped    │   shipped    │  shipped   │ not started │
└──────────────┴──────────────┴──────────────┴──────────────┴────────────┴─────────────┘
```

---

## Status key

`[x]` shipped, on `main`, covered by tests that run in `npm run verify`.
`[~]` partially shipped — the sub-bullets say which half.
`[ ]` not started.
`[—]` **decided against.** The line says what was decided and names the ADR that
carries the argument. A refusal keeps one line rather than being deleted, because
the argument is worth more than the absence: a deleted refusal is a question the
next reader asks again, and answers worse.

A box is ticked when the gate proves it, not when a file exists. The Phase 0–2
work first attempted in `v3.2.0` was reverted in full: `main` was reset to
`v3.1.1` after an audit found the MCP server would not boot, `typecheck` and 29
tests were red, and most ticked items were stubs. That work is preserved on the
`archive/antygravity-phase-0-2` branch and tag `archive/v3.2.0-antygravity`.
Nothing below is ticked on the strength of that branch.

---

## Phase 0: Accumulating Runtime Knowledge Graph Foundation
**Objective:** Lay the foundational data layer that every subsequent feature is built upon. The ARKG is DevFlow's deepest competitive moat and must be designed correctly from the start.

### Work Stream 0.1: ARKG Schema Design & SQLite Implementation
- [x] **Core Graph Schema:**
  - [x] Nodes: `components`, `api_endpoints`, `source_files`, `named_flows`
  - [x] Nodes: `state_keys` — one top-level key of one store, counting how often it was *changed* as well as how often it was seen. Keyed on the store's kind and label rather than its per-recording id, so one key is one node across recordings. `arkg_state_stores` beside it, so an edge has something to point at at the granularity it was observed.
  - [x] Nodes: `git_commits` — **shipped in Phase 3.** A commit somebody made a recording at, stamped by the MCP server out of the project it runs in at the moment the recording arrives. There is nowhere else the answer could come from: the extension has no filesystem and no repository, so asking the page means asking a browser about a checkout it cannot see. The node carries no `timing_p50`/`timing_p95`/`failure_rate` — nothing times a commit and nothing fails one — and no `frequency` either, which is the more interesting omission: the count it would hold (*how many recordings were made at this commit*) is a join away, because every flow node has a `git_sha`. A counter beside it would have to decide whether pressing **Send** twice on one recording is two recordings, and would drift from the join the first time it decided wrong.
  - [x] Edges: `renders`, `calls`, `maps_to`
  - [x] Edges: `subscribes_to` — component → **store**, not component → key. `subscribers` is observed per store (a component is on the list because its own fiber carried the context dependency); crossing it with the store's keys would give a component that reads `state.cart` an edge to `state.auth`, indistinguishable in the graph from one somebody saw. The hop from store to key is left as a hop, because that is what it is.
  - [x] Edges: `caused_by` — **audited and ticked.** A causal link reaches the graph only when *both* ends project onto a node the ARKG already keys stably, and the projection is the whole of the claim: a step onto the component it was attributed to, a network event onto its `api_endpoint`, a state event onto its `state_store`. A console entry projects onto nothing — it has no stable identity across recordings — so every link ending on one is dropped rather than given a node invented to hold it, and `tests/arkg-causal.test.ts` asserts that against the real builder rather than a mock. Two further classes are refused: a self-loop where both ends land on one node, and the component ↔ endpoint pair, which is the `calls` edge drawn a second time out of the same fact. Nothing is a cross-product — `echoed` and `named` are gated on evidence per pair, `attributed` is one link per event from its own step. The audit did find one defect and it is fixed: the projection is many-to-one, so a response echoed into two keys of one store was counted as two observations of one edge, contradicting this file's own rule that `frequency` counts recordings. `ingestCausal` now dedupes per flow on the full edge identity, the way `ingestState` already did.
  - [x] Edges: `changed_in` — **shipped in Phase 3.** Source file → commit, drawn at ingest from the files the recorded-at commit touched, and **only onto source files the graph has already seen code running in**. That is the `caused_by` rule — both ends must project onto a node the graph already keys stably — and it does more work here than it does there: every other edge in the graph joins two things observed in one browser, while this joins a path git printed to a path a bundler wrote. The two meet through `matchSourceFile` in `core/git`, exactly after normalisation or by a suffix that exactly one known file answers, and never by a guess; two files ending `src/index.ts` in a monorepo is precisely where a suffix rule is a coin toss. So a deploy touching forty files may draw three edges, and three is the honest number — the other thirty-seven are files no recording has run through, and *that gap* is what the runtime graph knows and `git log --name-only` does not. A `changed_in` edge has no frequency to accumulate: a commit changed a file once and will not do it again, so incrementing on the second recording made at that commit would be counting button presses and filing them as a fact about the repository. It is written by `insertFactEdge` rather than `upsertEdge` for exactly that reason, and re-ingest is therefore how a file the graph only learned about later gets its edge at all. A merge commit gets a node and no edges, which is what `git show --name-only` says about a merge and is true.
  - [x] Properties on every node/edge: `timing_p50`, `timing_p95`, `frequency`, `failure_rate`, `last_observed_at`
  - [x] `git_sha` — **shipped in Phase 3, and the meaning is narrower than the column name.** It reads *the last commit at which this node was observed with a clean working tree*, and each half of that was a decision. **Last**, because the `COALESCE` runs new-over-old, unlike the `source_file` beside it which keeps what it already knows — a later observation that lost the file learned nothing, while a later observation at a newer commit is exactly what the column is for. **Clean**, because a bare SHA column is a join key with no room beside it to record that the tree was dirty, and a dirty tree names a build that exists on no machine. So a dirty observation writes nothing — not even NULL, since erasing a commit that was true is not an improvement on failing to add one — and the recording's own `meta.json` keeps the whole truth, `dirty` and branch included. The rule is one expression (`joinableSha` in `src/core/git/index.ts`) rather than an `if` at each of the six write sites, because the way a rule about a column dies is a seventh site added by somebody who had not read the sixth. Crossed with `changed_in`, this is the fact worth having: a component whose `git_sha` is older than the commit that last changed its file is one the graph knows about from *before* the change. The `state_keys` and `arkg_state_stores` tables still have no `timing_p50`/`timing_p95` columns, for the reason this line originally gave: nothing times a state key.
- [x] **Observation Ingestion Pipeline:**
  - Every recorded flow writes to the ARKG automatically on completion.
  - Every component inspection writes a `maps_to` edge linking the DOM element → source file.
  - Merge strategy for duplicate observations: update `frequency` and `last_observed_at`, preserve `failure_rate`.
  - Re-sending one recording counts it once — `frequency` is an observation count, not a button-press count.
- [x] **Query Interface:**
  - `arkg.getComponent(id)` → full node with all edges
  - `arkg.getComponentHistory(id, since)` → all observations since a date
  - `arkg.getBlastRadius(sourceFile, lineRange)` → all components with runtime dependency on that range
- [x] **`arkg.getAnomalies(since)`** — **audited and ticked.** The σ test is over each entity's own `timing_samples` window — the one distribution this database holds — comparing that window's p95 against its own mean and population σ. It is a real baseline and not a constant: it says different things about an endpoint that has always taken 8ms and one that has always taken 800ms. A σ of zero reports nothing rather than dividing, so the steadiest node in the graph cannot become the loudest row in the answer. **Failure rate is not dressed as a baseline.** It has no per-entity distribution — only one rolling scalar — so the fixed 10%/5% thresholds stay, every anomaly carries `basis: 'threshold'` or `basis: 'baseline'`, and the failure-rate `detail` says in words that it is a threshold and why. Turning it into a baseline needs a stored per-flow failure history and a retention question, and is left undone rather than done badly. The audit found the other half had been built and not delivered: `getAnomalyReport` exists precisely so "not enough observations" and "nothing is wrong" can be told apart, and the MCP tool was still calling the bare array and hedging in prose that it could not tell which it held. The tool now spends `examined` and `tooNew`, and `tests/arkg-ingest.test.ts` asserts it from a spawned server — the only layer where that loss was visible.
- [x] **MCP Tools for ARKG:** `get_app_architecture`, `get_component_history`, `get_anomalies`

---

## Phase 1: Core Runtime-to-Source Intelligence
**Objective:** Evolve DevFlow from basic element picking into a standalone, token-efficient data-lineage and render causality inspector with **zero app modifications**, while feeding all observations into the ARKG.

### Work Stream 1.1: 100% Standalone Runtime Source Mapping
- [x] **Pure Client-Side Source Map Engine (Zero App Config):** — this is the shipped locator, and predates the ARKG work.
  - Parse inline/external source maps directly in the browser/service worker.
  - Traverse React Fiber back to original `src/` file, line, and column.
  - Zero requirement for users to install npm packages or alter build configs.
  - Every attribution carries a confidence score with a specific reason (`src/features/react/resolver.ts`).
- [x] **Fallback Chain:** source map → inline base64 source map → heuristics, each with its own reported failure mode.
- [x] **Optional Compiler Plugin (`devflow-compiler-plugin`) [Strictly Optional]:** built, and built against the objection rather than into it. Invariant 1 is that DevFlow needs no app changes, and a plugin is a change to the app's build. The risk was never that it would not work — it is that it would work *better*, and a plugin that becomes the path where attribution is reliable has made the zero-dependency path the degraded one, which is the invariant lost without anyone deciding to lose it. So the rule below was written before the first line of plugin code and shipped in the same commit as it.

  **The rule, and what it cost to write honestly.** The proposed first clause was *"the plugin may make an existing answer exact; it may not produce an answer the standalone path cannot"*, and that clause is **false as written** — which is worth recording, because agreeing to it unread is exactly how a rule becomes a sentence in a README. A bundle that ships no source map is a `no-map` answer for the standalone path forever, and the stamp resolves it. The plugin does produce answers the standalone path cannot, in individual cases, and that is the entire reason it exists. What it may not do is produce a *kind* of answer the standalone path cannot, and that is the clause that can be held:

  1. **Same shape, same statuses, no field only the plugin can fill.** A stamped attribution is a `ComponentSource` with `status: 'resolved'`, a `source` and a `line` — every one of which a bundle search already produces. The moment it carries something extra, the standalone path is *missing* something rather than merely approximating it. (The stamp carries no `column`, which is one field fewer, not one more.)
  2. **No feature may require it.** Everything works with the plugin absent, and the whole existing suite — which runs without it — is the standing proof. `tests/react-stamp.test.ts` says so on purpose as well: a captured component with no stamp still resolves by the existing path, asserted deliberately so that a later refactor cannot make the stamp load-bearing without going red.
  3. **Every attribution says which path answered it, in every surface that reads one.** `ComponentSource.via` gained `'plugin'` beside `'debug-source'` and `'bundle-search'`; the panel's result card spells it `build stamp`, and so does every surface a *model* reads a component through. `sourceProvenance` in `src/core/react/attribution.ts` prints the plugin's path and stays silent about the other two on purpose, and says why: DevFlow's own two paths leave a reader no decision to make between them, while a stamp means the answer came out of a build step in somebody's *application*.

     **This clause was shipped false and is now true, and the gap is worth recording because it was named in the handoff and still missed.** The first pass rendered `via` in `get_step_detail` and stopped, on the reasoning that `get_step_detail` is where a model reads a component in full. It is not the only place: `get_flow` is the primary tool, it returns the `## React components` table from `src/core/export/markdown.ts` — whose own comment calls it *"the one place a component's source is written down"* — and that table is also what `flow.md` holds on disk and what the extension's own Markdown and ZIP exports write. A model calling `get_flow` read `| Cart | src/Cart.tsx:12 | |` and could not tell. The table's Notes cell now carries the provenance, and so does the heading `get_source_snippet` prints above the lines it read, which is the one tool that turns an attribution into the *contents* of a file. **The write and the renderer are one deliverable**: a field no tool prints does not exist from outside, and a rule that holds in one renderer out of three is a rule about that renderer.
  4. **The standalone path stays the tested default.** The plugin has its own suite (`tests/compiler-plugin.test.ts`) and the reader has its own (`tests/react-stamp.test.ts`). Neither became the fixture of an existing test: `tests/react-table.test.ts` gained precedence cases beside its `debug-source` cases rather than in place of them.
  5. **The documentation may not present it as the fix for poor attribution.** `compiler-plugin/README.md` names the three builds the standalone path cannot answer for — no source map, a map the browser will not fetch, a genuinely ambiguous match — and says outright that the common failure, a lazy chunk that never loaded, carries no stamp either.

  **Precedence: stamp, then `debugSource`, then needle**, in `src/core/react/table.ts` for the recorder and `src/ui/locator/locate.ts` for the picker, because picking and recording disagreeing about one component is worse than either being wrong. The stamp goes first on the merits and not because it is new: `debugSource` is where the JSX was *written*, a position in the parent's file, while a stamp is where the component was *defined*, which is what `ComponentSource` has always claimed to be. **The stamp is the better match for the contract and `debug-source` is the compromise.** The `isPlaceholderId` guard is kept for the stamp too — the hazard it names, one row winning under an id every unnamed component shares, is unchanged by where the location came from.

  Three further readers were wired for the same reason and are easy to miss, because each fails by *quietly* reading one field fewer: `classifyPicked` (a stamped `node_modules` component would otherwise classify as the user's own code and stay in the tree with the dependencies chip on), `rowBadge` (which marks a row whose answer needs no bundle search, and now says which of the two recorded it), and `observationFor` in `src/features/arkg/ingest.ts` (an observation with a name and no file is a valid observation, so dropping the file fails nothing downstream and simply leaves the graph never learning where a component lives).

  **A wrapper is stamped only when the component is written inside it**, and that rule came out of the adversarial review rather than out of the design. `forwardRef((props, ref) => …)` binds no inner name, so the wrapper is the only place a stamp can go and it truthfully says where that component was written. `memo(SomeLibraryIcon)` is the opposite: the wrapper's stamp would name the *consumer's* file while `getDisplayName` reads the library's name off the fiber, so DevFlow would report a library component as living in `src/Icons.ts` — resolved, `via: 'plugin'`, ahead of `_debugSource` and instead of a bundle search. A confidently wrong file, which `table.ts` already calls the one outcome worse than no file, and it would have refuted the argument for putting the stamp first: it is a position in the parent's file after all. So an identifier argument is left unstamped and the answer falls through to the paths that can be right about it.

  **What is stamped and what is refused** is in `compiler-plugin/README.md`. The refusals that matter here: a JSX attribute is refused outright, because it reaches the DOM and changes the user's app, which Invariant 1 forbids; class components, components below module scope and anonymous default exports are gaps, named as gaps; and **SWC is not covered at all** — `@vitejs/plugin-react-swc` and Next.js take no Babel plugin, so this serves a real but partial audience and the README says so rather than implying coverage.

  **It is `private: true` and is not published.** It has never been run against a real application's build — only against fixtures in this repo's own suite — and an npm package is a thing people install and cannot un-install. `scripts/sync-version.mjs` keeps its version with the other two and `tests/versions.test.ts` asserts that, so publishing it later is one field, not a rediscovery.

### Work Stream 1.2: Deep React Fiber & State Store Inspection (Non-Invasive)
> The `v3.2.0` attempt fabricated `window.__REDUX_DEVTOOLS_EXTENSION__` as a
> non-callable object when the real extension was absent, which crashes the
> classic `__REDUX_DEVTOOLS_EXTENSION__ && __REDUX_DEVTOOLS_EXTENSION__()` store
> enhancer at boot — a violation of Invariant 1 on every page, recording or not.
>
> **What replaced it samples rather than intercepts.** The stores are read off
> the fibers React already keeps, twice per step, and nothing is defined,
> patched, wrapped or subscribed to on the page at any point. "Inert when not
> recording" is therefore not a property the code maintains but one it cannot
> violate: there is no global to restore and no restore path to get wrong.
> `tests/state-reader.test.ts` asserts it directly — the devtools global stays
> absent, `window` gains no property, and a store is never `subscribe`d.
>
> The cost of sampling is stated where the data is read rather than left to be
> found: a store that changed and changed back between the two samples shows no
> change, and nothing says anything about ordering *within* a step.
- [x] **React DevTools Global Hook Reader** — `getFiberRoots` is read when the extension is installed, and the container-key scan stands whether or not it answered. Read only; installing a renderer to make the hook appear is the mistake one object over.
- [~] **Non-Invasive State Store Interceptor:** Redux, TanStack Query and React Context are read in full; Zustand is read **only when the store is provided through a context**.
  - [—] The module-level `create()` store is **refused on measured evidence, not deferred.** Reading fibers yields each consumer's *selection*, never the store object; a union of selections would fabricate a state change the moment a component unmounted, and would produce a label that does not survive a reload. `stateNote` says the gap exists, and `tests/state-reader.test.ts` carries the measured hook shape as a fixture, so reversing this is a deliberate act with a test to update rather than a drift. **ADR 0005** holds the measurement — React 19.2.8, Zustand 4.5.7 and 5.0.15, three consumers of one store — and states what would overturn it.
- [x] **Subscription Discovery** — from `fiber.dependencies.firstContext`, React's own record of what a component consumed. Being rendered underneath a provider is not reading it, is true of nearly every component in an app, and is never counted.
- [x] **RFC 6902 state deltas and `get_state_patch`,** moved here from Work Stream 1.5. The differ is pure and tested (`src/core/state/`); the budget question the deferral named is answered by **collapsing, never trimming** — an over-budget patch is re-cut at a shallower path so it stays applicable exactly, because a patch with operations removed no longer reconstructs the state and says nothing about it. The tool distinguishes "capture was off", "no store was recognised" and "no store moved", because those are three answers and only the last is about the application.

### Work Stream 1.3: Causal Threading in the Flow Recorder
- [x] **Causal DAG Construction** — `src/core/causal/index.ts`, pure and tested. **Derived from the recording, not stored**, and deliberately: every fact it uses is already in the flow, so a stored copy would be a second thing to keep in sync and would not exist on the recordings already on people's disks. Derived, every flow ever made gets the analysis and a rule improved later reaches all of them. That is why there is still no `causedBy` field in `src/shared/types.ts` and why its absence is not the gap it looks like — Work Stream 2.1's "all events carry `causedBy`" is a decision to *stamp* the derivation at capture time, which is a different item and stays open.
- [x] **Causal Query MCP Tools:** `get_causal_chain`, `get_effects_of` — the same graph walked in both directions, each link carrying the evidence it rests on. Four bases, **named rather than scored**: `echoed` (a value the response carried appears in what the store was written with), `named` (the log line contains the request's path), `attributed` (containment only — the recorder filed both under one step, and a poll on a timer lands there too), `followed` (ordering after a failed call, and nothing else). A number implies a precision this evidence does not have and cannot be argued with; a sentence naming what was seen can.

### Work Stream 1.4: The "Why Did This Render?" Engine
> Reverted in full, and rebuilt on the sampling design `1.2` established rather
> than on the interception design that was reverted. The `v3.2.0` attempt walked the entire fiber tree recursively
> on every commit, on every page, gated on nothing, and `postMessage`d per changed
> component — against the <2% CPU NFR — while computing only two reference-equality
> booleans and no actual blame. Nothing consumed the output.
- [x] **Render Blame Evaluator:** prop keys with before/after, hook index (1-based) + diff, context changes, and the parent-render case named as what it is. **Sampled, not counted, and the type says so where nobody can miss it.** The recorder rides the two readings `1.2` already takes — one inside the click, one once the app settled — and reports every component whose `memoizedProps` object was replaced between them. That means it knows *which* components re-rendered and can never know how many times: counting needs a commit hook, a commit hook means writing to the page, and that is what `injected/state.ts` refuses. Nothing is installed — no hook, no patched devtools global, no subscription, no window property. The walk is breadth-first, bounded by `recording.renderNodeCap` per sample, and when it is cut the recording says so, because "nothing re-rendered" and "nothing was looked at" are otherwise the same sentence. React's double buffer is the trap here and it is handled explicitly: a fiber's object identity is not stable across commits, so tracking is keyed on the fiber *pair*, with an isolating test for each half of that mechanism.
- [x] **Render Performance Autopilot (Initial)** — shipped **narrowed to wasted-render detection**, which is what this evidence can carry. A component that re-rendered while every prop, own hook value and context it depended on is unchanged is marked `wasted`. The mark is refused on any observation cut at a snapshot cap: "nothing changed" under a value nobody compared is a claim about the cap, and reporting a component as re-rendering needlessly when its own state moved sends a reader to delete a `memo()` that was working. What is *not* here, and is not a partial delivery but a different feature: render counts, render timings, and any ranking by how often something rendered. Each needs the commit hook the first bullet refuses. The per-step budget keeps wasted renders first rather than the busiest components, because ordering by change count drops every wasted render first — silently, and worst on the steps somebody opened because something was slow.
  - Read through `get_step_detail`'s `render` part, which distinguishes four answers: never sampled, switched off, walk capped, nothing re-rendered. The flow-level `FlowRenders` that makes those four distinguishable travels from `readCurrentRenders` through `buildPayload` and `saveFlow`, each of which copies flow-level fields **by name** — the copy that silently dropped `state` last session — and each hop is covered by a test that starts in storage or at the POST rather than at a fixture.
  - `renders` is dropped along with the React ref whenever the component table is not shipped. Every entry is keyed by a component id, and a list naming components the payload cannot resolve is not a smaller answer but an unreadable claim.

### Work Stream 1.5: High-Density Token-Efficient MCP Interface
- [x] **Shipped and covered:** `list_flows`, `get_flow`, `get_flow_errors`, `get_flow_step`, `get_latest_flow`, `get_flow_screenshots`, `compare_flows`
- [x] **Out-of-band Screenshots:** written to `~/.devflow/flows/<id>/` and referenced by absolute path.
- [x] `get_flow_summary` — one flow in under 400 estimated tokens, budget enforced by dropping whole facts rather than cutting text, and tested against a deliberately hostile recording.
- [x] `get_step_detail` — one named part of one step (component, network, console, element, dom, screenshot), with an index that prices each part before it is asked for.
- [x] `get_source_snippet` — the lines a component was written on, read only from underneath one project root, re-checked after symlinks, and off in remote mode unless `DEVFLOW_PROJECT_ROOT` says otherwise.
- [x] `get_state_patch` (RFC 6902) — **shipped in Work Stream 1.2**, where it was deferred to. The reasoning that deferred it is kept below because it is the reasoning that made it shippable: the budget question really did need the captured shape, and the answer — collapse, never trim — could not have been written against a shape that did not exist.

  > **Deferred to Work Stream 1.2, deliberately.** `Step` has no state field and nothing captures one, so the tool would have nothing to read and the differ behind it would be a module in `src/core/` with no caller. That is the exact shape of what the `v3.2.0` audit deleted, and shipping it to tick a box is the habit that made the previous attempt worthless. RFC 6902 generation is well specified and does not depend on the state shape; what does depend on it is the part that matters here — which subtrees are worth diffing and how a patch is bounded to a token budget — and that cannot be designed against a shape that does not exist. Build it in 1.2, with the captured state in hand.

---

## Phase 2: Autonomous Bug Reproduction, Remediation & Natural Language Intelligence
**Objective:** Closed-loop automated debugging from issue description to verified PR, plus natural language application understanding powered by the ARKG.

> Every item below was ticked in `v3.2.0` and none of it survived audit. The
> provenance engine was unreachable dead code; the synthetic action generator
> returned hardcoded buttons and ignored its ARKG argument; the navigator was a
> stopword-matching substring filter; the patch generator was a hardcoded fake
> diff in a file that did not parse. Re-planned honestly below.

### Work Stream 2.1: Deterministic Time-Travel Flow Recorder 2.0
- [~] **Unified Event Chronicle:**
  - [x] Timestamped user events (click, input, navigate), network with request/response payloads, console output and uncaught exceptions — all attributed to the step that caused them.
  - [~] DOM MutationObserver deltas **shipped**; periodic layout snapshots **refused — ADR 0006.**
    - **The deltas.** A `MutationObserver` watches the whole document for the length of each step and the step carries a folded summary of what appeared, went, or was rewritten. It is a **different observation from `StepBase.domDelta`**, not a bigger one, and the two are deliberately kept apart: `domDelta` reads the *text* of *one region* — the container around the element that was touched — before and after; `domChanges` reads the *structure* of the *whole document* over the same window. A click that opens an error banner in the page header produces nothing in the first and one entry in the second; a button whose label became "Saving…" produces the reverse. Neither is derivable from the other, so neither replaced the other.
    - **The budget, which was designed before the implementation.** *Observed:* every `childList`, `attributes` and `characterData` mutation under `documentElement`, for a window that opens when the step is **written** and closes `recording.domDeltaMs` later or when the next element step is written, whichever is sooner. For a click those two moments are the same; for typing they are not, because the recorder commits a whole field as one step after `recording.inputDebounceMs` of quiet — so a typed step's window starts once the typing stopped and catches what the finished field caused rather than what each keystroke did. `domDelta` has read its region on that same schedule since it shipped, and this shares it rather than defining a second "settled". The one-window rule is unconditional; "closed by the next interaction" is not — a navigation and a synthesised note are not element steps and do not close an open window. A mutation still belongs to exactly one step; that step is the last element step before it. *Dropped before it costs anything:* DevFlow's own DOM, refused by the `devflow-` id prefix, because the recording indicator is removed and re-added around every screenshot and would otherwise open every step of every flow with a div appearing and going in `<body>`; `<style>`, `<script>`, `<link>`, `<meta>` and `<template>` — refused on the *target* of a record as well as on nodes that come and go, because a `<style>` appended once and then written through is what Vite's HMR and styled-components in development do, and it arrives as `characterData` on a node the added/removed filter never sees; whitespace-only text; and comment nodes. *Two caps, because there are two costs:* `recording.domMutationCap` (400) bounds the **work** and is enforced in the observer's own callback before each record, which then **disconnects** — so a page running a transition at sixty frames a second costs a step the cap and not a second of records; `recording.domMaxChanges` (12) bounds the **recording** and is enforced after folding, where a hundred appended rows are one entry with a count of a hundred. A single number could not do both: low enough to keep a step readable it would stop watching after a dozen records, high enough to watch a real interaction it would print four hundred lines. *What the recording says when a cap bites:* the work cap sets `StepDomChanges.capped`, which `get_step_detail` prints last so it qualifies the list above it and says in as many words that it is not a claim that nothing else changed; the recording cap sets `more`, a different fact — those were seen and did not fit. *What survives the recording cap:* structural change, then text, then attributes, and `style` last of all, first-seen order inside each rank. **The cut happens before the describing, not after it** — a group is ranked on what it already knows, and only the survivors are handed to `generateSelector`. Describing all four hundred groups and then keeping twelve built four hundred `querySelectorAll` passes and threw away three hundred and eighty-eight of them, synchronously inside the user's next click; that is the cost profile the reverted attempt was reverted for, relocated one function along, and an adversarial review of this work stream found it. Never by count: the dialog that mounted is one record and the CSS transition behind it is sixty, so any ordering by how often something changed spends the whole budget on the transition — the same trap `core/render/blame.ts` documents for wasted renders, one tree over.
    - Read through `get_step_detail`'s `dom` part, which now carries both observations and prices them as one. `core/dom/observe.ts` folds and describes, `core/dom/changes.ts` spends the budget, and `content/index.ts` owns only the lifecycle — the split `injected/render.ts` and `core/render/blame.ts` already make. `tests/dom-changes.test.ts` drives the collector with a **real** `MutationObserver` over a real jsdom document rather than hand-written record objects, because a hand-written record is a fixture of what the author believes `MutationRecord` is.
    - [—] **Periodic layout snapshots are refused, and this is not a partial delivery of the deltas.** A timer that reads layout forces a synchronous reflow on every tick of every recorded page whether or not anything moved — the cost profile the `v3.2.0` render attempt was reverted for, moved from the fiber tree to the layout tree. A snapshot taken *between* steps belongs to no step, and giving it one means a flow-level timeline of layouts, which is a time-travel player and a different feature. Taken *at* a step it is already answered twice: the screenshot is the layout, and `ElementRef.boundingBox` is where the interaction landed. **ADR 0006** names the two mechanisms building it would need, neither started.
  - [—] All events carry `causedBy` references — **not built, and this line is the decision rather than a gap.** §1.3 built the graph and derives it at read time from facts the flow already carries, so a stamp would be a second copy to keep in sync, absent from every recording already on somebody's disk, and would freeze today's rules into flows that a sharpened rule should reach next month. **ADR 0007**, which also records the one thing that would justify a stamp — something needing the chain *before* the flow reaches a reader. Nothing does.
- [~] **Export to Resilient E2E Tests (Interaction-to-Test Compiler):**
  - [x] 1-click export of a recorded flow to Playwright and Cypress from the flow review screen.
  - [x] Resilient selector hierarchy: aria-label → role+name → text → CSS selector (flagged as fragile).
  - [x] Network mock fixtures injected from real intercepted request/response payloads.
  - [~] State assertions from before/after store diffs. **The observation ships; the assertion is refused.** An exported spec carries what the app's stores did beside the step that did it — the store, the operations in the differ's own path order, and both flags that change what a patch means (`bounded`, so a path that is absent may have changed below the snapshot cut, and `collapsed`, so the operations are coarser than the ones the app made). Written as comments, capped at six per store with the count of what was not printed, once explained per file.
    - [—] **No assertion is generated.** DevFlow reads a store by walking React's fiber tree from inside the page, and a test runner has no handle on that. Generating one means pasting a few hundred lines of React internals into a file the developer owns, frozen at the React version of the day it was exported, whose failure mode is a red suite reporting a bug in the application that is not there — worse than no assertion, because the response to a red test is to go and look at the app. The developer's own store *is* reachable to them by whatever handle they choose to expose, and choosing it is an app change, which is Invariant 1's whole point. **ADR 0008**, which also carries the open question this narrows: which of a patch's operations are worth asserting on is still unanswered from a fixture, so nothing ranks them.

### Work Stream 2.2: "Why Is This Value Here?" Provenance Engine
> The `v3.2.0` attempt was **unreachable dead code** — a module nothing called,
> behind a tool that was never declared. So the tool was wired first here, and
> `tests/mcp-provenance.test.ts` asserts it against `tools/list` as well as by
> calling it: a switch case answers a call whether or not anything ever
> advertised the name, so a test that only calls it is green against precisely
> the bug this was rebuilt to avoid. (That test was written the weak way first
> and the mutation check caught it — which is the argument for the mutation
> check.)
- [x] **Full Value Provenance Trace:** response body → store write → component prop/state/context → the text on screen. `src/core/provenance/index.ts`, pure and derived at call time from what a flow already carries, so every recording on disk gets it.
  - **What it is, stated where nobody can miss it.** This is a **search, not a trace.** DevFlow did not watch the value move; it holds four independent observations of one recording and looks for the same value in all four. A distinctive value found in three layers is overwhelmingly one value travelling; `2` found in three layers is a coincidence three times over. The tool description says so, the reply opens by saying so rather than closing with a caveat, and a value under four characters is called out as colliding **above** the findings — a reader who has already read a four-layer answer has drawn the conclusion, and a caveat underneath arrives too late to stop them.
  - **Layer order is presentation, never causation.** Response → store → render → DOM is the direction data flows through a React app, so the answer reads as a journey. That is exactly why the reply says two sightings in adjacent layers are two sightings and not a link. `get_causal_chain` is the tool that makes causal claims, and it makes them out of evidence about *events* rather than the equality of two strings.
  - **A layer the recording never captured is named, not left absent.** "The value is not in a response" and "this flow has no responses" look identical as a missing section, and a reader who cannot tell them apart takes the first — which is a claim about the server made out of a setting. `unsearched` carries the reason, in the words `FlowState` and `FlowRenders` already use.
  - Response hits carry an RFC 6901 pointer into the parsed body (`~0`/`~1` escaped, which is the bug nobody notices — an unescaped pointer still *looks* like a pointer and addresses nothing); store hits carry the operation's path plus the pointer inside its value; render hits name the component by the name it was written under rather than by its id; DOM hits carry a selector. Primitives are compared as text, so a number typed into the tool finds a number the server sent. Eight hits per layer, with the overflow counted.
- [x] **MCP Tool:** `get_value_provenance({ id, value, step })` — **and the departure from `domNodeId` is deliberate.** A recording has no node ids: an element is *described* (tag, text, label, selector), never addressed, so there is nothing for a `domNodeId` to name. `value` is the handle that exists, and `step` traces what that step's element showed, which is the same question asked the way the roadmap meant it. With neither, the tool lists the steps whose text is worth asking about — `get_causal_chain`'s discipline, that a tool whose first answer is "that is not valid" has made the caller guess.

### Work Stream 2.3: Autonomous Sandbox Execution Engine
> The `v3.2.0` generator returned hardcoded buttons and ignored the ARKG
> argument it was given. The rule that came out of that is structural rather
> than aspirational: **if the generator cannot use the graph, it takes no graph
> argument** — and it does not, because the ARKG holds components, endpoints,
> files, flows and state keys and holds no selectors and no element text, so it
> cannot contribute an action. Recorded flows can, and do.
- [x] **Headless Replay Harness** — `replay_flow`, built once 2.4 existed to need it, which is the sequence the earlier deferral asked for.
  - **It runs the spec the export already writes**, not a smaller one of its own: a replay that passes has to be evidence about the artifact the user was handed, and the server carried a second markdown renderer once and the two disagreed about which was right. Compiled with `generatePlaywrightTest`, written to `.devflow/replays/` **inside the project** — Playwright resolves itself by walking up from the spec file, so a spec in a temp directory cannot import the runner about to run it — and run with the project's own `node_modules/.bin/playwright`.
  - **Off unless somebody switched it on.** Every other tool here reads; this executes code on the machine it runs on. `DEVFLOW_REPLAY=1` on the server's own environment turns it on — the environment and not `POST /config`, which any page the browser visits can reach. Off, the tool still appears in `tools/list` and answers by saying exactly what it would do and how to allow it: a capability invisible until enabled is one nobody finds, and one that runs without being enabled is one nobody agreed to. `tests/mcp-repair-loop.test.ts` asserts both sides of that gate against two real servers, and that the refusal writes nothing into the project.
  - **It will not install a runner.** `npx playwright` on a machine without it downloads and installs it; a tool call is not where that decision belongs, so a project with no `@playwright/test` is refused with a sentence saying why.
  - **The reading is the dangerous half and it is pure.** `core/replay`'s `readRun` distinguishes four outcomes — passed, failed, no test ran, and *nothing readable came back* — because a runner that crashed before loading a spec exits non-zero and prints a stack trace, a runner that matched no files prints a valid report of nothing, and **a repair loop that counts failures rather than runs reads both as a pass and concludes its patch worked.** A killed run is unreadable whatever it printed, since a runner stopped mid-suite may have already reported the tests that passed. stdout is read first and stderr only as a fallback, so a crash reaches the reader without a stderr deprecation warning turning a passing replay into an unreadable one. That decision lives in the pure module rather than in the server precisely because it could not be reached by a test where it first sat — a mutation deleting it left every suite green.
- [x] **Synthetic Action Generator** — shipped, and **narrower than the word "synthetic"**, which the module and the tool both say on every answer.
  - `src/core/actions/index.ts` folds the interactions people have actually performed, across every recording of a page, into one candidate each: the kind, the selector `core/export/selectors.ts` chose, the label, the value that was actually typed, how many recorded steps it stands for and which flows they came from. Nothing is invented. DevFlow has no model of the application, so it offers what has been done rather than what might work, and a control nobody has ever touched is not in the answer.
  - That is the strength rather than the apology, and it is worth writing down because the reverted version's failure looked like the feature working *better*: a selector DevFlow watched resolve is worth more than one guessed from a component's name, and the value somebody actually typed is worth more than `test@example.com`. A generator that invents needs a model of the app, and inventing without one is what `click("Submit")`-because-most-apps-have-one is.
  - Skips are counted with a reason rather than dropped, because "this page has no recorded actions" and "you filtered them all out" read identically as an empty list. So does "the tool only opened the twenty-five most recent recordings", which the reply also says.
- [x] **MCP Tool:** `suggest_actions({ url, component, limit })` — declared as well as answerable, asserted against `tools/list` for the reason Work Stream 2.2's tool is.

### Work Stream 2.4: Closed-Loop AI Code Repair Loop
> Built last, and built the way the earlier deferral asked for: 2.3's replay
> harness was written *here*, alongside the loop that needs it, so its gate and
> its failure handling were designed against a caller rather than guessed at.
>
> The `v3.2.0` version was a hardcoded fake diff in a file that did not parse.
> **Two of the three bullets ship and the middle one is refused**, because the
> patch is the model's to write and pretending otherwise is what a template
> dressed as a generator is. What DevFlow owns is the two ends: what broke, and
> whether it is fixed.
- [x] **Diagnostic Causal Tracing** — `diagnose_failure`, and it **names no cause**.
  - That refusal is the design. `get_causal_chain` says what evidence links two events; a diagnosis is the temptation to go one step further and say which link is *the fault*, and nothing in a recording supports it — `attributed` is temporal containment and `followed` is ordering. So this assembles per failure: what broke, the component the step was attributed to and the file it was written in, and the causal evidence with the basis each link rests on carried through unchanged. One event reached by two paths is printed once, because two lines reads as two pieces of evidence.
  - **What it adds that no single recording can** is the last line of each entry: whether the thing that failed has failed before. "This endpoint failed twice in a hundred and forty observations" and "this endpoint fails six times in ten" send a reader to two different places, and only the accumulated graph can tell them apart. `standing` is named rather than scored — `new`, `chronic`, `unknown` — and **`unknown` is the honest default**: below ten observations the graph knows nothing, and a rate between the two bands is a rate that settles nothing. *"We have never seen this fail"* and *"we have not seen it enough to say"* are different answers, and a reader handed the second as the first goes looking for a regression that may not exist. `tests/diagnose.test.ts` holds two fixtures identical but for their observation count and asserts the two sentences differ.
- [—] **Patch Generation & In-Memory Application** — **refused, and the reasoning is architectural rather than about effort.** DevFlow is not a model and cannot write a patch; the caller is, reading `diagnose_failure`, `get_source_snippet`, `get_value_provenance` and `get_causal_chain`, all of which ship. A generator inside this server could only be a template, and `v3.2.0`'s was exactly that — a hardcoded fake diff in a file that did not parse. "In-memory application" has no honest form either: the app under test is served by the user's own dev server, and a version that wrote to the working tree while calling itself in-memory would be editing somebody's repository from a tool call and saying it had not. DevFlow's half of the loop is diagnosis and verification, and both ship. **ADR 0009.**
- [x] **Replay Verification & Test Runner** — the comparison `replay_flow` makes when the recording itself carried failures: it names the steps that failed when it was recorded, and says whether this run reproduced them. **The claim is deliberately weak**, and the reply says so: the replay answers with the responses the recording captured, so a fault living in the server is mocked out of the run by construction, and what a pass proves is that the journey through the interface completes.

### Work Stream 2.5: Natural Language Application Navigator
> The `v3.2.0` attempt was stopword-matching substring filtering presented as
> understanding. What replaced it **is still lexical matching** — names, URLs and
> repo paths are what the graph holds — and the whole of the difference is that
> it says so, in the tool description and at the top of every answer, and that
> the lexical hit is only the entry point.
- [x] **Feature Understanding Query** — `src/core/navigator/index.ts`, pure and tested, plus `getNamedEntities` and `getNeighbours` in `mcp-server/arkg.js`.
  - **What it does.** Lower-cases the description, cuts it into terms, drops an explicit stop list (and reports every dropped term), splits each entity's name the way code names are written — camelCase and PascalCase boundaries plus `-`, `_`, `/`, `.` — and matches on that. The split is the one thing that makes it better than a substring scan: `cart` matches `CartBadge` as a **word** and `invoices` matches `/api/v1/invoices` as a **word**, while `art` matches `CartBadge` only as a fragment and is ranked as one. Each match carries a **named basis** rather than a score — `name-exact`, `name-word`, `name-part`, `text-word`, `text-part` — for `core/causal`'s reason: `0.72` cannot be argued with and *your word is inside its name but is not a word of it* can.
  - **What makes it more than a grep, and it is not the matching.** Every match is expanded one hop through the graph's own edges, so a search for "cart" reaches `GET /api/v1/invoices` — which carries no cart word anywhere — because a recording observed `CartBadge` calling it. The lexical hit is the entry point; the accumulated graph is why the entry point is worth having. `tests/mcp-navigator.test.ts` asserts exactly that hop, against an endpoint deliberately named so that no string match could reach it.
  - **The three things it refuses to imply.** That it understands the description — the answer opens by saying it matched names and does not know what the words mean. That a name carrying the word is relevant — `Cart` matches "cart" whether it is a shopping cart or a `CartesianGrid`. And, most importantly, that an empty answer is an absent feature: a checkout written as `PurchaseFlow` and `/api/orders` answers to neither "checkout" nor "flow", so the reply says in as many words that silence is a statement about vocabulary and not about the application. A graph larger than the per-kind corpus cap says so too, rather than reporting "nothing matched" about a node it never looked at.
- [x] **MCP Tool:** `explain_feature({ description, limit })` — declared as well as answerable, which `tests/mcp-navigator.test.ts` asserts against `tools/list` for the reason 2.2's does.

---

## Phase 3: Full-Stack Wire & Database Lineage
**Objective:** Connect frontend user interactions to backend endpoints, microservices, and database queries. Introduce the Living Architecture Map and Temporal Diff.

> **Where this phase stands: 3.1 (through Tier 2), 3.2, 3.3 and 3.4 are shipped;
> 3.5 is deferred to Phase 5 §5.4 as three work streams, with the argument in
> §3.5 below and in ADR 0017. Phase 3 is closed as scoped, and Phase 4 depends on
> none of what was deferred.**
>
> **Every remaining unticked box in Phases 0–3 is a refusal or a deferral with
> the argument written down.** The last one that was a genuine gap — the animated
> render graph in §3.3 — shipped as the cascade in Flow review.
>
> 3.4 went first because it needed only the commit stamp and `compare_flows`,
> both one step away, and because it closed the three Phase 0 items — `git_sha`,
> `git_commits` and `changed_in` — on the way rather than as an errand
> afterwards. 3.1 went second because its header injection is **the first change
> DevFlow makes to what a recorded app sends its own backend**, and a decision
> that can break somebody's application is one to take deliberately rather than
> under the time pressure of a phase that is nearly over. The rule it was built
> to is below, and it was written before the first line of injector code. What
> is *not* built is Tier 2: ingesting OTel spans is an endpoint, a wire format
> this repo has never parsed and a set of graph edges, and it is worth costing on
> its own rather than being finished in the tail of the work stream that
> unblocked it.
>
> **3.5 is out of scope as a unit and should be planned as three.** Vue 3,
> Svelte 5 and React Server Components do not share React's fiber tree and
> nothing in `src/core/react/` transfers, so each adapter is a Phase-1-sized body
> of work. Starting one and leaving two would be worse than starting none. That
> reading held: 3.5 is now deferred to Phase 5 §5.4 in those three pieces.
>
> 3.3 went last because it was the one whose *mechanism* was unsettled rather
> than merely unbuilt, and the unsettling turned out to be a word. It was carried
> as needing a live channel from the server back to an open tab — which is true
> only if the tool must pull, and it does not: the extension already pushes, and
> what the roadmap called a feed is a reading with an age on it. §3.3 has the
> argument.

### Work Stream 3.1: Distributed Trace Correlation

> **The rule was written before the first line of injector code, the way §1.1's
> was, and it lives in `src/core/trace/index.ts` where three inputs and an
> answer can reach it.** What follows is the argument; the module header is the
> same argument in the place a maintainer will actually be standing.
>
> **The hazard, exactly.** A *simple request* — one the browser sends with no
> preflight — may carry only CORS-safelisted headers. Adding any other header
> makes a **cross-origin** request non-simple, so the browser sends an `OPTIONS`
> preflight where it previously sent none; if the backend does not name the
> header in `Access-Control-Allow-Headers`, the browser **fails the request**
> and the page's own `fetch` rejects. That is not a degraded recording. That is
> a working application broken by DevFlow being installed — Invariant 1, and the
> class of failure that got `v3.2.0` reverted in a different subsystem. There is
> no falling back from it either: by the time the browser reports the failure,
> the request the page was waiting on has already rejected.
>
> **That hazard is now measured, not reasoned from the specification.** It had
> been checked from the spec and from the server side with `curl`, and neither of
> those watches a browser decide, so it was run against real Chromium (Playwright
> 1.62.1, Chromium build 1234) — two origins, reproducible in ten minutes. A page
> on `http://localhost:4311` fetches an API on `http://localhost:4312` that
> answers the preflight and allows the origin and the method on **both** paths;
> the only difference is that `/allowed` names the header in
> `Access-Control-Allow-Headers` and `/notallowed` does not. With no custom
> header the request goes straight out and resolves — no `OPTIONS` at all.
> Against `/allowed` the browser preflights, then sends the real request, and the
> API receives the header. Against `/notallowed` the page gets `TypeError: Failed
> to fetch` and the real request is **never sent**: *"Request header field
> x-devflow-trace-id is not allowed by Access-Control-Allow-Headers in preflight
> response"*. The same-origin control is the other half of the asymmetry below —
> a page fetching its own origin with both headers, against a server sending no
> `Access-Control-*` headers and answering no `OPTIONS`, resolves with both
> headers arriving and no preflight at all.
>
> **Two findings from that run sharpen the rules rather than confirm them.**
> First, a failed preflight leaves **no server-side evidence**: the API logged
> the `OPTIONS` and never a `GET`, so a developer whose app breaks this way sees
> a failed fetch in the browser and nothing whatsoever in their backend logs.
> That is a second reason the rule is not "try it and fall back", independent of
> the rejection having already happened. Second, **DevFlow cannot observe the
> preflight**: page-level instrumentation saw an outbound `GET` and then
> `net::ERR_FAILED`, because Chromium makes the preflight in the network service
> and never surfaces it as a page request, and DevFlow patches `fetch` and
> `XMLHttpRequest` in the page. Any future "did our header break this?"
> diagnostic has the rejection to work from and nothing else.
>
> **Same-origin requests are not subject to CORS at all**, and that asymmetry is
> the whole design. Four rules:
>
> 1. **Off by default.** Somebody who upgrades without reading release notes
>    must not have their traffic changed.
> 2. **Only while recording.** The patches are installed at `document_start` on
>    every page, but a header is added only inside a flow — which is the only
>    window the correlation is for. Ordinary browsing is never modified, and
>    that is worth more than it costs: it turns "DevFlow is installed" into
>    "DevFlow is recording", which is a state the user chose seconds ago.
> 3. **Same-origin freely; cross-origin only for an origin the user named.** An
>    SPA on `:3000` calling an API on `:8000` is the ordinary case and is *not*
>    covered by rule 3's first half — a different port is a different origin —
>    so an allow-list exists, and putting an origin on it is the user saying
>    "my backend accepts this". Informed consent per backend is the only honest
>    form this can take: DevFlow cannot discover whether a server allows a
>    header without sending the request that might fail.
> 4. **Never overwrite a `traceparent` the page already set.** A page that sends
>    one has its own tracing, and replacing it would reparent somebody's
>    production spans under an id their backend has never seen.
>
> **`traceparent` and `X-DevFlow-Trace-Id` are two switches, not one**, because
> they differ in both directions. `traceparent` is a W3C standard a backend may
> already accept and already allow — more likely to work, and more likely to
> matter when it is already in use. "More likely to work" is a claim about what
> backends typically allow and not about the mechanism: measured, an unlisted
> `traceparent` preflight-fails exactly as the bespoke header does, with the same
> message. `X-DevFlow-Trace-Id` is bespoke: no backend
> accepts it by accident, which makes it strictly likelier to fail a preflight
> and strictly easier to grep for in a log, which is the whole of its Tier 1
> value.
>
> **The sampled flag is a decision about somebody else's bill.** `traceparent`'s
> flags byte is `01` — sampled — because an unsampled trace header has no
> purpose: a backend running OpenTelemetry honours the incoming flag, so `00`
> would ask it to record nothing and Tier 2 would have nothing to ingest. Said
> out loud rather than left in a constant, because turning this on makes the
> user's backend record traces it would otherwise have sampled away. That is a
> second reason for the default being off, unrelated to CORS.
>
> **One id per request**, not per flow and not per step. A W3C trace identifies
> one distributed operation, so a per-flow id would tell somebody's tracing
> system that forty unrelated operations were one. The recording already ties a
> request to its step and does not need the header's help.
>
> **What the settings table allowed, and what it did not.** The allow-list wants
> to be a list of origins and `src/features/settings/fields.ts` has no
> free-form list type — `levels` is a multi-select over a *fixed* `options`
> array, and `resolve()` filters anything not in it, so a user's origins would
> be silently discarded. A sixth field type is expensive and deliberately
> guarded: `tests/settings-row-shape.test.ts` asserts the five type names and
> the shape count "so a sixth cannot arrive unnoticed". So the allow-list is a
> pattern-validated `string`, parsed by a pure function in `core/trace`, and the
> contract is not bent to fit.

- [x] **Causality Trace Header Injection:** — **shipped, and "automatically … to all outbound requests" is the one phrase that did not survive.** It is off by default, active only while a flow is recording, and it adds nothing to a cross-origin request whose origin the user has not named. Each of those three is a refusal the rule above argues for, and the third is not a caution but the design: there is no way to discover whether a backend allows a header except by sending the request that might fail, and a failed preflight has already rejected the page's own request by the time anyone hears about it.

  Three further refusals, each on its own grounds. A request the page has **already** put a `traceparent` on is left exactly as it was, because overwriting one reparents somebody's production spans under an id their backend has never seen. A `Request` carrying a **body** is left alone, because adding a header means rebuilding it and `new Request(req, { headers })` marks the original as `bodyUsed` — measured rather than assumed, and the reason the ordinary `fetch(url, { body })` *is* traced while the `new Request(url, { body })` form is not. And an id is minted **per request**, never per flow.

  Both `fetch` and `XMLHttpRequest` are covered; the latter is not a legacy corner, since `axios` still uses it in the browser. The XHR path found a pre-existing defect on its way: `open()` never cleared the recorded request headers, so the second request through a reused instance — which is how every long-poll and retry loop is written — was recorded carrying the first one's. It surfaced because a stale `traceparent` in that list made the second request refuse itself as already traced.
- [x] **OpenTelemetry (OTel) Collector Integration (Tier 2):** — **shipped, and every decision in it was measured against a real exporter rather than read off the specification.** A throwaway service was built with `@opentelemetry/sdk-trace-node`, pointed at a capturing endpoint, and made to continue a `traceparent` of exactly the shape `core/trace` mints. Four facts came out of that and three of them would have been got wrong by reasoning, which is why the captured deliveries are the test fixture rather than hand-written JSON:

  **Spans arrive leaf-first.** A span is exported when it *ends*, and a child ends before its parent — the `SELECT` at depth three arrived in the first delivery and the root server span in the third. So nothing may assume a parent has been seen, the tree is assembled from the accumulated set rather than from one delivery, and the receiver stores before it joins. **The root's parent will never arrive at all**: the backend parents its top span on the `traceparent` DevFlow sent, and DevFlow is not an OTel SDK and emits no spans, so a missing parent is the *ordinary* case. `buildSpanTree` therefore roots on "parent not present" and not on "no parent", which is a one-word difference that returns an empty forest for every good trace if it is got wrong. **Timestamps do not fit in a `number`** — `startTimeUnixNano` arrives as a JSON string two orders of magnitude past `Number.MAX_SAFE_INTEGER`, so they are subtracted as `BigInt` and only the difference crosses back.

  **OTLP/JSON only, and protobuf is a named gap rather than an oversight.** A protobuf delivery is refused with a `415` naming the one line that fixes it. A decoder would be a second wire format to get exactly right, and a subtly wrong varint does not throw — it writes a plausible number into somebody's graph, which is the shape of the two defects mutation-testing found in Work Stream 3.4. The user is already editing exporter configuration to point it here at all, so the protocol variable beside the URL is a word rather than a step.

  **A span is an event, and the graph needed something that outlives one.** This is the `caused_by` rule and it bites hardest here: a span has a random 64-bit id, happens once and is never seen again, so a node per span would stop the ARKG being an accumulation and make it a log. What is stable is the **service** (`service.name`) and the **operation** (that service plus the span's name), and a span is an observation *of* an operation exactly as a network call is an observation of an endpoint. Operation names collapse opaque path segments through the same rule `normaliseUrl` already applies to endpoints — reusing it rather than writing a second one that disagrees.

  **A trace nobody recorded projects onto one node, so it is not written.** It is not dropped on arrival either, and the measurement is why: spans normally arrive *before* the recording does, because a backend exports within seconds and the user presses Send when they are ready. Dropping unjoined spans would drop very nearly all of them. So they are held in a capped, expiring store — deliberately a separate database from `arkg.db`, because a waiting room is not graph data — and the join runs at flow ingest. Re-sending a recording is therefore how a late trace gets joined at all, the same property `changed_in` has and for the same reason.

  **Two things the backend nodes are wired into and one they are not, named rather than left to be discovered.** They age out on the ordinary retention sweep, and that was worth going back for: every other node kind is created by somebody recording, so the graph grows at the rate a person works, while a service and its operations are created by a span arriving on an endpoint nothing on this machine paces — a policy reaching every node kind *except* the two fed from off the machine would have been pointing exactly the wrong way round, and the symptom is a database that silently grows. They also count towards a graph being non-empty, because "services and no recordings" is the *ordinary* intermediate state given spans arrive first, and while it did not count, that state was indistinguishable from a fresh install. What they are **not** wired into is `explain_feature`: the lexical navigator has no `service` or `operation` entity kind, so a backend node cannot be found by name even though `get_app_architecture` lists it and `getNeighbours` will walk onto one and label it correctly. That is a gap and not a refusal — it is a widening of `EntityKind` in `core/navigator` plus a corpus arm in `getNamedEntities`, and it was left because a half-scored entity kind in a matcher whose whole risk is overstating what it knows is worse than an absence somebody can see.

  **`DEVFLOW_OTEL=1`, which is the opposite default from `DEVFLOW_GIT`.** That asymmetry is argued rather than inherited. `git` reads a repository this machine already owns with a fixed argv; this accepts a document from off the machine, written by a process DevFlow has never met, and turns it into rows in the accumulated graph. Every other write endpoint on this port is guarded by `extensionOrigin` and this one **cannot** be — the sender is the user's own backend, which has no extension origin and never will — so the gate that is actually available is the user having asked for it. The store is not a security boundary and does not claim to be: a trace id is 128 random bits, so attaching a fabricated span to a real recording means guessing one; filling the store is the reachable nuisance and the cap is the answer to it.
- [~] **Tier Model Enforcement:**
  - [x] Tier 1 (default, zero backend effort): FE-only correlation, response body, error detection, latency — **this is what ships, and it has standalone value that does not depend on Tier 2 ever arriving.** That is the test the header had to pass before it was worth changing anybody's traffic for: the id DevFlow puts on the request is the id in the backend's own logs, so a person or a model can go and grep for it. A header nobody can read back is a change to somebody's traffic in exchange for nothing, which is why the id is *rendered* — on failed calls in the walkthrough, in `get_flow_errors`, in `get_step_detail` and in the flow review — and not merely stored.
  - [x] Tier 2 (OTel SDK, one package): full FE → BE → service span correlation — **shipped**, and "one package" survives contact: the user adds an OTel SDK to their own backend if they have not got one, sets two environment variables, and starts DevFlow's server with `DEVFLOW_OTEL=1`. `get_backend_trace` is the reader, and it keeps three situations apart that have three different fixes — a call that was never traced, a traced call whose spans have not arrived, and a joined trace. The second is the one worth the extra branch: telling somebody "no backend data" when the truth is "your exporter has not sent it yet" sends them to change a setting that was already correct.
    - [x] **This is language-agnostic, and Phase 5 used to carry it as unbuilt work.** The receiver takes OTLP/JSON; nothing in `mcp-server/otel.js` is Node-specific. A Python FastAPI or Go service exporting OTLP to the same endpoint joins the graph today with no adapter, because a span is a span. It was listed under §5.4 as "Server-Side Framework Support" and moved here on discovering it already worked — what is actually missing is a paragraph in `mcp-server/README.md` saying so, which is a documentation gap rather than a work stream.
  - [—] Tier 3 (enterprise): automatic SQL query capture — **refused, and what ships is not it.** A span carrying `db.query.text` is rendered and stored, so the SQL a user's *own* tracer chose to record does reach the answer; that is Tier 2 data that happens to describe a query. Tier 3 is DevFlow instrumenting the database itself, which is a dependency installed into somebody's infrastructure and therefore the opposite of Invariant 1. The query text is never rewritten — showing somebody a tidied query their database never saw would be the wrong kind of helpful, and indistinguishable in the answer from one that really ran. **ADR 0021.**

### Work Stream 3.2: End-to-End Data Lineage Engine
- [x] **Wire-to-Database Inspector:** — **shipped as a fifth layer on `get_value_provenance`, and the decision not to build a third tool is the work stream.** `get_value_provenance` already answered where a value came from across four observations of one recording; `get_backend_trace` already answered what the server did under a recorded request. The gap was the join, and a third tool over the same question is the mistake this repository has made once already with its two markdown renderers — `src/core/mcp-bundle.ts` exists because of it, and 3.4 was written to avoid it. So the backend became `traceValue`'s fifth layer, ordered *first*, because a controller and a query are upstream of the response body and the module's ordering has always been the direction a value travels.

  **The chain is a known attachment; the value search over it is not, and the reply has to hold both.** Which call a span belongs to is *known* — the two are joined by the 128 random bits DevFlow minted and the backend echoed, not by a string comparison. That is a stronger link than anything else in the module. But a span carries no response body: what it can carry is a query's text, a path, its own name and an error message, so `£42.00` found in a `db.query.text` and `£42.00` found in a response body remain two sightings and not a lineage. Those two sentences point in opposite directions and both are true, which is why `backend.paths` is a different thing in the result from `hits` — a path says "this is the server-side work behind that call" and a hit says "this text appeared in it".

  **The value is usually not in the query, and that was measured rather than assumed.** Real instrumentation parameterises: the capture this repository already holds from a live `@opentelemetry/sdk-trace-node` records `SELECT total_amount FROM invoices WHERE id = $1`, so a search for the price on the screen finds nothing in the SQL and finds it in the response body one layer up. A design that had made the query text the mechanism would have shipped a feature that answers almost nothing. So the chain is printed whenever the value turned up at *either* end of the call — the response body or a span — and the query is shown exactly as the user's tracer recorded it and never rewritten.

  All four rows the roadmap asks for are reached, and the last two only when the user's own instrumentation recorded them: the component from the render layer, the endpoint from the response layer, the handler from a root span's `code.filepath`/`code.lineno`, and the query from a `db.query.text` at the bottom of the tree.
- [x] **MCP Tool:** — **`get_value_provenance` gains the layer; `get_full_lineage(domNodeId)` is not built, and the signature does not survive contact the way 3.4's did not.** A recording *describes* an element — tag, text, label, selector — and addresses none, so there is no `domNodeId` to pass. `valueOfStep` and the existing `step` argument are the handle that does exist, and inventing an id scheme nothing else in the product uses would have been a second answer to a question already answered.

  **One definition of "which calls are traced" replaced two on the way.** `tracedCallsOf` moved into `core/otel` because there are now three callers and two of them are on the far side of the bundle. The server's own copy numbered steps by position while every renderer beside it prefers the step's own `stepNumber`, so `get_backend_trace({step})` filtered on one number and printed the other. DevFlow's sender renumbers on the way out, which is why nobody had seen it; `POST /flows` accepts a flow from any local process that reaches the port without an `Origin` header, which is why that was not a reason to leave two. (An earlier draft of this sentence said "any page the browser visits" and that is false: `extensionOrigin` admits a missing origin or an extension's, and a browser attaches one to every cross-origin POST. The input is untrusted either way — the writer is a local process rather than a visited site.)

### Work Stream 3.3: Living Architecture Map
- [x] **Real-Time Component Graph:** — **shipped as a reading with an age on it, and "real-time" is the word that did not survive contact.**

  The roadmap asked for a graph that "updates in real-time as the developer navigates". A model calling an MCP tool asks **once**, at a moment, and reads **one** answer; there is no frame to render a stream into and no reader watching it arrive. So "real-time" here can only ever mean *fresh at the moment it was read*, and the honest unit of that is a reading that carries its own age — never a feed. This is the same correction `get_full_lineage(domNodeId)` and `compare_flows_across_deploys(flowId, sha1, sha2)` needed, and it is written out here for the same reason: a signature that reads well and cannot be built is worse than one that was corrected.

  Everything is built around not losing the age. `takenAt` is a required field of the reading rather than an optional annotation; the server **refuses a reading without one** (`400`, and the message says why) because a map with no age is this feature's one way of being actively misleading; the age and the URL are the first line of the answer, above anything a reader would act on; and past ten minutes the sentence changes from *this is mounted* to *this was the last reading, take another*. The reading is still printed when stale — withholding it would leave a reader with no map at all — but it is not offered under the present tense.

  **The persistent channel was costed and refused.** `.ctx/contexts/phase-3-remaining.ctx.md` recorded the blocker correctly: every path into the MCP server is the extension *pushing* over loopback, and there is no channel back to an open tab. That is only a cost if the tool must **pull**. Reversing the direction — the page agent takes one bounded reading, the extension pushes it over the channel that already exists beside `POST /arkg/ingest-component` — needs no socket, no persistent connection and no MV3 service worker kept awake for a feature that may never be called. What a held-open socket would buy is nothing a model can use: the answer would still be one snapshot taken at the moment of the call. What it would cost is permanent, on every page.

  - [x] Which components are currently mounted, and which React contexts each reads — one bounded breadth-first walk in `src/injected/architecture.ts`, under the recorder's own `recording.renderNodeCap`, installing nothing.
  - [—] **Active API calls are not in the reading, and this is a refusal rather than an omission.** A mounted tree is readable in one pass because React keeps it; an in-flight request leaves no trace on that tree, so recording one means ambient bookkeeping on every page the agent is injected into — which is every page — for a feature nobody may have switched on. That is the trade `v3.2.0` made with its commit hook and was reverted for. The endpoints an application calls are already in `get_app_architecture`, accumulated and labelled as accumulated, and the answer points there. **ADR 0022.**
  - [x] The walk installs nothing, patches nothing and subscribes to nothing. It takes **one** reading, not two, so it does not even need `render.ts`'s double-buffer pairing.
- [x] **Structure, never values.** — **a shape decision, not a budget.** The reading carries component names, their source paths where the page knows them, and which contexts they read. No prop, no hook state, no store contents, and there is nowhere in the wire shape for one to sit — not capped, not redacted, absent — which is the only version of that promise a later caller cannot loosen by passing a bigger budget. The reason is that a recording is values and somebody pressed Start and chose in the send dialog what left the browser, while a reading is taken while somebody reads code, through a path with no dialog in front of it.
- [x] **Interactive Graph Queries:** — **both questions are answered.**
  - [x] *"Which components depend on `cartState`?"* is answered: every context in the reading carries the components observed depending on it, which is the `subscribes_to` edge read live instead of accumulated. It inherits that edge's limit exactly — a module-level Zustand store with no provider leaves no dependency on a consumer's fiber (ADR 0005) — and the answer says so rather than printing an empty section that reads as "nothing subscribes to anything".
  - [x] *"Show me everything that renders when I click checkout" → animated graph.* **Shipped as the cascade, in Flow review — `What this caused` on every step.** It is a **join**, and the join is where a tool of this kind lies most easily. `core/causal` already derived what a step caused and `core/render/blame` already said what re-rendered across it, and the two were kept apart because a re-render is *not* a causal event — `CausalGraph` has four kinds and `render` is not one of them, since a component has no identity the accumulating graph keys stably.

    **Every render edge is gated on evidence and carries which it had**, strongest first: `subscribed`, where the component is on that store's observed `subscribers` list *and* the store moved in this step — an observation off the component's own fiber, not an inference; `named`, where a context the component depended on changed and its name matches the store's, which is a match and not a sighting because two contexts can share a `displayName`; and otherwise `sampled`, which attaches the component **to the interaction, not to whatever store happened to move**. There is no fourth rule that guesses. A component that re-rendered and a store that changed in the same moment are two things that happened, and an arrow between them would be this tool inventing the finding a reader came for. `tests/cascade.test.ts` asserts that refusal directly, and a mutation that draws the guess kills the suite.

    **Layers come from the strongest incoming edge, not the shortest path**, and that correction was measured rather than reasoned. A console line under a failing request carries two parents — the step, `attributed medium`, and the request, `named high` — so shortest-path drew the error *beside* the request instead of after it, and the only edge that said anything was invisible in the layout. An earlier draft also rebuilt the state event's ref as `state:N.1` when `core/causal` writes `state:<step>/<store id>/<n>`; it matched nothing, every render fell through to `sampled`, and the picture looked entirely reasonable. Both were found by printing the real graph.

    **"Animated" is ordered, not timed.** Columns are revealed in causal order because the order is the finding; the intervals are fixed and say nothing about duration, since a cascade animated at recorded speed would be a stopwatch and this is not one. Skipped under `prefers-reduced-motion`, with **Replay** so it is under the reader's control.

    **Confidence is drawn in weight and dash, never in hue** — spending the palette's semantic colours, which mean failure and success everywhere else, on a confidence scale would also make the strength of a claim unreadable to a colour-blind reader.

    What the picture refuses to imply is printed under it at body size, not in the footer: re-renders are sampled and not counted, an absent arrow is not an absent cause, and a capped snapshot means a change below the cut reads as no change. A graph is the presentation that most invites a reader to believe it is complete.
- [x] **MCP Tool:**
  - `get_living_architecture(url?)` — the URL argument is the one addition to the roadmap's signature, and it is there because readings are held per page: a developer with two tabs open has two, and the freshest is not always the one being asked about. A miss names the pages that *are* held, because a typo and an unread page are two situations with two next moves and neither is "the application is empty".
  - **It does not write to the ARKG, and that is deliberate.** Every other ingest on the server accumulates — a pick raises a frequency, a flow adds edges. A reading is a census of one moment rather than an observation of behaviour, and folding it in would inflate exactly the counts the graph exists to keep honest: a component mounted on a page nobody interacted with would count as often "seen" as one somebody exercised, and `get_anomalies` reads those counts.
  - **Nothing survives a server restart, by design.** A saved map's only possible use is to answer a question wrongly — handing a reader yesterday's map of a page that is not open. So readings live in memory, the most recent eight pages, and this work stream adds no retention ceiling, no sweep and no line in `~/.devflow/config.json`, which every other thing the server stores needed.

### Work Stream 3.4: Temporal Diff & Regression Detection
- [x] **Cross-Deploy Flow Comparison:** — **shipped, and it is a join rather than a second comparison.** `compare_flows` already answers what differs between two runs: where they stop doing the same thing, which endpoints answered differently, what only one of them calls, which errors only one logs. Building a second comparison beside a working one is the mistake this repository has already made once, with its two markdown renderers, and `src/core/mcp-bundle.ts` exists because of it. So the new work is the commit join and nothing else — which is also why this was the cheapest of Phase 3's five work streams by a wide margin, and why it went first.

  **The roadmap's signature does not survive contact, and the correction is the finding rather than a detail.** `compare_flows_across_deploys(flowId, sha1, sha2)` asks a recording for its two builds, and a `flowId` names *one* recording made at *one* commit. No id has two SHAs. What exists at two builds is a flow **by name**: somebody recorded "Checkout" on Tuesday and again on Thursday. So the tool takes a name — or the id of any one recording of it, and uses that recording's name — and the two SHAs select among the recordings carrying it. With neither SHA given it compares the two most recent builds, which is what somebody asking the question usually means.

  **The pair is ordered by commit date, not recording date**, because reproducing a regression means checking the old build out and recording it *second*, and a report that called that the newer build would have every sentence after it backwards while still reading perfectly well.

  Every refusal names what *is* available. A flow nobody recorded twice, a flow recorded ten times at one commit, a SHA that names no recording and a prefix that is ambiguous between two are four situations with four different next moves, and only one of them is a typo.
- [x] **"What Changed?" Incident Timeline:** — shipped as the three sections below the comparison, and **the fourth is a shortlist, not a hypothesis.** The deployment timeline and per-deployment change set are `git log older..newer`; the runtime diff is `compare_flows`; and then the cross: the changed files DevFlow has actually watched code run in, pooled across every recording and pick rather than only the two being compared. That last section is deliberately *narrower* than the commit list above it — a deploy touching forty files may produce three entries, because the other thirty-seven are files no recording has ever run through, and that gap is the whole of what an accumulated runtime graph knows that `git log --name-only` does not.

  **What was refused is the word "causal".** The roadmap asks for a causal hypothesis constructed automatically, and the answer prints *"A shortlist, not a cause"* in those words, on the same argument `core/diagnose` was built on: the mechanism is an intersection of two sets and it cannot tell a coincidence from a culprit, so it does not get to imply that it can. A file that changed in the range and renders a component that now behaves differently is worth reading first, and is not thereby the reason. `tests/deploy.test.ts` asserts that sentence is present, because it is the difference between a tool that offers evidence and one that names a culprit.

  An unreadable range, an empty range and two builds on **diverged branches** are told apart. The last two produce the same empty `git log` and are not the same finding: one says nothing shipped between them, the other says the question has no single answer.
- [x] **MCP Tool:**
  - `compare_flows_across_deploys(flow, sha?, otherSha?)` — the signature above, for the reason above.

### Work Stream 3.5: Framework-Agnostic Adapters
**Deferred to Phase 5, as three work streams rather than one. This line is the decision, not a gap — ADR 0017.**

Vue 3, Svelte 5 and React Server Components do not share React's fiber tree, and **nothing in `src/core/react/` transfers**: fifteen modules whose every entry point is fiber-shaped. Each adapter is a Phase-1-sized body of work with its own runtime to measure, and this phase's preamble already said the consequence — *starting one and leaving two would be worse than starting none*. Phase 4 depended on none of them and shipped without them.

**The RSC bullet is not the same kind of work as the other two.** A server component never mounts in the browser: there is no runtime tree to adapt, only a wire protocol to read. That puts it closer to `core/otel`, which now exists, than to `core/react`, and makes it the one of the three with a route that does not start from scratch.

The three are listed in Phase 5, once. Restating them here would be the same list in two places, disagreeing the first time one is edited.

---

## Phase 4: Production Telemetry & CI Regression Watcher
**Objective:** Production crash ingestion, git forensics, CI regression detection and accessibility auditing. Autonomous remediation was refused rather than built — see §4.5.

**What Phase 4 closed as, and why the shape is not the one this section was written in.** Four work streams were built in the order this project has learnt to use — cheapest join onto existing data first, new mechanism later — and three boxes close as arguments rather than as code, each with an ADR behind it. Built: **4.3** git forensics, a join onto the `changed_in` edges and per-node `git_sha` that Phase 3 left; **4.6** the accessibility autopilot, a bounded page-side read in 3.3's own pattern; **4.4** the regression watcher, the first thing in this product that runs outside a browser; **4.1a** the crash receiver, the first thing that ingests data DevFlow did not observe itself. Closed in writing: **4.1b** (ADR 0018), **4.2**'s editor half (ADR 0019), **4.5** (ADR 0020).

**Three roadmap promises did not survive contact and are corrected in place rather than quietly narrowed** — the precedent this file has kept since Phase 2. "Determine the exact commit **and PR**": nothing DevFlow observes carries a pull-request number. "**Continuously** audit the live DOM": nothing is continuous, and `src/injected/state.ts`'s refusal to install anything is why. Semantic diffs including "**re-render counts** and state sequence" in CI: those come from the extension, and the extension's service worker does not register in Playwright's headless Chromium — measured, not assumed.

**And a fourth signature assumed a caller could address something it cannot**, which is now a habit worth checking for rather than an incident. `get_full_lineage(domNodeId)` (a recording describes elements and addresses none), `compare_flows_across_deploys(flowId, sha1, sha2)` (one flow id names one commit), `get_living_architecture()` (a tool call is a moment, not a stream) — and now a Sentry webhook, which cannot reach a loopback port at all. Each time the fix was to reverse the direction the requirement was written in, and each time the reversed version was smaller and more honest than the original.

### Work Stream 4.1: Production Telemetry & Incident Ingestion
- [~] **Sentry webhook ingestion** — `POST /webhooks/sentry`, JSON only, **off unless `DEVFLOW_WEBHOOKS=1`**, unreachable from a web page, and bounded before the body is trusted. A crash joins to the source files its stack actually reaches, and `get_blast_radius` shows it beside what the runtime has observed in that file — which is the moment it is worth anything: a crash in production and a file you are about to edit are the same question asked from two ends. Four things are narrower than the heading:
  - **Sentry cannot reach a loopback port, and this says so rather than implying an integration.** Their servers can no more POST to `localhost:8787` than to any other machine behind a router. What this accepts is a delivery somebody **relayed** (`smee.io`, an `ngrok` tunnel, a small forwarder) or **replayed** (an exported event, `curl`ed in). That is the **fourth** roadmap signature to assume a caller could address something it cannot — after `get_full_lineage`, `compare_flows_across_deploys` and `get_living_architecture` — so it is now recorded as a habit to check for rather than as an incident.
  - **Datadog and Bugsnag are not built.** One provider, done properly, with a parser that names its provider in the node's key. Adding two more shapes on the strength of their documentation would be three unverified integrations instead of one.
  - **This is the one piece of Phase 4 built against a documented shape rather than a measured one, and that is the risk to record.** The OTel work in 3.1 was settled by running a real `@opentelemetry/sdk-trace-node` service and printing what arrived — three of the four wire facts it established would have been got wrong by reasoning. No equivalent was possible here: there is no Sentry instance that can reach this machine. The parser is therefore defensive about shape — every field checked before it is read, three envelope shapes unwrapped, an unrecognised payload refused with a *reason* rather than partly understood — but it has never seen a live delivery.
  - **"Failure rates for all affected components" is refused as worded.** A stack frame names a file and a line, not a component, and in a minified production build it names a chunk. A crash is joined to a **source file** through `matchSourceFile` — exactly after normalisation, or by a suffix exactly one known file answers, never by a guess — so a ten-frame stack may draw one edge or none, and none is a real answer meaning the graph has never watched code run in any file that crash touched.
  - **A production count is never added to an observation count.** `frequency` in the ARKG counts *recordings DevFlow made*; `event_count` counts *events a provider saw in production*. They live in different tables and every surface that prints both says which is which, because merging them would silently change what every existing figure in the graph means — `getAnomalies` would compute a baseline over two units and nothing would notice.
  - **A crash payload is somebody else's user's data, and almost none of it is kept.** The exception **type** but never its interpolated `value`; the culprit, level, count and link; a frame's **filename and line and nothing else**. No `user`, no `request`, no headers, no cookies, no body, no `contexts`, no `breadcrumbs`, no `extra`, no `vars`, no `context_line`. The payload is never handed on as it arrived — every field is read out by key, the way `POST /arkg/ingest-component` reads a pick — and `tests/telemetry.test.ts` asserts the absence of each of those rather than trusting a reading of the parser.
- [—] **Session Replay Ingestion (PostHog / LogRocket / FullStory)** — **deferred to Phase 5 as the Production Time Capsule, with the argument in ADR 0018.** This is not a webhook parser with more fields: it is `git checkout` at an incident SHA, a Docker sandbox, seeded storage and HAR-injected network — the Production Time Capsule in full, which the vision document scoped as long-term before it was removed — ADR 0028 records it. Nothing in the rest of Phase 4 depends on it.

### Work Stream 4.2: Source → Browser Live Link (IDE Integration)

This is two things wearing one heading, and costing them apart found that one was already built and the other needs two mechanisms this product has never had. See **ADR 0019**.

- [—] **VS Code Extension** — **deferred, with the cost named.** It needs a fourth npm package, published, plus the one direction the MCP server still cannot address: a channel from the server *to* an open tab. `devflow-compiler-plugin` is the standing precedent for what a fourth package costs — it is `private: true` and unpublished precisely because it has never been run against a real application's build, and an editor extension is a larger version of the same bet.
- [x] **Live Blast-Radius Preview** — **shipped in §4.3 as `get_blast_radius`, and the discovery is the point.** `getBlastRadius` had existed in `mcp-server/arkg.js` since Phase 0, with tests beside it, and was reachable from **nothing**: no MCP tool, no UI, no caller in `src/`. A query no surface prints does not exist from outside the process, so half of this work stream had been built and was invisible.
  - **The claim is made at the size it is true at.** `maps_to` points from a component to **the file it was written in**, so the answer is *components observed to have been written in this file*, plus one hop of what each was seen calling and reading — not the files that import it, because an import is a static fact and nothing in a runtime graph observes one.
  - **This line's own example does not survive that.** *"This change to `useCartStore.ts:42` currently affects 7 rendered components"* describes the wider claim: a store's own file usually has no components written in it at all, and its subscribers are reached through a `subscribes_to` edge rather than through the file. The runtime graph cannot answer the sentence as written, and the tool says what it can answer instead.
  - Production crashes reaching the file are printed under the same answer — §4.1a — because "what should I know before I change this file" is one question.

### Work Stream 4.3: Git Forensics & Blame Intelligence
- [~] **Regression Bisect Engine** — **shipped as a shortlist, and the word "bisect" is the part that did not survive contact.** `get_commit_candidates` answers, for a component or a file, which commits changed the code it was written in and which of those landed *after the last moment DevFlow watched that component run*. That crossing is the whole of what is new: git knows the history and the graph knows what it has seen running, and neither knows the other's half. What is refused is the promise around it:
  - **No cause is named**, on any answer, in the same words `diagnose_failure` and `core/deploy`'s shortlist use. The mechanism compares *where commits sit in the history* against *one observation date*; it cannot tell a coincidence from a culprit, and every answer says so in a closing paragraph that is printed unconditionally rather than only when the tool is unsure.
  - **"PR descriptions" is struck out rather than deferred.** Nothing DevFlow observes carries a pull-request number. A recording knows a checkout and a checkout knows commits; a tool that printed a PR would be printing something it invented. Author, subject, date and SHA are real and are what it prints.
  - **`changed_in` alone cannot answer this, which is why the walk is git's.** `arkg_git_commits` gains a row only when a recording or a pick arrives while that commit is checked out, so the graph's commit history is a *sample* of the repository's — a developer recording weekly holds one commit in every few hundred. Asking the graph "which commits changed this file" answers "one" where git answers "thirty". So history comes from `git log --topo-order`, the graph supplies the sighting, and the answer states which half each claim rests on. The `changed_in` edges keep their existing job in `compare_flows_across_deploys` and are not duplicated.
  - **The ordering is ancestry, and that correction came from measurement rather than from review.** This was built to compare commit dates and the first end-to-end run refuted it in one line: git records `%ct` to the *second*, so the sighting's commit and the change that followed it both read `2026-09-03`, and a date comparison resolved the tie to the reassuring answer. Dates were only ever a proxy for *did this land after the one we watched running*, which is a question about ancestry — so the walk is `--topo-order` and a commit's position in it is what places it. Dates remain as a fallback for a sighting older than the walk's window, and `describeCoverage` says which of the two was used, because a same-second tie is invisible under one and impossible under the other.
  - **Coverage is stated, not implied.** How many commits were walked, whether the walk stopped at its limit, how many touched the file, how many of those the graph itself holds, and — when it does not — that the component has no clean-tree sighting to measure against, with `core/git`'s reason for why a dirty tree writes no commit.
- [x] **Automated Commit Attribution** — which file, which commit last touched it, and who authored it, out of the same tool. *Which function* is not answered and is not a gap left open: the graph resolves a component to a file and a line, not to an enclosing function, and `git log -L` over a line range is a different and much more fragile mechanism than the one above.
- [x] **Live blast-radius query given a reader** — **and this is Work Stream 4.2's half, landed here because it was already built.** `getBlastRadius` has existed in `mcp-server/arkg.js` since Phase 0 with tests beside it and **no caller at all**: no MCP tool, no UI, nothing in `src/`. A query no surface prints does not exist from outside the process. `get_blast_radius` is that reader, and it makes the claim at the size it is true at: `maps_to` points from a component to **the file it was written in**, so this is *components observed to have been written in this file*, plus one hop of what each was seen calling and reading — not the files that import it, because an import is a static fact and nothing in a runtime graph observes one. The roadmap's own example (§4.2, *"this change to `useCartStore.ts:42` currently affects 7 rendered components"*) describes the wider claim, and the wider claim is not available from runtime observation.

### Work Stream 4.4: Autonomous Regression Watcher (CI Integration)
- [~] **Semantic CI Integration** — `devflow-mcp regression` replays the flows committed to a repository against the current checkout and reports. Two of the three promised diff dimensions are delivered and one is refused with a measurement behind it, so this is `[~]` rather than `[x]`:
  - **The mode decides what the diff can contain, and the two are never blended.** A recorded flow exports to a Playwright spec that fulfils each request with **the response the recording captured**. That is right for "does this journey still complete" and it makes a wire diff meaningless — the run's statuses and latencies would be the recording's own, played back, agreeing perfectly forever and measuring nothing but its own fixtures. So `--mode mocked` (the default) compares **no wire at all** and says why, and `--mode live` serves nothing, talks to whatever the branch built, and compares real statuses and latencies. Every report names its mode on the first line because every other line means something different under each.
  - **API latency and status: delivered**, in live mode. An unmocked spec collects its own wire through a `page.on('response')` listener and leaves it as a Playwright attachment; the runner reads it out of the JSON report it already parses. A change is reported only when it clears **both** an absolute floor (100ms) and a relative one (30%), and the numbers it cleared them with are printed — a 40ms endpoint that becomes 60ms is 50% worse and nobody cares.
  - **Re-render counts and state sequence: refused, and the refusal was measured rather than reasoned.** Those come from the extension sampling React's fibers, and a replay drives the page with Playwright and no extension. The extension *can* be loaded — `launchPersistentContext` with `--load-extension` — and the experiment settles what that is worth: DevFlow's MV3 service worker **registers in a headed Chromium and does not register at all in Playwright's headless one**. An extension-observed CI run therefore needs a display (`xvfb-run` on Linux), which is a real requirement and a different piece of work. Every report says this in words rather than omitting the dimension silently.
  - **A run that could not decide is not a run that passed.** `core/replay`'s rule — everything unrecognised resolves *away* from `passed` — is extended from one report to a set of them: a flow that was unreadable or matched no tests makes the whole check `inconclusive`, which outranks `regressed`, because a run it could not read is a run whose failures it also cannot trust. An empty run is `inconclusive` too, never a green tick meaning "nothing happened", and `--strict` turns that into a failing exit code.
  - **Flows have to be committed, and this is stated rather than hidden.** A recording lives in `~/.devflow/flows` on the machine that made it; CI has no such directory, so a flow it should replay belongs in `.devflow/flows/<id>/flow.json`. The report says so when it finds none.
  - **Which changed files are implicated comes from the graph, and is called a shortlist.** `git diff --name-only` crossed with the source files the ARKG has actually watched code run in — the same join `core/deploy` makes, with the same discipline: a PR touching forty files may implicate three, the count of unimplicated files is printed because *that gap* is what the runtime graph knows and git does not, and nothing here says the shortlist is a cause.
- [x] **GitHub Actions Integration** — `.github/actions/devflow-regression` is a composite action, with `.github/workflows/regression-example.yml.disabled` as a copyable workflow.
  - **It posts nothing, and that is the design.** The check writes a report to stdout and to `--out`, and sets it as an action output; publishing it is a separate step the calling workflow owns. This is ADR 0010's shape applied a second time — what DevFlow *writes down* and what it *sends* are two switches — and the argument is sharper here: the credentials that can comment on a pull request belong to whoever owns the repository, not to a tool a workflow file can point anywhere. The example workflow shows the publishing step and says that deleting it costs nothing but the comment.
  - **It runs the repository's own test runner against the repository's own application**, so it is behind `DEVFLOW_REPLAY=1` exactly as `replay_flow` is, set in the workflow where somebody deliberately asks for it. A second variable would have let a workflow file run the code of somebody who had turned replay off.
  - The action reads the check's exit code directly and never through a pipe, for the reason this repository's own gate does.

### Work Stream 4.5: Self-Healing Ephemeral Environments
- [—] **Automated CI/CD Fix Bot** — **refused, holding ADR 0009, and recorded in ADR 0020.** This is §2.4's refusal restated as a workflow rather than as a tool: DevFlow is not a model, the caller is, and a version that wrote to a working tree from a CI job would be editing somebody's repository while calling itself a check. Phase 4 strengthened the case in two places it did not set out to — §4.3's forensics names no cause on any answer, so "isolates the root cause" has nothing behind it, and §4.4 measured that a CI replay observes *less* than the recording that found the bug, so "verifies it in sandbox" would verify against the narrower evidence. Both are in ADR 0020.
  The two ends ship and the middle does not: `diagnose_failure` for the diagnosis, `replay_flow` and `devflow-mcp regression` for the verification. The patch belongs to whoever can write one.

### Work Stream 4.6: Accessibility Autopilot
- [x] **Dynamic A11y Auditing** — eight checks, six from the settled page and two that exist only in the difference between two samples. Contrast against the colours the browser **actually computed**; an interactive role with no accessible name; a role the keyboard cannot reach; something focusable inside an `aria-hidden` subtree; a positive `tabindex`; an ARIA state the role does not take; a native `disabled` contradicted by `aria-disabled="false"`; and the pair — a modal that opened without focus moving into it, and one that closed leaving focus nowhere. Every finding carries the numbered WCAG success criterion it fails, what was measured, and the component and file it was found in, through the same fiber walk the recorder already makes.
  - **"Continuously" did not survive contact and is corrected here.** Nothing is continuous: there is no `MutationObserver`, no focus listener, no poll. The audit reads at the two moments the recorder already samples, which is the refusal `src/injected/state.ts` and `src/injected/render.ts` both hold and the reason `v3.2.0` was reverted. The cheap half — what has focus, which modals are open — is taken inside the gesture; the walk that costs anything runs after the app has settled.
  - **"Generate a targeted fix" is refused, under ADR 0009.** DevFlow is not a model and the caller is. The criterion, the measurement and the component are what a finding carries, and every rendered answer says outright that no fix was generated.
  - **A check that cannot be measured is not run, and the count of skipped elements is printed.** `getComputedStyle().backgroundColor` is transparent on nearly everything, so the colour behind text is an ancestor's — and behind a gradient, an image or a translucent stack there is none. The walk resolves an opaque backdrop or reports nothing, and a node with nothing is skipped rather than compared against an assumed white, which is the mistake that produces confident wrong ratios on every dark theme ever shipped. **Measured: on a 2107-element page, 542 of the 1500 elements walked had no resolvable backdrop.** That is not an edge case, and a report that quietly judged them would be wrong about a third of itself.
  - **The accessible name is an approximation and says so on every finding that reads one.** `aria-label`, `aria-labelledby` resolved one level, a native `<label>`, `alt`, `title`, then text — not the full accname algorithm, whose traversal rules are a specification of their own. A partial implementation that did not admit it would be the worse thing to ship.
  - **The focus *trap* is named as a gap, not tested.** Whether Tab cycles inside a dialog can only be learnt by pressing Tab, and pressing Tab is DevFlow taking part in the application it records. What two samples answer is whether focus moved in and whether it came back, which is where the common bug lives — and the step's note says the trap itself was not tested, so a passing focus check is never read as one.
  - **Measured against the NFR rather than argued about.** Real Chromium, a 2107-element page: the settled walk is **4.9ms median (5.2ms max)** at the 1500-element cap, and the reading taken inside the user's click is **under a microsecond** — it touches `document.activeElement` and the modal containers and walks nothing. At one interaction a second that is well inside the <2% CPU budget, and the 428KB the raw reading occupies is transient and never crosses a `postMessage`: only the findings do.
  - **It is off by default**, which is the only recorder capture that is, and the default came from that measurement rather than from a policy. The flow says `a11y.read: false` and `get_step_detail`'s a11y part says it in words, because an absent finding must never read as a clean page.
  - Read it with `get_step_detail({ part: "a11y" })`; `get_flow_summary` carries the count when the audit ran. **No new tool was added** — the boundary rule in §4.3 applies here too.

---

## Phase 5: Framework Adapters
**Objective:** Make DevFlow work at all on the runtimes it currently cannot read.

This phase used to be called *Ambient Intelligence & Platform* and carried four
work streams. Three were removed rather than deferred, because each was answering
a question this product's data cannot answer or had already answered elsewhere;
the arguments are ADRs 0023, 0024 and 0025 and are summarised at the foot of this
section. What survives is the one item that answers a complaint nothing else in
the roadmap touches: on a Vue or Svelte application DevFlow does not degrade, it
does nothing — the picker finds no component and the locator has no tree to walk.

### Work Stream 5.1: Expanded Framework Support
Deferred here from §3.5 by ADR 0017, **as three work streams rather than one.**
ADR 0017's rule stands: taken together or not at all. Its overturn clause admits
*"an argument for building all three"*, and that is what this work stream is.

**Two claims this section used to make did not survive contact, and both are
corrected here rather than quietly dropped.** They were measured on 2026-09-04 —
once by reading this repository's own code, and three times by running real
applications. The spikes are `.ctx/spike-vue.md`, `.ctx/spike-svelte.md` and
`.ctx/spike-rsc.md`; the arguments are ADRs 0026 and 0027.

*It used to say `src/core/react/` is fifteen fiber-shaped modules and none of it
transfers.* Ten of the fifteen carry zero React references in code. Four `core/`
modules with nothing to do with React — `otel`, `architecture`, `provenance`,
`source` — already import `core/locate/positions.js` today. And all three spikes
independently grepped **production** bundles for needles built with DevFlow's own
`buildNeedle` constants and hit byte-for-byte: Vue 14/14 across Vue and Nuxt,
Svelte 3/3 decoding to `Counter.svelte:5` exactly, RSC client components through
served maps. The needle / bundle-search / source-map / editor-URL engine is the
part that transfers; the fiber walk and its attribution rule are the part that
does not. ADR 0026. This makes each adapter smaller than a Phase-1 work stream,
which is a correction in 0017's favour rather than against it.

*It used to say a server component never mounts in the browser, so RSC is only a
protocol to read — `core/otel`'s kind of work.* Wrong in both directions. In
`next dev` there **is** a runtime tree and it is the richest route: `_debugInfo`
on the fiber carries the name, `env: "Server"`, the owner chain, props and a
resolvable stack — while the wire *lacks* that identity. **This paragraph
overstated it when first written, and the correction came from building the
adapter rather than from the spike:** `_debugInfo.stack[0]` is the *call site*,
not the declaration. `ServerOnlyWidget`'s reachable frame is named `Page` and
resolves to `app/page.tsx:13:7`; the declaration frame reaching
`ServerOnlyWidget.tsx:7:5` arrives only on the dev HMR websocket, which
`src/injected/` may not subscribe to. The call site is what ships, it is
labelled `at: 'call-site'` rather than passed off as a declaration, and it is
the same answer `core/react/owner.ts` already leads with. In `next build` there is no protocol to read either: a
server component leaves no name, no module id and no file anywhere on the wire.
And `core/otel` is not where the case starts — `@vercel/otel` produced 30 real
spans carrying zero component or file identity in any attribute. ADR 0027.

**What each adapter can honestly deliver differs by build mode**, and is written
out here rather than hidden behind one checkbox. All three work in development.

- [x] **Vue 3 / Nuxt:** Reactivity proxy inspector and template mapper. Both halves. Development resolves through `__vueParentComponent` and `type.__file`; production walks down from `__vue_app__` and resolves through the bundle search to the component's own `.vue` file and line. Verified end to end against real applications on **both** Vite and webpack, and the walk budget is measured rather than guessed. See *What the real runs proved*.
  *Dev:* `__vueParentComponent` on every element, `type.__file` on the component.
  *Production:* element links are stripped and installing the devtools hook does
  not restore them, but an O(tree) walk from `__vue_app__` still resolves —
  provided it follows `suspense.activeBranch`, or it reaches nothing on Nuxt. The
  needle comes from `instance.render` and never from `type.setup`: through the
  real source map, `setup` resolved to the **wrong file** in 3 of 4 production
  cases, once landing inside `runtime-dom.esm-bundler.js`.
- [x] **Svelte 5 / SvelteKit:** Runes and signals inspector. Development resolves to file, line and column through `__svelte_meta`, which is richer than React's own `_debugSource`. **Production resolves nothing, and that is the runtime's ceiling rather than unfinished work**: the build leaves elements with zero own properties, and enabling source maps was measured to change nothing because the missing half is the element-to-component link. The adapter says so in words, naming `build.sourcemap`. Five targets, verified end to end.
  *Dev:* `__svelte_meta` carries `{loc: {file, line, column}, parent}` — strictly
  richer than React's own `_debugSource`.
  *Production:* **honestly nothing.** Elements have zero own properties; the only
  element-to-function edge is `element[Symbol(events)][name]`, which exists for
  the 23 delegated events, yields the handler rather than the component, and
  produced a 9-character needle against `MIN_NEEDLE_LEN = 12`. SvelteKit's
  default build ships **zero source maps** — 0 `.map` files and no
  `sourceMappingURL` until `build.sourcemap: true`. The right answer here is to
  report *absent*, naming the one line of the user's own config that would fix
  it, rather than to guess a file.
- [~] **Next.js App Router & RSC:** the wire protocol *and* the dev fiber. Development resolves through `_debugInfo`; a page registers as React *and* RSC, as designed, and both tables travel. `mcp-server/rsc.js` is wired and proven against a real `.next/server` tree. **Left at `[~]` for one measured reason:** in production a client component is joined to its module id only when the server passed an `id` or `data-*` prop through to it, and a page whose client props are all non-attribute gets nothing. That is Next's ceiling rather than a missing piece here, but it is a real hole in coverage and a tick would overstate it.
  *Dev:* `_debugInfo`, as above.
  *Production:* client components only, and their numeric module ids resolve
  through `.next/server/*-manifest.js`, which 404s on every served path — so this
  half is forced into `mcp-server/`, the only one of the two with a filesystem.
  Server components are unreachable at any price.

#### What the real runs proved, and what they found

A Vue 3 application was built, the extension was built, and Chromium was driven
headed with the extension loaded — headed because this repository already knows
the MV3 service worker does not register in Playwright's headless. A recording
was started the way the popup starts one, three clicks were made on a nested
component, and storage was read back.

**It works, in both builds, and the production path is the interesting one.**

- *Development:* `frameworkMeta` reported `vue`, `3.5.42`, `development`. Each
  step carried a three-component chain, and all three resolved `status:
  resolved`, `via: debug-source`, with real `.vue` paths — outermost first,
  `App › CartPanel › CheckoutButton`, the true nesting.
- *Production:* the element's own properties came back **`[]`** — the build
  strips every link, exactly as the spike measured — and only the mount
  container kept `_vnode` and `__vue_app__`. The chain still resolved, through
  the O(tree) walk, and the names survived minification because
  `@vitejs/plugin-vue` injects `__name`. The components are `status: pending`,
  saying in words that finding their files needs a bundle search that is not
  wired. **That is the mapper half of this bullet, and it is why the box is
  still `[~]`:** in production Vue gives names and not files.

**The run found a shipped bug that no fixture could have.** `saveFlow` in
`mcp-server/server.js` copies a posted payload's flow-level fields **by name**,
and `vue` was not one of them — so a real recording arrived with its component
table and lost it on the way to disk, while every fixture written straight onto
disk kept it and passed. The comment on that very line already warned that *"a
reader added without its line here is the same bug again"*, having been bitten
once by `state`. It was right. `tests/framework-end-to-end.test.ts` now starts
at a `POST /flows` and ends at the tool output; removing the line again turns
four of its five assertions red.

With that fixed, `get_step_detail` answers a real Vue recording:

```
vue: CheckoutButton  src/components/CheckoutButton.vue
vue chain, outermost first: App › CartPanel › CheckoutButton
```

rendered through the same `formatSource` React uses, with no new tool.

**Svelte and RSC have had no such run.** Their adapters are gated on fixtures
only, and the Vue run is now direct evidence that fixtures are not enough here.

**Svelte, five targets.** Development resolved `App › CartPanel ›
CheckoutButton` to `src/lib/CheckoutButton.svelte:10`; the SvelteKit dev chain
was filtered of its six `Pyramid_N`/`render`/`if` frames exactly as `chain.ts`
promises. Production resolved **nothing**, correctly — every element's own
properties came back `[]`, the only symbol anywhere was `Symbol(events)` on the
clicked button. SvelteKit's default build shipped **0** `.map` files. The
sharpest result: building again with `build.sourcemap: true` produced 8 maps and
a **byte-identical** absent row, because the missing half is the
element-to-component link, not the map. That is worth knowing before anyone
spends a day on source maps expecting it to help.

**Next.js, both builds.** `_debugInfo` was present in `next dev` exactly as
measured — `{name: 'ServerOnlyPanel', env: 'Server', owner: Page, …}` — and gone
in production, with every fiber type minified to a single letter. The page
registered as **React *and* RSC**, both tables reached disk, and
`get_step_detail` printed both sections in one reply. They disagree usefully:
React named `CheckoutButton  app/components/CheckoutButton.tsx:5` while RSC said
`Page`, because RSC's client components have no `_debugInfo`.

**Between them the two runs found five defects, all now fixed.** Three are worth
naming because none could have been caught by a fixture:

- **`captureAndSave` read two storage keys it never asked for.** `getLocal`
  answers with `Partial<LocalStorageShape>` whatever it is handed, so
  `stored.value.frameworkComponents` typechecked and was `undefined` forever —
  the merge was unioning against nothing and *replacing* the table every step.
  Measured shrinking live across three clicks, losing the best answer in the
  recording. React escaped only because its two keys were already in the list.
  The guard is now an invariant test that reads the source and asserts every key
  the function reads is a key it asked for, because the next reader will make
  the same mistake and no type can stop them.
- **The RSC production arm was unreachable on the page it was written for.** Its
  guard was `chain.length === 0`, and on a real App Router page the chain is
  never empty: Next's own `LayoutRouter`, `RedirectBoundary` and `ErrorBoundary`
  are ordinary functions in the production bundle and yield a `searchable` each
  — seven measured. The old rule assumed the two facts competed. They do not: a
  function *above* an element is its ancestor, not necessarily what rendered it,
  and if the markup is on the wire a server component emitted it. Both are now
  reported, with the element's own origin innermost where it belongs.
- **`ResolvedChain.build` was declared for Svelte and never set by Svelte** —
  the field's own documentation says *"Svelte is why this is here"*, and a real
  `vite dev` page recorded `build: "unknown"` while every element carried
  `__svelte_meta`. `FrameworkComponentTable.build` had no reader anywhere.

Also fixed: RSC never marked its frames `at: 'call-site'`, so the sentence
`resolutionSource` writes for that case was dead code and a call site shipped
indistinguishable from a declaration; and the framework table merge let every
unnamed absence collapse onto one placeholder id, so a recording visiting two
Svelte pages kept the first page's advice and dropped the second's —
`core/react/table.ts` has guarded exactly that with `isPlaceholderId` for
months.

**`mcp-server/rsc.js` still has no caller, and the run confirmed it is blocked
rather than forgotten.** Its two entry points need a numeric client-module id or
a `next-action` hash. Neither exists anywhere in the pipeline: `ComponentSource`
has no module-id field and the adapter never emits an `I`-row id. Giving it a
caller means teaching the adapter to carry one first.

**The RSC searchable path, run against the real Next.js application.** Next
ships **zero** client source maps by default, exactly as SvelteKit does. Without
them every component is found in the bundle and reported `compiled-only` — the
search succeeded, the file is unknowable, and the sentence says so. With
`productionBrowserSourceMaps: true` the same path resolves: the application's own
`CheckoutButton` to `app/components/CheckoutButton.tsx:5`, and Next's four client
boundaries to their files under `node_modules`, each correctly flagged
`dependency: true` so the noise is labelled rather than offered as the answer.
Names stay minified to single letters in both cases, because that is what the
build left; the files are right.

**Vue on webpack + `vue-loader`, which was the widest untested assumption.**
Every Vue result above came through `@vitejs/plugin-vue`, and `__file` and
`__name` injection are *that plugin's* behaviour rather than Vue's — so the
adapter's dev path and the survival of names through minification both rested on
one build tool. Measured on a real webpack 5 build: development keeps `__file`
and resolves all three components `via: debug-source`; production strips `__file`
exactly as Vite does, keeps `__name` for every component, and the bundle search
resolves `CheckoutButton.vue:6`, `CartPanel.vue:5` and `App.vue:5` — the same
answers, through terser output instead of esbuild's. Nothing needed changing.
The claim now rests on two build tools rather than one.

#### What is wired, and what the `[~]` still stands for

The chain named here in the previous revision is closed. A recording made on a
Vue, Svelte or Next.js page now carries that framework's components from the page
to the MCP server:

1. **The page agent runs all three adapters** on `click`, `input` and `change`,
   with a lifecycle of its own. That last part was the trap: `abandonReact`
   detaches React's listeners after three fruitless probes, which is exactly what
   happens on a Vue page — so anything hung off React's listener would have
   stopped working precisely on the pages the adapters exist for.
2. **Chains reach the step** as `ElementRef.frameworks`, buffered against the
   same `event.timeStamp` React's are, in a second buffer rather than a second
   field on the first — the two arrive from two listeners and either may be
   absent.
3. **The flow carries `vue`, `svelte` and `rsc`** as additive siblings of
   `react`, in the payload, in the JSON export, and in archived storage under one
   `savedFlowFrameworks_` key.
4. **The MCP server renders them** in `get_flow_step`, through the same
   `formatSource` it already uses — because the adapters produce
   `ComponentSource` rather than a shape of their own, which is the whole reason
   `core/locate/resolution.ts` exists. **No new tool.**

**The boxes stay `[~]`, and this is what they now stand for:**

- **All three have now been run against real applications**, and between them
  the three runs found six defects that every fixture had passed over. What
  remains untested is narrower and named: no Svelte 4 or legacy non-runes build,
  no webpack builder for Vue or Next, no server action or error path (which is
  the one production route `mcp-server/rsc.js` could actually serve), no
  client-side navigation, and no `{#each}`/`{#if}`/snippet constructs.
- ~~A `searchable` resolution is never resolved to a path.~~ **Done.** The same
  `resolvePending` React uses now runs for every framework with anything pending,
  and a production Vue recording resolves `CheckoutButton`, `CartPanel` and `App`
  to their own `.vue` files and lines — verified against a running application,
  not a fixture. Doing it found a defect in the shared engine: a bundle search
  returns a *function start*, a source map need not mark one, and looking it up
  as an ordinary position returned the previous file's segment — so every
  component named its child's file, confidently. `lookupFunctionStart` scans
  forward within the matched text instead. Svelte is unaffected, because its
  production build exposes no function to search for.
- ~~`mcp-server/rsc.js` has no caller.~~ **Wired.** Two call sites in
  `mcp-server/server.js`, both through an `rscTry` guard mirroring `git.js`, both
  inside answers that already existed — **no new tool.** A client component's
  `I`-row module id is joined to the element by matching its `id`/`data-*`
  against the flight tuple's props, `Resolution` carries it in one optional
  field, and the server maps it to a file through
  `page_client-reference-manifest.js`. Proven end to end by a test that drives a
  spawned MCP server against a real `.next/server` tree.

  **It is still reachable only when the server passes an `id` or `data-*` prop
  through to the client component**, and that limit is measured rather than
  assumed: the spike's own production payload is
  `["$","$L4",null,{"title":"Cart"}]`, and `title` is not an attribute the
  browser can match on, so that page gets nothing. There is no measured
  browser-side join for a client component whose props are all non-attribute —
  the fiber is anonymous and the chunk urls are shared.
- ~~The viewer does not show framework components.~~ **Done.** The review card
  falls back to the innermost component of the step's framework chain when no
  React component claimed it, through the same card and status words rather than
  a second renderer. No `within`, because no owner rule has been measured for
  these runtimes.
- ~~`VUE_MAX_VNODE_WALK` is a constant, not a setting.~~ **Measured, then made
  one.** Timed in a headed browser against real Vue 3 production builds at four
  sizes, with `__vueParentComponent` confirmed absent on every target:

  | app | DOM elements | vnodes visited | one walk |
  | --- | ---: | ---: | ---: |
  | 3 components | 13 | 8 | 0.0005 ms |
  | 500 components | 3,571 | 4,106 | 0.037 ms |
  | 2,000 components | 14,131 | 16,206 | 0.134 ms |
  | 8,000 components | 56,251 | 64,406 | 0.439 ms |

  Two facts neither of which was guessable. **The cost does not depend on where
  the click landed** — deepest-match-wins means the walk cannot stop at the first
  hit, so it drains the stack every time, and clicking the first card and the
  last card both visited 16,206 vnodes. And **time is not the binding
  constraint**: a flat ~8ns per vnode, so 20,000 costs ~0.16ms. The number is a
  *coverage* line — roughly 17,000 elements — not a time budget, which is the
  opposite of what its own comment used to imply.

  So 20,000 stands as the default and `vue.maxVNodeWalk` is now a settings row
  whose ceiling was raised to 1,000,000: a genuinely enormous page can spend
  ~8ms and get an answer. Threaded as a **getter**, not a number — `adapters()`
  is memoised and `applyConfig` lands after it, so a value captured at
  construction would have pinned the compiled-in default for the life of the
  page. That is a setting that saves, reloads and silently does nothing, and it
  is the bug the agent's own first mutation check failed to catch until it wrote
  a test that drives the real agent through a control push.

Angular is **not** a fourth adapter, and was removed rather than left listed.
ADR 0017's rule is that these are taken together or not at all; adding a fourth
raises the price of the only version of this work that may be started. Angular
shares neither React's fiber tree nor Vue's and Svelte's signal model, so it is a
fourth runtime to measure rather than a reuse of any of the first three, and
nobody has asked for it.

Server-side framework support — Node, Python, Go — is **not** here, because it
already works: §3.1's receiver takes OTLP/JSON from any exporter in any language.
It was listed in this phase until somebody checked.

### Removed from this phase

- [—] **Multi-Developer Session Intelligence** (Team ARKG, shared flow library) —
  **refused. ADR 0023.** Duplicated debugging is a real cost, but the ARKG holds
  observations and has never held a conclusion. Merging ten developers' graphs
  yields aggregate statistics about which components are seen most, not *"Alice
  found the root cause 20 minutes ago"*, and no amount of merging turns one into
  the other. Delivering that sentence needs people to write findings down, which
  is a wiki with a different data model — and the payload would be the most
  sensitive thing the system produces, recordings taken against developers' own
  environments, which today never leave the machine that made them.
- [—] **Counterfactual Replay Engine** — **refused. ADR 0024.** The question is
  usually answerable by recording the other branch, which yields a complete flow
  rather than a simulated one. Where the branch point genuinely cannot be reached
  again, the proposed mechanism fails: DevFlow's state snapshot is capped at depth
  6, 40 keys, 20 array entries and 200-character strings across at most 8 stores.
  Those caps are what make reading state cheap enough to do on every interaction.
  What they produce is a summary, and an application cannot be restored from a
  summary — while a run restored from a partial one would look, in the report,
  exactly like the real thing.
- [—] **Prop Drilling Eliminator** — **refused. ADR 0025.** Prop drilling is a
  syntactic property of the source; lint rules and codemods find it today, in the
  editor. Runtime observation adds only that the chain really mounts and how
  often, and DevFlow does not have even that cheaply: `memoizedProps` is read for
  reference identity in render blame, never by value. The half that would actually
  save work — generating the refactor — is ADR 0009, now refused three times.

---

## Production-Grade Non-Functional Requirements (NFRs)

This table used to carry eight rows. Four were performance numbers nobody ever
measured, and one was false: *"multi-tab recording isolation via Web Worker
buffers"* — there is no Web Worker anywhere in this extension. What
`src/features/react/providers/worker.ts` names is the MV3 **service** worker, and
what it isolates is bundle fetching, not tabs. A benchmark table with unmeasured
numbers in it is worse than no table, because the three real rows below stop being
readable as claims anybody checked.

A sixth row survived but had to be corrected, and it is the one worth naming:
*"zero PII leakage"* was not true and could not be. DevFlow redacts request headers,
password-field values and credential-bearing URL parameters — `src/core/redact/`
is specific about which — but a response body is captured as it arrived, and an
email address inside one is stored like any other byte. What is actually true is
weaker and more useful: nothing leaves the browser until somebody presses Send,
the dialog says what is about to go, and it goes to a server on loopback.

```
┌─────────────────────┬───────────────────────────────────────────────────────┐
│ Privacy             │ Local by default; credentials redacted; send dialog   │
│ Reliability         │ Graceful fallback when source maps are missing/broken │
│ ARKG Retention      │ Configurable; default 90 days of observations         │
└─────────────────────┴───────────────────────────────────────────────────────┘
```

Each of those three is enforced by something that runs: `src/core/redact/` and the
send dialog for the first, the two `BundleProvider` implementations and the
locator's four failure states for the second, and `pruneOldObservations` with
`DEVFLOW_ARKG_RETENTION_DAYS` for the third.

**What is not claimed here is the recording overhead**, and it is the number a
reader most wants. Pieces of it have been measured where a decision turned on
them — the accessibility walk at 4.9ms median over 2107 elements, which is why
`recording.a11y` ships off — but nothing has measured the whole recorder against a
real application, so no figure is offered. Putting one here would be inventing it.

---

## What NOT to Build (Strategic Distractions)

| Item | Reason to Avoid |
|---|---|
| ❌ React Native / Mobile | Hermes engine requires completely different instrumentation. Year 3 at earliest. |
| ❌ Custom DB agents (Tier 3) as a priority | OTel is the right answer. Custom agents violate Invariant 1. |
| ❌ Generic AI refactoring | Cursor/Claude Code own this. Only do refactoring where runtime data creates unique advantage. |
| ❌ LLM fine-tuning | Better MCP tools + ARKG context beats fine-tuning at current scale. |
| ⚠️ One framework adapter at a time | Each is a major investment. Deep React beat shallow multi-framework through Phase 4; Phase 5 takes all three or none — ADR 0017. |
| ❌ Team sync / shared graph | The graph holds observations, not conclusions — ADR 0023. |
| ❌ Counterfactual replay | The state snapshot is a summary by design and cannot re-seed a run — ADR 0024. |
