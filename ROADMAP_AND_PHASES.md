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

## Phase 0: Accumulating Runtime Knowledge Graph Foundation (Months 0–1)
**Objective:** Lay the foundational data layer that every subsequent feature is built upon. The ARKG is DevFlow's deepest competitive moat and must be designed correctly from the start.

### Work Stream 0.1: ARKG Schema Design & SQLite Implementation
- [x] **Core Graph Schema:**
  - Nodes: `components`, `state_keys`, `api_endpoints`, `source_files`, `git_commits`, `named_flows`
  - Edges: `renders`, `subscribes_to`, `calls`, `maps_to`, `changed_in`, `caused_by`
  - Properties on every node/edge: `timing_p50`, `timing_p95`, `frequency`, `failure_rate`, `last_observed_at`, `git_sha`
- [x] **Observation Ingestion Pipeline:**
  - Every recorded flow writes to the ARKG automatically on completion.
  - Every component inspection writes a `maps_to` edge linking the DOM element → source file.
  - Merge strategy for duplicate observations: update `frequency` and `last_observed_at`, preserve `failure_rate`.
- [x] **Query Interface:**
  - `arkg.getComponent(id)` → full node with all edges
  - `arkg.getComponentHistory(id, since)` → all observations since a date/git SHA
  - `arkg.getAnomalies(since)` → components/endpoints whose timing deviates >2σ from historical baseline
  - `arkg.getBlastRadius(sourceFile, lineRange)` → all components with runtime dependency on that range
- [x] **MCP Tools for ARKG:**
  - `get_app_architecture` → compact graph summary of all observed components and their relationships
  - `get_component_history(componentId)` → timing, failure rate, and change history from the ARKG
  - `get_anomalies(since)` → components/endpoints deviating from baseline

---

## Phase 1: Core Runtime-to-Source Intelligence (Months 1–3)
**Objective:** Evolve DevFlow from basic element picking into a standalone, token-efficient data-lineage and render causality inspector with **zero app modifications**, while feeding all observations into the ARKG.

### Work Stream 1.1: 100% Standalone Runtime Source Mapping
- [ ] **Pure Client-Side Source Map Engine (Zero App Config):**
  - Parse inline/external source maps directly in the browser/service worker.
  - Traverse React Fiber `_debugSource`, `_debugOwner`, and function constructors back to original `src/` file, line, and column.
  - Zero requirement for users to install npm packages or alter Vite/Webpack/Turbopack configs.
  - Every attribution carries a confidence score: HIGH (debugSource match) / MEDIUM (source map match) / LOW (heuristic match), with a specific reason for the score.
- [ ] **Fallback Chain:**
  - `_debugSource` Fiber field → external source map → inline base64 source map → function constructor name heuristic → component display name + AST fuzzy search
- [ ] **Optional Compiler Plugin (`@devflow/compiler-plugin`) [Strictly Optional]:**
  - Optional development helper for complex monorepos with obfuscated dev builds.
  - Injects guaranteed-reliable source metadata as data attributes. Never required for core functionality.

### Work Stream 1.2: Deep React Fiber & State Store Inspection (Non-Invasive)
- [ ] **React DevTools Global Hook Reader:**
  - Read React internals safely via `window.__REACT_DEVTOOLS_GLOBAL_HOOK__` and Fiber nodes (`memoizedProps`, `memoizedState`, hook linked lists).
  - Inspect React 18 & 19 concurrent features and Signals without wrapping component code.
- [ ] **Non-Invasive State Store Interceptor:**
  - Auto-discover Zustand, Redux DevTools extension instances, TanStack Query client caches, and React Context from `window` or Fiber roots.
  - Track state mutations using lightweight proxies without importing external libraries into the target app.
  - **Subscription Discovery:** Walk the Fiber tree on a state change event, comparing `memoizedState` values to identify subscribers without instrumentation.

### Work Stream 1.3: Causal Threading in the Flow Recorder
- [ ] **Causal DAG Construction:**
  - Every recorded event carries a `causedBy` reference to the event that triggered it.
  - Example chain: user click → `cartState` mutation → `CartBadge` re-render → `GET /api/cart` fetch → `CartDrawer` mount
  - Store the causal DAG as edges in the ARKG under the `caused_by` edge type.
- [ ] **Causal Query MCP Tool:**
  - `get_causal_chain(eventId)` → returns the full forward and backward causal chain from any recorded event
  - `get_effects_of(stepId)` → returns everything that was ultimately caused by a user action at a given step

### Work Stream 1.4: The "Why Did This Render?" Engine
- [ ] **Render Blame Evaluator:**
  - Perform shallow & deep equality diffs across render passes.
  - Categorize causes:
    - *Props Changed:* specific prop keys with before/after values.
    - *Hook State Changed:* hook index and state diff.
    - *Parent Re-render:* parent component triggered render without memoization.
    - *Context Mutation:* context value reference changed.
  - Auto-suggest fixes: `useCallback`, `useMemo`, `React.memo` with measured re-render frequency from ARKG.
