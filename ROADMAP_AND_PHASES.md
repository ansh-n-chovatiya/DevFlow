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
- [~] **Core Graph Schema:**
  - [x] Nodes: `components`, `api_endpoints`, `source_files`, `named_flows`
  - [x] Nodes: `state_keys` — one top-level key of one store, counting how often it was *changed* as well as how often it was seen. Keyed on the store's kind and label rather than its per-recording id, so one key is one node across recordings. `arkg_state_stores` beside it, so an edge has something to point at at the granularity it was observed.
  - [ ] Nodes: `git_commits` (needs Phase 3)
  - [x] Edges: `renders`, `calls`, `maps_to`
  - [x] Edges: `subscribes_to` — component → **store**, not component → key. `subscribers` is observed per store (a component is on the list because its own fiber carried the context dependency); crossing it with the store's keys would give a component that reads `state.cart` an edge to `state.auth`, indistinguishable in the graph from one somebody saw. The hop from store to key is left as a hop, because that is what it is.
  - [x] Edges: `caused_by` — **audited and ticked.** A causal link reaches the graph only when *both* ends project onto a node the ARKG already keys stably, and the projection is the whole of the claim: a step onto the component it was attributed to, a network event onto its `api_endpoint`, a state event onto its `state_store`. A console entry projects onto nothing — it has no stable identity across recordings — so every link ending on one is dropped rather than given a node invented to hold it, and `tests/arkg-causal.test.ts` asserts that against the real builder rather than a mock. Two further classes are refused: a self-loop where both ends land on one node, and the component ↔ endpoint pair, which is the `calls` edge drawn a second time out of the same fact. Nothing is a cross-product — `echoed` and `named` are gated on evidence per pair, `attributed` is one link per event from its own step. The audit did find one defect and it is fixed: the projection is many-to-one, so a response echoed into two keys of one store was counted as two observations of one edge, contradicting this file's own rule that `frequency` counts recordings. `ingestCausal` now dedupes per flow on the full edge identity, the way `ingestState` already did.
  - [ ] Edges: `changed_in` (needs Phase 3)
  - [x] Properties on every node/edge: `timing_p50`, `timing_p95`, `frequency`, `failure_rate`, `last_observed_at`
  - [ ] `git_sha` — columns exist and are always NULL; nothing writes them until Phase 3. The `state_keys` and `arkg_state_stores` tables deliberately have no `timing_p50`/`timing_p95` columns for the same reason: nothing times a state key, and a column that is always NULL is exactly what this line is complaining about.
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
- [ ] **Optional Compiler Plugin (`@devflow/compiler-plugin`) [Strictly Optional]:** not started.

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
- [~] **Non-Invasive State Store Interceptor:** Redux, TanStack Query and React Context are read in full; Zustand is read **only when the store is provided through a context**. A module-level `create()` store is not read, and the recording says so in as many words. It is reachable in principle — a consumer has a `useSyncExternalStore` hook holding a `getSnapshot` — but what comes back is that component's *selection*, not the store, and its only identity is a function reference that does not survive a reload. A `state_keys` node keyed on that accumulates one row per recording and answers nothing, which is the shape the `v3.2.0` audit deleted. It waits for a mechanism with a stable identity.
- [x] **Subscription Discovery** — from `fiber.dependencies.firstContext`, React's own record of what a component consumed. Being rendered underneath a provider is not reading it, is true of nearly every component in an app, and is never counted.
- [x] **RFC 6902 state deltas and `get_state_patch`,** moved here from Work Stream 1.5. The differ is pure and tested (`src/core/state/`); the budget question the deferral named is answered by **collapsing, never trimming** — an over-budget patch is re-cut at a shallower path so it stays applicable exactly, because a patch with operations removed no longer reconstructs the state and says nothing about it. The tool distinguishes "capture was off", "no store was recognised" and "no store moved", because those are three answers and only the last is about the application.

