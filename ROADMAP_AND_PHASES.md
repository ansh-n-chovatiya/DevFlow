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
│ ARKG Schema  │Runtime-to-   │ Autonomous   │ Full-Stack   │ Production │ Ambient     │
│ Foundation   │Source Intel  │ Bug Agent &  │ Wire &       │ & Self-    │ Intelligence│
│ (Months 0–1) │ (Months 1–3) │ NL Navigator │ DB Lineage   │Healing CI  │ & Platform  │
│              │              │ (Months 4–6) │ (Months 7–9) │(Mo. 10–12) │ (Year 2+)   │
└──────────────┴──────────────┴──────────────┴──────────────┴────────────┴─────────────┘
```

---

## Status key

`[x]` shipped, on `main`, covered by tests that run in `npm run verify`.
`[~]` partially shipped — the sub-bullets say which half.
`[ ]` not started.

A box is ticked when the gate proves it, not when a file exists. The Phase 0–2
work first attempted in `v3.2.0` was reverted in full: `main` was reset to
`v3.1.1` after an audit found the MCP server would not boot, `typecheck` and 29
tests were red, and most ticked items were stubs. That work is preserved on the
`archive/antygravity-phase-0-2` branch and tag `archive/v3.2.0-antygravity`.
Nothing below is ticked on the strength of that branch.

---

## Phase 0: Accumulating Runtime Knowledge Graph Foundation (Months 0–1)
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

## Phase 1: Core Runtime-to-Source Intelligence (Months 1–3)
**Objective:** Evolve DevFlow from basic element picking into a standalone, token-efficient data-lineage and render causality inspector with **zero app modifications**, while feeding all observations into the ARKG.

### Work Stream 1.1: 100% Standalone Runtime Source Mapping
- [x] **Pure Client-Side Source Map Engine (Zero App Config):** — this is the shipped locator, and predates the ARKG work.
  - Parse inline/external source maps directly in the browser/service worker.
  - Traverse React Fiber back to original `src/` file, line, and column.
  - Zero requirement for users to install npm packages or alter build configs.
  - Every attribution carries a confidence score with a specific reason (`src/features/react/resolver.ts`).
- [x] **Fallback Chain:** source map → inline base64 source map → heuristics, each with its own reported failure mode.
- [x] **Optional Compiler Plugin (`@devflow/compiler-plugin`) [Strictly Optional]:** built, and built against the objection rather than into it. Invariant 1 is that DevFlow needs no app changes, and a plugin is a change to the app's build. The risk was never that it would not work — it is that it would work *better*, and a plugin that becomes the path where attribution is reliable has made the zero-dependency path the degraded one, which is the invariant lost without anyone deciding to lose it. So the rule below was written before the first line of plugin code and shipped in the same commit as it.

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
- [~] **Non-Invasive State Store Interceptor:** Redux, TanStack Query and React Context are read in full; Zustand is read **only when the store is provided through a context**. **The module-level `create()` store is refused, and this is a decision rather than an omission.** It was carried as "deferred on a condition — it waits for a mechanism with a stable identity", which is not the same thing as a decision; the condition has now been examined against real React and real Zustand rather than argued from the shape of the problem, and the answer is that it cannot be met by reading fibers.

  **What was actually measured.** React 19.2.8, Zustand 4.5.7 and 5.0.15, three consumers of one module-level store — one selecting `items.length`, one selecting `total`, one selecting nothing and therefore holding the whole state. Walking the consumers' hook lists:

  1. The `useSyncExternalStore` hook's `queue` is `{ value, getSnapshot }`, and `getSnapshot` is **not** `api.getState` in either major version. It is the closure Zustand builds per consumer, so calling it returns that component's *selection*.
  2. The **next** hook in the chain is the effect `useSyncExternalStore` mounts, and its `deps` array is `[api.subscribe]` — the store's own function, **identical by reference across all three consumers**. So consumers of one store *can* be grouped, which the previous sentence ("its only identity is a function reference") had wrong in a way that mattered: the reference is not merely an identity, it is a correct one, within a page.
  3. Zustand 4 additionally leaks `api.getState` through the `use-sync-external-store` shim's `useMemo` deps. Zustand 5 does not, and 5 is the current major. A path that works on one major and silently reads nothing on the next is not a mechanism; and reaching it means calling a bare closure found in a fiber, with no method shape to recognise it by first — which is the one thing `classify` never does, because every store it reads it recognised before it called anything on it.

  **Why grouping is not enough, which is the argument that decides it.** Even with every consumer of a store correctly grouped, what can be read is the union of the *selections* of whichever components happened to be mounted. That set is a fact about the route the recording visited, not about the store. Two consequences, and each is on its own disqualifying:

  - **The value would be wrong, not merely partial.** A selection disappears from the union when its component unmounts, so the state differ would emit a `remove` for a key the store never touched — a fabricated state change, in the one part of the recording whose whole claim is that it computes nothing and only reports what it saw.
  - **The label would not survive a reload.** `labelFor` falls back to the store's *shape*, its sorted top-level keys, precisely because that is stable across recordings. A union of selections is not: a recording on the cart page and a recording on the settings page yield different shapes for the same store, so a `state_keys` node keyed on it accumulates one row per recording and answers nothing. That is the shape the `v3.2.0` audit deleted.

  **What would overturn this**, stated so the next attempt does not have to rediscover it: a mechanism that yields the store *object* — something with `getState` on it, recognisable by its methods before anything is called — not a per-consumer snapshot. Reading fibers does not produce one on Zustand 5. Subscribing would, and subscribing is writing to the page, which `src/injected/state.ts` refuses for the reason its header gives. So this is refused on the evidence rather than parked, and the recording continues to say the gap exists in as many words (`stateNote`). `tests/state-reader.test.ts` now carries the shape as a fixture and asserts it yields no store, so reversing this is a deliberate act with a test to update rather than a drift.
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

## Phase 2: Autonomous Bug Reproduction, Remediation & Natural Language Intelligence (Months 4–6)
**Objective:** Closed-loop automated debugging from issue description to verified PR, plus natural language application understanding powered by the ARKG.

> Every item below was ticked in `v3.2.0` and none of it survived audit. The
> provenance engine was unreachable dead code; the synthetic action generator
> returned hardcoded buttons and ignored its ARKG argument; the navigator was a
> stopword-matching substring filter; the patch generator was a hardcoded fake
> diff in a file that did not parse. Re-planned honestly below.

### Work Stream 2.1: Deterministic Time-Travel Flow Recorder 2.0
- [~] **Unified Event Chronicle:**
  - [x] Timestamped user events (click, input, navigate), network with request/response payloads, console output and uncaught exceptions — all attributed to the step that caused them.
  - [~] DOM MutationObserver deltas **shipped**; periodic layout snapshots **refused, with the reason below.**
    - **The deltas.** A `MutationObserver` watches the whole document for the length of each step and the step carries a folded summary of what appeared, went, or was rewritten. It is a **different observation from `StepBase.domDelta`**, not a bigger one, and the two are deliberately kept apart: `domDelta` reads the *text* of *one region* — the container around the element that was touched — before and after; `domChanges` reads the *structure* of the *whole document* over the same window. A click that opens an error banner in the page header produces nothing in the first and one entry in the second; a button whose label became "Saving…" produces the reverse. Neither is derivable from the other, so neither replaced the other.
    - **The budget, which was designed before the implementation.** *Observed:* every `childList`, `attributes` and `characterData` mutation under `documentElement`, for a window that opens when the step is **written** and closes `recording.domDeltaMs` later or when the next element step is written, whichever is sooner. For a click those two moments are the same; for typing they are not, because the recorder commits a whole field as one step after `recording.inputDebounceMs` of quiet — so a typed step's window starts once the typing stopped and catches what the finished field caused rather than what each keystroke did. `domDelta` has read its region on that same schedule since it shipped, and this shares it rather than defining a second "settled". The one-window rule is unconditional; "closed by the next interaction" is not — a navigation and a synthesised note are not element steps and do not close an open window. A mutation still belongs to exactly one step; that step is the last element step before it. *Dropped before it costs anything:* DevFlow's own DOM, refused by the `devflow-` id prefix, because the recording indicator is removed and re-added around every screenshot and would otherwise open every step of every flow with a div appearing and going in `<body>`; `<style>`, `<script>`, `<link>`, `<meta>` and `<template>` — refused on the *target* of a record as well as on nodes that come and go, because a `<style>` appended once and then written through is what Vite's HMR and styled-components in development do, and it arrives as `characterData` on a node the added/removed filter never sees; whitespace-only text; and comment nodes. *Two caps, because there are two costs:* `recording.domMutationCap` (400) bounds the **work** and is enforced in the observer's own callback before each record, which then **disconnects** — so a page running a transition at sixty frames a second costs a step the cap and not a second of records; `recording.domMaxChanges` (12) bounds the **recording** and is enforced after folding, where a hundred appended rows are one entry with a count of a hundred. A single number could not do both: low enough to keep a step readable it would stop watching after a dozen records, high enough to watch a real interaction it would print four hundred lines. *What the recording says when a cap bites:* the work cap sets `StepDomChanges.capped`, which `get_step_detail` prints last so it qualifies the list above it and says in as many words that it is not a claim that nothing else changed; the recording cap sets `more`, a different fact — those were seen and did not fit. *What survives the recording cap:* structural change, then text, then attributes, and `style` last of all, first-seen order inside each rank. **The cut happens before the describing, not after it** — a group is ranked on what it already knows, and only the survivors are handed to `generateSelector`. Describing all four hundred groups and then keeping twelve built four hundred `querySelectorAll` passes and threw away three hundred and eighty-eight of them, synchronously inside the user's next click; that is the cost profile the reverted attempt was reverted for, relocated one function along, and an adversarial review of this work stream found it. Never by count: the dialog that mounted is one record and the CSS transition behind it is sixty, so any ordering by how often something changed spends the whole budget on the transition — the same trap `core/render/blame.ts` documents for wasted renders, one tree over.
    - Read through `get_step_detail`'s `dom` part, which now carries both observations and prices them as one. `core/dom/observe.ts` folds and describes, `core/dom/changes.ts` spends the budget, and `content/index.ts` owns only the lifecycle — the split `injected/render.ts` and `core/render/blame.ts` already make. `tests/dom-changes.test.ts` drives the collector with a **real** `MutationObserver` over a real jsdom document rather than hand-written record objects, because a hand-written record is a fixture of what the author believes `MutationRecord` is.
    - **Periodic layout snapshots are not built, and this is not a partial delivery of them.** A timer that reads layout forces a synchronous reflow on every tick on every recorded page whether or not anything moved, which is the cost profile the v3.2.0 render attempt was reverted for, moved from the fiber tree to the layout tree. And a snapshot taken *between* steps belongs to no step: the schema has nowhere to put it, and giving it one means a flow-level timeline of layouts, which is a time-travel *player* and a different feature from a field on a step. What a layout snapshot taken *at* a step would answer is already answered twice — the screenshot is the layout, and `ElementRef.boundingBox` is where the interaction landed. Building it would need a mechanism that reads layout off the browser's own pass rather than forcing one (`ResizeObserver`, `IntersectionObserver`) and a schema decision about where a between-steps observation lives. Neither is started.
  - [ ] All events carry `causedBy` references. **Deliberately not built, and this line is the decision rather than a gap.** 1.3 built the graph and derives it at read time from facts the flow already carries — the recorder's attribution of a call to a step, the text of a log line, the body of a response, the values a patch wrote. Stamping the derivation onto the events at capture would be a second copy of those facts to keep in sync, it would be absent from every recording already on somebody's disk, and it would freeze today's rules into flows that a sharpened rule should reach next month. The one thing that would justify it is something needing the chain *before* the flow reaches a reader, and after this work stream nothing does: the DOM summary added above is new evidence a future basis in `core/causal/index.ts` could read, which is an improvement to the derivation and not an argument for a stamp. Left open rather than struck out, because the day something in the extension needs a chain it cannot derive, this is the item that answers it.
- [~] **Export to Resilient E2E Tests (Interaction-to-Test Compiler):**
  - [x] 1-click export of a recorded flow to Playwright and Cypress from the flow review screen.
  - [x] Resilient selector hierarchy: aria-label → role+name → text → CSS selector (flagged as fragile).
  - [x] Network mock fixtures injected from real intercepted request/response payloads.
  - [~] State assertions from before/after store diffs. **The observation ships; the assertion is refused, with the reason in `src/core/export/state.ts` and in the generated file itself.** An exported spec now carries what the app's stores did beside the step that did it — the store, the operations in the differ's own path order, and both of the flags that change what a patch means (`bounded`, so a path that is absent may have changed below the snapshot cut, and `collapsed`, so the operations are coarser than the ones the app made). It is written as comments, once explained per file.
    - **Why not an assertion.** DevFlow reads a store by walking React's fiber tree from inside the page. A test runner has no handle on that. Playwright *could* run the same walk through `page.evaluate`, and that is precisely what must not be generated: a few hundred lines of React-internals code pasted into a file the developer owns, frozen at the React version current the day the flow was exported, whose failure mode is a red suite reporting a bug in the application that is not there. An assertion that can be wrong about the thing it asserts is worse than no assertion, because the response to a red test is to go and look at the app. The developer's own store *is* reachable to them, by whatever handle they choose to expose — and choosing it is an app change, which is Invariant 1's whole point.
    - **The open question this narrows.** "Which of a patch's operations are worth asserting on" is still not answered and still cannot be answered from a fixture — so nothing here ranks them. The operations are printed in the differ's order, which is path order, because a reader scanning for a path they recognise is best served by an order they can predict, and a compiler that guessed would bury the operation they came for under one it chose. Capped at six per store, with the count of what was not printed and the name of the tool that has all of it.

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
- [~] **Patch Generation & In-Memory Application** — **refused, and the reasoning is architectural rather than about effort.**
  - DevFlow is not a model and cannot write a patch. The caller is — Claude Code, reading `diagnose_failure`, `get_source_snippet`, `get_value_provenance` and `get_causal_chain` — and everything that call needs is now in place. A "patch generator" inside this server could only be a template, and the `v3.2.0` version of this bullet was exactly that: a hardcoded fake diff in a file that did not parse.
  - "In-memory application" has no honest form either. The application under test is served by the user's own dev server; nothing here can substitute a module into it, and a version that wrote to the working tree and called it in-memory would be editing somebody's repository from a tool call while saying it had not.
  - So DevFlow's half of the loop is **diagnosis and verification**, and both halves ship. The patch belongs to whoever can write one.
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

## Phase 3: Full-Stack Wire & Database Lineage (Months 7–9)
**Objective:** Connect frontend user interactions to backend endpoints, microservices, and database queries. Introduce the Living Architecture Map and Temporal Diff.

> **Where this phase stands: 3.4 is shipped and the other four are not started.**
> 3.4 went first because it needed only the commit stamp and `compare_flows`,
> both one step away, and because it closed the three Phase 0 items — `git_sha`,
> `git_commits` and `changed_in` — on the way rather than as an errand
> afterwards. Nothing below it is blocked by anything above it.
>
> **3.1 is next and its header injection is the first change DevFlow would make
> to what a recorded app sends its own backend.** Everything shipped so far
> observes. The hazard is concrete rather than theoretical: a custom header on a
> **cross-origin** request makes it non-simple, so the browser sends an `OPTIONS`
> preflight where it sent none, and a backend that does not name the header in
> `Access-Control-Allow-Headers` **fails the request** — a working page broken by
> DevFlow being installed, which is Invariant 1 and is exactly what got `v3.2.0`
> reverted in a different subsystem. Note also that `traceparent` is a *standard*
> header a backend may already accept and `X-DevFlow-Trace-Id` is bespoke; they
> do not carry the same risk and must not be decided as one switch. The argument
> belongs on the record before the first line of code, the way §1.1's rule was.
>
> **3.5 is out of scope as a unit and should be planned as three.** Vue 3,
> Svelte 5 and React Server Components do not share React's fiber tree and
> nothing in `src/core/react/` transfers, so each adapter is a Phase-1-sized body
> of work. Starting one and leaving two would be worse than starting none.

### Work Stream 3.1: Distributed Trace Correlation
- [ ] **Causality Trace Header Injection:**
  - Runtime injector automatically adds `X-DevFlow-Trace-Id` and `traceparent` headers to all outbound requests.
- [ ] **OpenTelemetry (OTel) Collector Integration (Tier 2):**
  - Ingest backend spans from Express, NestJS, FastAPI, Go Gin, and Spring Boot.
  - Link frontend interaction ID → HTTP Request → Controller Span → DB Query Span.
  - Store all backend span data as edges in the ARKG under the `calls` edge type.
- [ ] **Tier Model Enforcement:**
  - Tier 1 (default, zero backend effort): FE-only correlation, response body, error detection, latency
  - Tier 2 (OTel SDK, one package): full FE → BE → service span correlation
  - Tier 3 (enterprise): automatic SQL query capture (never prioritized over Tiers 1 & 2)

### Work Stream 3.2: End-to-End Data Lineage Engine
- [ ] **Wire-to-Database Inspector:**
  - When inspecting a UI value (e.g., table cell displaying `$120.00`), DevFlow reveals:
    - Frontend Component: `InvoiceRow.tsx:18`
    - API Endpoint: `GET /api/v1/invoices`
    - Controller Handler: `invoice_controller.py:45`
    - Database Query: `SELECT total_amount FROM invoices WHERE id = ?`
- [ ] **MCP Tool:**
  - `get_full_lineage(domNodeId)` → full FE → BE → DB lineage chain for any visible value

### Work Stream 3.3: Living Architecture Map
- [ ] **Real-Time Component Graph:**
  - Continuously observe the running app and display an up-to-date architecture map
  - Which components are currently mounted, subscribed state stores, active API calls
  - Updates in real-time as the developer navigates the app
- [ ] **Interactive Graph Queries:**
  - *"Show me everything that renders when I click checkout"* → animated real-time graph
  - *"Which components depend on `cartState`?"* → highlighted graph with source links
- [ ] **MCP Tool:**
  - `get_living_architecture()` → current snapshot of the full component/state/API graph

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
- [ ] **Vue 3 / Nuxt Adapter:** Reactivity Proxy and template AST mapper.
- [ ] **Svelte 5 / SvelteKit Adapter:** Runes & Signals inspector.
- [ ] **Next.js App Router & Server Components:** Trace across RSC wire protocol and Client Components.

---

## Phase 4: Production Telemetry & Self-Healing CI/CD (Months 10–12)
**Objective:** Continuous production error reproduction, regression detection, autonomous remediation, and CI/CD integration.

### Work Stream 4.1: Production Telemetry & Incident Ingestion
- [ ] **Sentry, Datadog & Bugsnag Webhook Ingestion:**
  - Automatically parse production crash events into reproduction candidates.
  - Match stack traces against exact Git commit SHAs using published source maps.
  - Populate the ARKG with production-observed failure rates for all affected components.
- [ ] **Session Replay Ingestion (PostHog / LogRocket / FullStory):**
  - Convert customer session recording events into headless Playwright reproduction scripts.
  - Re-inject production network responses as mocks from HAR archives (Production Time Capsule).

### Work Stream 4.2: Source → Browser Live Link (IDE Integration)
- [ ] **VS Code Extension:**
  - Sends cursor position → DevFlow local MCP server → maps to component ID → Chrome extension highlights the live DOM element
  - Hover over a JSX line → all live instances highlighted in the running browser
  - Hover over a state store key → all currently subscribed components highlighted
  - Hover over an API call → last N real network payloads shown inline
- [ ] **Live Blast-Radius Preview:**
  - Before committing: *"This change to `useCartStore.ts:42` currently affects 7 rendered components and 3 active API calls"*
  - Powered by ARKG runtime dependency graph, not static AST analysis

### Work Stream 4.3: Git Forensics & Blame Intelligence
- [ ] **Regression Bisect Engine:**
  - Correlate runtime error sites with recent Git commits, PR descriptions, and author context.
  - Determine exact commit and PR that introduced the bug using ARKG's `changed_in` edge history.
- [ ] **Automated Commit Attribution:**
  - When an error is detected in the ARKG, automatically query: which file, which function, which commit last touched that code, and who authored it.

### Work Stream 4.4: Autonomous Regression Watcher (CI Integration)
- [ ] **Semantic CI Integration:**
  - On every PR, re-run all recorded "known-good" flows in a headless sandbox
  - Generate semantic diffs: not just pass/fail but *what changed* (re-render counts, API latency, state sequence)
  - Post PR comment with: what worked, what regressed, which specific file changes in this PR likely caused it
- [ ] **GitHub Actions Integration:**
  - `devflow-regression-check` action: runs flows, posts semantic diff as PR comment

### Work Stream 4.5: Self-Healing Ephemeral Environments
- [ ] **Automated CI/CD Fix Bot:**
  - When CI fails on an E2E or unit test, DevFlow captures the runtime trace, isolates the root cause via ARKG causal graph, applies a candidate fix, verifies it in sandbox, and comments on the PR with the proposed patch.

### Work Stream 4.6: Accessibility Autopilot
- [ ] **Dynamic A11y Auditing:**
  - Continuously audit the live DOM during recorded flows: focus trap correctness, ARIA attribute consistency with rendered state, color contrast with actual computed styles, keyboard navigation completeness
  - Link every violation to the exact JSX source line and generate a targeted fix
  - Catches dynamic violations that static linters cannot (e.g., modal that breaks focus on close)

---

## Phase 5: Ambient Intelligence & Platform (Year 2+)
**Objective:** Evolve DevFlow from a per-developer tool into an ambient intelligence layer shared across the entire team, with multi-framework support and moonshot capabilities.

### Work Stream 5.1: Multi-Developer Session Intelligence
- [ ] **Team ARKG:**
  - Merge ARKG data across developers on the same team (opt-in, local network sync or cloud)
  - Detect when two developers are debugging the same broken component simultaneously
  - Surface shared institutional knowledge: *"Alice found the root cause of this 20 minutes ago"*
- [ ] **Shared Flow Library:**
  - "Known broken flows" become team-wide knowledge
  - "Explained flows" (annotated by senior engineers) become onboarding material

### Work Stream 5.2: Counterfactual Replay Engine (Moonshot)
- [ ] **State Branching Replay:**
  - Fork the recorded state at any step, inject a different event, and continue replaying in a sandbox
  - Practical implementation: re-seed a headless Playwright session with the logical state snapshot at the fork point
  - Answers: *"What would have happened if the user had clicked 'Pay Now' instead of 'Save for Later' at step 7?"*

### Work Stream 5.3: Prop Drilling Eliminator
- [ ] **Runtime-Observed Refactoring:**
  - Identify prop-drilled chains from runtime observation (not just static analysis)
  - Propose concrete refactors: *"Move `userId` to UserContext — it's prop-drilled through 6 layers. Here are the 8 affected files."*
  - Auto-generate the refactoring code change with live blast-radius analysis

### Work Stream 5.4: Expanded Framework Support
- [ ] **Vue 3 Deep Integration:** Full Reactivity Proxy inspector, template AST mapper, devtools hook
- [ ] **Svelte 5 Deep Integration:** Full Runes & Signals state inspector
- [ ] **Angular Support:** Component tree inspector via Angular DevTools hook
- [ ] **Server-Side Framework Support:** Node.js, Python FastAPI, Go Gin via OTel (no browser instrumentation needed)

---

## Production-Grade Non-Functional Requirements (NFRs)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                     PRODUCTION-GRADE BENCHMARKS                             │
├─────────────────────┬───────────────────────────────────────────────────────┤
│ Performance Impact  │ < 2% CPU overhead, < 15MB heap usage during recording │
│ Latency             │ < 50ms element inspection & AST resolution time       │
│ ARKG Write Latency  │ < 5ms per observation write to SQLite ARKG            │
│ ARKG Query Latency  │ < 100ms for any ARKG graph query                      │
│ Privacy & Security  │ Zero PII leakage; configurable client-side masking    │
│ Reliability         │ Graceful fallback when source maps are missing/broken │
│ Concurrency         │ Multi-tab recording isolation via Web Worker buffers  │
│ ARKG Retention      │ Configurable; default 90 days of observations         │
└─────────────────────┴───────────────────────────────────────────────────────┘
```

---

## What NOT to Build (Strategic Distractions)

| Item | Reason to Avoid |
|---|---|
| ❌ React Native / Mobile | Hermes engine requires completely different instrumentation. Year 3 at earliest. |
| ❌ Custom DB agents (Tier 3) as a priority | OTel is the right answer. Custom agents violate Invariant 1. |
| ❌ Generic AI refactoring | Cursor/Claude Code own this. Only do refactoring where runtime data creates unique advantage. |
| ❌ LLM fine-tuning | Better MCP tools + ARKG context beats fine-tuning at current scale. |
| ⚠️ Vue/Svelte before Phase 3 | Each adapter is a major investment. Deep React beats shallow multi-framework. |