- [ ] **Render Performance Autopilot (Initial):**
  - Detect unstable inline callbacks (compare `onClick` identity across renders)
  - Detect missing `React.memo` (count unnecessary child re-renders)
  - Each finding: source line link + before/after code suggestion + measured impact

### Work Stream 1.5: High-Density Token-Efficient MCP Interface
- [ ] **Hierarchical Context Delivery for LLMs:**
  - `get_flow_summary`: Returns a compact, token-dense triage summary (< 400 tokens) with error highlights and step counts.
  - `get_step_detail(stepId)`: Returns exact data only for the requested step on demand.
  - `get_state_patch(stepId)`: Returns RFC 6902 JSON Patch state deltas instead of megabytes of raw store data.
  - `get_source_snippet(filePath, line, radius)`: Pulls a concise ±10 line window around the component rather than entire files.
  - `get_causal_chain(eventId)`: Returns the causal DAG upstream and downstream of any event.
  - **Out-of-band Screenshots:** Screenshots are written to `~/.devflow/flows/<id>/` and referenced via local paths.

---

## Phase 2: Autonomous Bug Reproduction, Remediation & Natural Language Intelligence (Months 4–6)
**Objective:** Closed-loop automated debugging from issue description to verified PR, plus natural language application understanding powered by the ARKG.

### Work Stream 2.1: Deterministic Time-Travel Flow Recorder 2.0
- [ ] **Unified Event Chronicle:**
  - High-precision timestamped stream of user events (click, input, scroll, keydown).
  - Synchronized network requests (`fetch`/`XHR`/`WebSocket`) with request/response payloads.
  - Synchronized console output, warnings, uncaught exceptions, and unhandled promise rejections.
  - DOM MutationObserver deltas and periodic layout snapshots.
  - All events carry `causedBy` references (causal threading from Phase 1).
- [ ] **Export to Resilient E2E Tests (Interaction-to-Test Compiler):**
  - 1-click export of recorded flows to Playwright and Cypress test scripts.
  - **Fiber-based resilient selectors** (not CSS selectors): aria-label → role+name → data-testid → component name → CSS selector (flagged as fragile)
  - Automatic injection of real network mock fixtures from intercepted request/response payloads.
  - State assertions from before/after store diffs recorded during the flow.

### Work Stream 2.2: "Why Is This Value Here?" Provenance Engine
- [ ] **Full Value Provenance Trace:**
  - Click any visible value in the browser (a price, a username, an error message)
  - Trace the full provenance chain: DOM text → React prop → component state → store selector → API response field
  - Present as an interactive, expandable lineage tree
- [ ] **MCP Tool:**
  - `get_value_provenance(domNodeId)` → full lineage chain from DOM to origin

### Work Stream 2.3: Autonomous Sandbox Execution Engine
- [ ] **Headless Replay Harness:**
  - Run recorded flows inside containerized Chrome via Chrome DevTools Protocol (CDP) and Playwright.
  - Re-inject recorded cookies, `localStorage`, and session tokens for state fidelity.
- [ ] **Synthetic Action Generator:**
  - Parse fuzzy user reports (e.g., *"Filter by Electronics then click Sort by Price breaks table"*) into structured replay steps.
  - Use vision-model heuristics + ARKG component graph to identify the most likely target elements.

### Work Stream 2.4: Closed-Loop AI Code Repair Loop
- [ ] **Diagnostic Causal Tracing:**
  - Map crash/error stack trace → failing event handler → state mutator → AST node (using causal DAG from Phase 1).
- [ ] **Patch Generation & In-Memory Application:**
  - Generate targeted unified diffs via AST transforms.
  - Apply diffs in ephemeral branch/sandbox.
- [ ] **Replay Verification & Test Runner:**
  - Re-execute the recorded interaction in the sandbox.
  - Verify error absence and check unit/E2E test suite status.
  - Generate PR with root cause summary and visual before/after verification recording.

### Work Stream 2.5: Natural Language Application Navigator
- [ ] **Feature Understanding Query:**
  - Developer types: *"How does the discount code get applied?"*
  - DevFlow queries ARKG component graph + code embeddings to identify related components/routes
  - Traces the implementation path in the ARKG: `DiscountInput` → `usePromoCode` → `POST /api/promo/validate`
  - Navigates the browser to trigger the feature, recording the runtime trace
  - Generates a narrative explanation with source links and a visual flow diagram
- [ ] **MCP Tool:**
  - `explain_feature(description)` → ARKG-guided implementation trace + narrative

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