### Work Stream 1.3: Causal Threading in the Flow Recorder
- [x] **Causal DAG Construction** — `src/core/causal/index.ts`, pure and tested. **Derived from the recording, not stored**, and deliberately: every fact it uses is already in the flow, so a stored copy would be a second thing to keep in sync and would not exist on the recordings already on people's disks. Derived, every flow ever made gets the analysis and a rule improved later reaches all of them. That is why there is still no `causedBy` field in `src/shared/types.ts` and why its absence is not the gap it looks like — Work Stream 2.1's "all events carry `causedBy`" is a decision to *stamp* the derivation at capture time, which is a different item and stays open.
- [x] **Causal Query MCP Tools:** `get_causal_chain`, `get_effects_of` — the same graph walked in both directions, each link carrying the evidence it rests on. Four bases, **named rather than scored**: `echoed` (a value the response carried appears in what the store was written with), `named` (the log line contains the request's path), `attributed` (containment only — the recorder filed both under one step, and a poll on a timer lands there too), `followed` (ordering after a failed call, and nothing else). A number implies a precision this evidence does not have and cannot be argued with; a sentence naming what was seen can.

### Work Stream 1.4: The "Why Did This Render?" Engine
> Reverted in full. The `v3.2.0` attempt walked the entire fiber tree recursively
> on every commit, on every page, gated on nothing, and `postMessage`d per changed
> component — against the <2% CPU NFR — while computing only two reference-equality
> booleans and no actual blame. Nothing consumed the output.
- [ ] **Render Blame Evaluator:** prop keys with before/after, hook index + diff, parent-render vs context, fix suggestions
- [ ] **Render Performance Autopilot (Initial)**

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
  - [ ] DOM MutationObserver deltas and periodic layout snapshots. *The reverted attempt pushed every mutation on the whole document, unbounded and unthrottled, into an array with no cap — this needs a budget before it needs an implementation.*
  - [ ] All events carry `causedBy` references. **Unblocked** — 1.3 built the graph — but not built, and the item is now a narrower one than it was: the chain is *derived* at read time, so what is left is the decision to stamp it onto the events at capture. That is worth doing only if something needs it before the flow reaches a reader, and nothing does yet.
- [~] **Export to Resilient E2E Tests (Interaction-to-Test Compiler):**
  - [x] 1-click export of a recorded flow to Playwright and Cypress from the flow review screen.
  - [x] Resilient selector hierarchy: aria-label → role+name → text → CSS selector (flagged as fragile).
  - [x] Network mock fixtures injected from real intercepted request/response payloads.
  - [ ] State assertions from before/after store diffs. **Unblocked** — 1.2 now captures the diffs — but not built. The compiler would need to decide which of a patch's operations are worth asserting on, which is a question about a real app's patches and not one to answer from a fixture.

### Work Stream 2.2: "Why Is This Value Here?" Provenance Engine
- [ ] **Full Value Provenance Trace:** DOM text → React prop → component state → store selector → API response field
- [ ] **MCP Tool:** `get_value_provenance(domNodeId)`

### Work Stream 2.3: Autonomous Sandbox Execution Engine
- [ ] **Headless Replay Harness**
- [ ] **Synthetic Action Generator**

### Work Stream 2.4: Closed-Loop AI Code Repair Loop
- [ ] **Diagnostic Causal Tracing** (blocked on Work Stream 1.3)
- [ ] **Patch Generation & In-Memory Application**
- [ ] **Replay Verification & Test Runner**

### Work Stream 2.5: Natural Language Application Navigator
- [ ] **Feature Understanding Query**
- [ ] **MCP Tool:** `explain_feature(description)`

---

## Phase 3: Full-Stack Wire & Database Lineage (Months 7–9)
**Objective:** Connect frontend user interactions to backend endpoints, microservices, and database queries. Introduce the Living Architecture Map and Temporal Diff.

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
- [ ] **Cross-Deploy Flow Comparison:**
  - Compare two recordings of the same flow taken at different Git SHAs
  - Automatically identify what changed: new network requests, response shape changes, re-render count changes, state mutation sequence changes, visual layout shifts
- [ ] **"What Changed?" Incident Timeline:**
  - On detecting an incident (error spike, latency regression): construct deployment timeline, per-deployment change set, runtime diff, and causal hypothesis automatically
- [ ] **MCP Tool:**
  - `compare_flows_across_deploys(flowId, sha1, sha2)` → semantic diff of what changed between the two builds

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
