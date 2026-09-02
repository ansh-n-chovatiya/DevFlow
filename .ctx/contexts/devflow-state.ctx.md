---
ctx_bundle: 1
name: devflow-state
scope: project
created: 2026-09-02
project: DevFlow
tags: [phase-3, roadmap, arkg, otel, mcp-server, refusals]
---

# Context — devflow-state

## Situation

DevFlow is three npm packages in one repo: a Chrome MV3 extension that records
browser flows and locates the source a React component was written in, an MCP
server (`mcp-server/`, published as `devflow-mcp-server`) that hands those
recordings to Claude Code, and an optional unpublished Babel plugin
(`compiler-plugin/`). Phases 0–2 of `ROADMAP_AND_PHASES.md` are finished. Phase 3
is three-fifths shipped: Work Streams 3.1 (through Tier 2), 3.2 and 3.4 are on
`main` and covered by `npm run verify`; 3.3 and 3.5 have not been started. The
last work merged was 3.2 — value lineage joined to the backend — in `50fb793` on
2026-09-02.

## Established facts

- **`npm run verify` exits 0** on `main` with a clean tree: 145 test files, 3218
  tests. The 145 files are countable in `tests/`; the gate runs typecheck over
  both tsconfigs, eslint, six lint gates, vitest and five builds.
- **`main` is 6 commits ahead of `origin/main` and has not been pushed. Pushing
  has not been asked for.** The unpushed range is `origin/main..main` =
  `b007554`, `81b9ce5`, `1d06824`, `69b7d71`, `c5d58e6`, `50fb793` — i.e. the
  whole of 3.1 Tier 2 *and* the whole of 3.2. Re-check with
  `git rev-list --count origin/main..main` rather than trusting this line.
- **Phases 0–2 are finished. What remains in them is five refusals with the
  argument on the record, not five gaps.** They are the single most likely thing
  for a fresh session to "helpfully" undo. See *Decisions made*.
- **Phase 3 status, from the roadmap's own preamble and its ticks:** 3.4
  (Temporal Diff, `compare_flows_across_deploys`) shipped first; 3.1 Tier 1
  (trace header injection) and Tier 2 (OTel span ingest, `get_backend_trace`)
  shipped second; 3.2 (end-to-end lineage, shipped as a **fifth layer on
  `get_value_provenance`** rather than a new `get_full_lineage` tool) shipped
  third. **3.3 (Living Architecture Map) and 3.5 (Framework-Agnostic Adapters)
  are `[ ]` — nothing exists;** `get_living_architecture` is not declared
  anywhere in the tree.
- **The project's load-bearing habit is to measure foreign formats and foreign
  APIs rather than reason about them.** Four instances, each of which changed a
  design:
  - A **two-origin Playwright probe against real Chromium** (Playwright 1.62.1)
    settled 3.1's CORS preflight rule. It also produced two findings reasoning
    would not have: a failed preflight leaves *no* server-side evidence (the API
    logs the `OPTIONS` and never the `GET`), and DevFlow **cannot observe the
    preflight** — Chromium makes it in the network service, and DevFlow patches
    `fetch`/`XMLHttpRequest` in the page.
  - A throwaway `@opentelemetry/sdk-trace-node` service settled **four wire facts
    of Tier 2, three of which reasoning would have got wrong**: spans arrive
    leaf-first; the root's parent never arrives at all, so `buildSpanTree` roots
    on *"parent not present"* and not *"no parent"*; `startTimeUnixNano` arrives
    as a JSON string past `Number.MAX_SAFE_INTEGER` and is subtracted as
    `BigInt`; ids are hex in OTLP/JSON and raw bytes in protobuf.
  - A second live capture (express + knex + better-sqlite3 under the official
    auto-instrumentations) settled 3.2: a response body appears **nowhere** in a
    trace, real instrumentation parameterises (`where id = ?`), and the richest
    evidence is the **stack trace of a failed span**, where the driver
    interpolates the real value the query attribute hid.
  - Throwaway git repositories settled 3.4's `git log` parser before a line of it
    was written.
- **A real browser is reachable from this machine** out of the npx cache:
  `find ~/.npm/_npx -path '*node_modules/playwright/index.js'` resolves (verified
  2026-09-02). For any claim about browser behaviour that is as good as the
  Claude-in-Chrome extension — same network stack.
