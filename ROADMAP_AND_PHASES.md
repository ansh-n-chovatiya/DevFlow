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
  - [ ] Nodes: `state_keys` (needs Work Stream 1.2), `git_commits` (needs Phase 3)
  - [x] Edges: `renders`, `calls`, `maps_to`
  - [ ] Edges: `subscribes_to` (needs 1.2), `changed_in` (needs Phase 3), `caused_by` (needs 1.3)
  - [x] Properties on every node/edge: `timing_p50`, `timing_p95`, `frequency`, `failure_rate`, `last_observed_at`
  - [ ] `git_sha` — columns exist and are always NULL; nothing writes them until Phase 3
- [x] **Observation Ingestion Pipeline:**
  - Every recorded flow writes to the ARKG automatically on completion.
  - Every component inspection writes a `maps_to` edge linking the DOM element → source file.
  - Merge strategy for duplicate observations: update `frequency` and `last_observed_at`, preserve `failure_rate`.
  - Re-sending one recording counts it once — `frequency` is an observation count, not a button-press count.
- [x] **Query Interface:**
  - `arkg.getComponent(id)` → full node with all edges
  - `arkg.getComponentHistory(id, since)` → all observations since a date
  - `arkg.getBlastRadius(sourceFile, lineRange)` → all components with runtime dependency on that range
- [~] **`arkg.getAnomalies(since)`** — ships as fixed thresholds (failure rate, p95/p50 spread), *not* the >2σ-from-baseline test this document specifies. Honest about what it measures; revisit once there is enough history for a real baseline.
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
> Reverted in full. The `v3.2.0` attempt fabricated `window.__REDUX_DEVTOOLS_EXTENSION__`
> as a non-callable object when the real extension was absent, which crashes the
> classic `__REDUX_DEVTOOLS_EXTENSION__ && __REDUX_DEVTOOLS_EXTENSION__()` store
> enhancer at boot — a violation of Invariant 1 on every page, recording or not.
> **Whatever replaces it must be inert when DevFlow is not recording.**
- [ ] **React DevTools Global Hook Reader**
- [ ] **Non-Invasive State Store Interceptor:** Zustand, Redux, TanStack Query, React Context
- [ ] **Subscription Discovery**
- [ ] **RFC 6902 state deltas and `get_state_patch`,** moved here from Work Stream 1.5. The differ and the tool are one deliverable with whatever captures the state, because what a patch has to decide — which subtrees are worth diffing at all, and how one is bounded to a token budget — is a question about the shape of what is captured, and there is no shape to answer it against until the three items above exist.

### Work Stream 1.3: Causal Threading in the Flow Recorder
- [ ] **Causal DAG Construction:** `causedBy` does not exist in `src/shared/types.ts`. Not started.
- [ ] **Causal Query MCP Tool:** `get_causal_chain`, `get_effects_of`

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
- [ ] `get_state_patch` (RFC 6902) — **deferred to Work Stream 1.2, deliberately.** `Step` has no state field and nothing captures one, so the tool would have nothing to read and the differ behind it would be a module in `src/core/` with no caller. That is the exact shape of what the `v3.2.0` audit deleted, and shipping it to tick a box is the habit that made the previous attempt worthless. RFC 6902 generation is well specified and does not depend on the state shape; what does depend on it is the part that matters here — which subtrees are worth diffing and how a patch is bounded to a token budget — and that cannot be designed against a shape that does not exist. Build it in 1.2, with the captured state in hand.

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
  - [ ] All events carry `causedBy` references (blocked on Work Stream 1.3).
- [~] **Export to Resilient E2E Tests (Interaction-to-Test Compiler):**
  - [x] 1-click export of a recorded flow to Playwright and Cypress from the flow review screen.
  - [x] Resilient selector hierarchy: aria-label → role+name → text → CSS selector (flagged as fragile).
  - [x] Network mock fixtures injected from real intercepted request/response payloads.
  - [ ] State assertions from before/after store diffs (blocked on Work Stream 1.2).

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