- **Named gaps, carried openly rather than hidden.** Each is written down in the
  roadmap or a module header:
  - `explain_feature` cannot find `service`/`operation` entities by name.
    `EntityKind` in `src/core/navigator/index.ts` has six kinds and neither of
    these, and `mcp-server/arkg.js` has no corpus arm for them — so a service is
    listed by `get_app_architecture` and walked onto correctly by
    `getNeighbours`, and is unreachable by name.
  - **OTLP/protobuf is refused with a `415`** naming the one line that would fix
    it. A subtly wrong varint does not throw; it writes a plausible number into
    the graph.
  - **`db.postgresql.values` is dropped**, so `pg` bind values — the one place
    the value missing from a parameterised `db.query.text` lives — are invisible.
    It is an OTLP `arrayValue`, a shape the reader does not decode
    (`src/core/otel/index.ts`, lines ~69 and ~91).
  - **`buildSpanTree` is O(n²)**: every node calls `descendsFrom`, which walks
    the ancestor chain, and `settle` recurses proportionally to chain depth. It
    is reachable from two endpoints that admit an unauthenticated caller —
    `POST /v1/traces`, which **cannot** be `extensionOrigin`-guarded because the
    sender is the user's own backend, and `POST /flows`, which is guarded but
    whose guard passes any request with **no `Origin` header at all** (by
    design — "a local tool like curl", `mcp-server/server.js:1662`).
    `src/core/otel/index.ts` guards cycles for exactly this reason; it does not
    bound depth or fan-out.
  - **`componentTable` in `mcp-server/server.js` (now line 1054, previously cited
    as 974) has no caller** — dead code, noticed six sessions ago.
  - **`compiler-plugin` has never been run against a real application's build**,
    only against fixtures in this repo. It is `private: true` and unpublished;
    `scripts/sync-version.mjs` and `tests/versions.test.ts` keep it in step, so
    publishing is one field — the honest gate is running it once for real. SWC
    (`@vitejs/plugin-react-swc`, Next.js) is not covered and there is no port.
- **Nothing has been released since `v3.1.1` (2026-08-29).** `CHANGELOG.md` has
  771 lines under `## Unreleased`; `package.json` still reads `3.1.1`. Every
  change touching `src/` or `public/` needs an entry there — `lint:changelog`
  enforces it.
- **A previous AI ("Antygravity") built Phases 0–2 badly and it shipped as
  `v3.2.0`.** An audit found the MCP server would not boot, typecheck red, 29
  tests failing and 12 roadmap items ticked for stubs or dead code. `main` was
  reset to `v3.1.1`; the work survives on `archive/antygravity-phase-0-2` and tag
  `archive/v3.2.0-antygravity` — a source of *ideas*, never of code to copy.

## Decisions made

Five items in Phases 0–2 are **refusals with the argument written out in
`ROADMAP_AND_PHASES.md`**. They are settled. To overturn one, the argument to
beat is in the roadmap section named; the ADRs mirroring them live in
`.ctx/decisions/`.

- **Module-level Zustand stores are not read** (§1.2). Refused on measurement
  against React 19.2.8 and Zustand 4.5.7/5.0.15: `getSnapshot` is a per-consumer
  closure, not `api.getState`; consumers can be grouped by `api.subscribe`, but
  the union of *selections* is a fact about the route visited, so a differ over
  it would emit a fabricated `remove` on unmount and a `state_keys` label that
  changes per recording. §1.2 names exactly what evidence would overturn it: a
  mechanism yielding the store *object*.
- **Periodic layout snapshots are not built** (§2.1). A timer reading layout
  forces a reflow on every recorded page, and a between-steps snapshot belongs to
  no step in the schema. DOM MutationObserver deltas *did* ship and are a
  different observation, not a smaller one.
- **`causedBy` is not stamped onto events** (§2.1). §1.3 derives the causal graph
  at read time from facts the flow already carries, so every recording already on
  disk gets it and a sharpened rule reaches all of them. Left `[ ]` rather than
  struck out: the day something in the extension needs a chain it cannot derive,
  this is the item that answers it.
- **Generated store assertions in E2E specs are refused** (§2.1). A fiber walk
  pasted into somebody's repo goes red when React moves an internal, reporting a
  bug in their app that is not there. The observation ships as comments beside
  the step.
- **Patch generation is refused** (§2.4). DevFlow is not a model; the caller is.
  "In-memory application" has no honest form either. DevFlow owns diagnosis
  (`diagnose_failure`) and verification (`replay_flow`).

Other settled choices worth not re-arguing:

- **3.2 is a fifth layer on `get_value_provenance`, not a third tool.** Building
  a second renderer of one question is the mistake this repo made once with two
  markdown renderers — `src/core/mcp-bundle.ts` exists because of it.
- **`get_full_lineage(domNodeId)` and
  `compare_flows_across_deploys(flowId, sha1, sha2)` are roadmap signatures that
  did not survive contact.** A recording *describes* an element and addresses
  none, so there is no `domNodeId`; and one flow id names one commit, so the
  deploy comparison takes a flow **name**. Both corrections are in the roadmap.
- **Trace headers are off by default, active only while recording, same-origin
  freely and cross-origin only for a user-named allow-list origin**, and never
  overwrite a `traceparent` the page already set.
- **`DEVFLOW_OTEL=1` is the opposite default from `DEVFLOW_GIT`**, argued rather
  than inherited: this endpoint accepts a document from off the machine.
  Machine-level capabilities (`DEVFLOW_GIT`, `DEVFLOW_REPLAY`, `DEVFLOW_OTEL`,
  `DEVFLOW_PROJECT_ROOT`) are environment variables and **not settings**, because
  `POST /config` is reachable by any page the browser visits.

## Open questions

- [ ] **`docs/CONTRACTS.md` §4 contradicts itself and `mcp-server/` breaks it
      either way.** Line 285 defines **flow** as "one recording, start to stop"
      and, in the same row, lists "recording *(as a noun)*" among the forbidden
      spellings. `mcp-server/server.js` says "this recording" 32 times.
      `scripts/check-vocab.mjs` globs only `src/**/*.{ts,tsx,html}` and
      `public/**/*.html`, so nothing catches it in either direction. CONTRACTS is
      **frozen** — the instruction is to say it is wrong, not to fix it locally.
- [ ] Should `lint:vocab` extend to `mcp-server/` and `compiler-plugin/`? Doing
      so today would fail the gate on the contradiction above.
- [ ] Push `main` to `origin/main`? Six commits are unpushed and **nobody has
      asked**. Do not push without being asked.
- [ ] Cut a release? 771 changelog lines have accumulated under `## Unreleased`
      since `v3.1.1` on 2026-08-29.
- [ ] Bound `buildSpanTree`'s cost, or accept it? `POST /v1/traces` is
      unauthenticated by construction and cannot be otherwise.
- [ ] **"Any page the browser visits can reach this endpoint" is false, and it
      is written in about twenty places.** `extensionOrigin`
      (`mcp-server/server.js:1662`) returns true for a **missing** `Origin` or an
      extension's, and a browser attaches `Origin` to every cross-origin POST —
      so a visited page is rejected with a 403. `POST /flows` (:1952),
      `POST /config` (:1808), `DELETE /flows/:id` (:1722) and
      `POST /arkg/ingest-component` (:2185) are all behind it. The reachable
      writer is **any local process** — curl, a package's postinstall script —
      not a website.

      Every conclusion built on the premise survives, because a local process is
      still an untrusted writer: machine capabilities stay environment variables
      rather than `POST /config` settings, flow fields stay untrusted, and one
      `tracedCallsOf` is still better than two. Only the stated reason was wrong.
      Corrected on 2026-09-02 in the four places this session authored
      (`src/core/otel/index.ts`, `src/core/provenance/index.ts`,
      `ROADMAP_AND_PHASES.md` §3.2, `CHANGELOG.md`). **Roughly sixteen remain**,
      in `src/core/replay/index.ts`, `mcp-server/{server,git,otel}.js`,
      `ROADMAP_AND_PHASES.md:226` and four test headers. Each needs its own
      reading — some say "can *reach* a loopback port", which is true, and only
      the ones that say the write *succeeds* are wrong. This is the repository's
      own named recurring defect ("comments asserting a fact nobody ran"),
      pointed at its own code rather than a foreign API.
- [ ] Run `compiler-plugin` against a real application's build once, before ever
      publishing it.
- [ ] **Four `.call__panel` elements are rendered per call and two are always
      empty.** `src/viewer.html`'s `<template id="tpl-call">` ships
      `data-panel="request"` and `data-panel="response"` placeholders, and
      `buildCall` (`src/ui/viewer/review.ts:667`) *appends* its own two rather
      than filling those. Harmless on screen and a trap for a test: a naive
      `querySelector('.call__panel[data-panel="request"]')` matches the empty
      template one first and passes against a renderer printing nothing.
      `tests/trace-render.test.ts` selects `[data-active]` and says why.
      Verified still true on 2026-09-02.

## Constraints

- **`src/core/` is pure**: no `chrome.*`, no DOM, no `fetch`, no clock, no
  `node:` imports. It is bundled into `mcp-server/core.js` and imported by a Node
  process with no `chrome`, no `window` and no DOM. (`core/dom`, `core/selector`
  and `core/describe` take DOM nodes as *arguments* and are not in
  `mcp-bundle.ts`; that is the line.)
- **Invariant 1, zero-app-dependency**: no npm package and no build change
  required in the user's app. This is what got `v3.2.0` reverted and what shapes
  every refusal in 3.1.
- Every `chrome.*` call goes through `src/chrome/`. No colour outside
  `src/ui/styles/tokens.css`. A setting that is not in
  `src/features/settings/fields.ts` does not exist, and there are exactly five
  field types — `tests/settings-row-shape.test.ts` asserts the count so a sixth
  cannot arrive unnoticed. Settings DOM is built only in
  `src/ui/settings/components.ts`. Line numbers are `Pos0`/`Pos1` and
  `toOneBased()` is the only bridge.
- The ARKG stays additive through the guarded `arkgTry` funnel; `gitTry` and
  `otelTry` are the same shape. Nothing about the graph, git, or spans may fail a
  recording.
- **`npm run verify` is the only definition of done** and its exit code must be
  read directly. `npm run verify | tail -20` reports *tail's* status; this shell
  is zsh, where `${PIPESTATUS[0]}` expands to the empty string. Both look exactly
  like a green gate.
- Commit on a branch and merge; never commit straight to `main`. Update
  `ROADMAP_AND_PHASES.md` in the same commit that finishes a work stream. Run
  `graphify update .` after modifying code.
- Do not tick a roadmap checkbox unless `verify` proves it. `[~]` is always
  available — but a `[~]` carrying a *condition* is not a decision: meet the
  condition or write the refusal.

## Artifacts

- `ROADMAP_AND_PHASES.md` — the truth about what is done. Status key at line 38;
  Phase 3 preamble at line 268; Work Streams 3.1–3.5 at lines 292–460.
- `NEXT_SESSION_PROMPT.md` — the previous handoff, **partly stale**: it says 3.2
  is not started, and 3.2 shipped in `50fb793`; it says `main` is two commits
  ahead, and it is six; it gives 3152 tests, now 3218. Its non-negotiables,
  hard-won lessons and Phase 0–2 refusal list are still correct.
- `CLAUDE.md` — layout, the five invariants and their gates.
- `docs/CONTRACTS.md` — **frozen**. §4 is the glossary, §4.5 the forbidden
  strings.
- `CHANGELOG.md` `## Unreleased` (lines 3–773) — what shipped, in the project's
  own words.
- Phase 3 code: `src/core/trace/` (header rule + the Playwright method, in the
  module header), `src/core/otel/` (wire facts, `buildSpanTree`, `projectTrace`),
  `src/core/provenance/` (the five layers), `src/core/git/`, `src/core/deploy/`;
  `mcp-server/otel.js`, `mcp-server/git.js`, `mcp-server/arkg.js`,
  `mcp-server/server.js`.
- Git: `origin/main..main` is the unpushed Phase 3.1-Tier-2 + 3.2 range;
  `git show --stat 50fb793` is 3.2 in full. Phase 3 as a whole starts at
  `aa98649`.
- `.ctx/decisions/` — the ADRs for the five Phase 0–2 refusals.
- `graphify-out/GRAPH_REPORT.md` — read before searching raw files.

## Resume here

Read `ROADMAP_AND_PHASES.md`'s Phase 3 preamble and Work Streams 3.3 and 3.5,
then load the `phase-3-remaining` bundle: the next action is a **costing
decision** between 3.3 (which needs a live connection to an open page — a
mechanism nothing in the product has) and 3.5 (three Phase-1-sized adapters), not
an implementation. Do not push `main` and do not start reopening the five
refusals.
