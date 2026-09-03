---
ctx_schema: 1
task: close-phase-3-build-work-stream-3-3-living-architecture-map-record-3-5-as-a-deferral
level: 1
status: done
created: 2026-09-03
verify:
  - kind: cmd
    run: npm run verify
---

## Objective
Close Phase 3 by building Work Stream 3.3 (Living Architecture Map) and recording
Work Stream 3.5 (Vue/Svelte/RSC adapters) as an argued deferral, so that Phase 4
can start against a roadmap whose Phase 0–3 boxes are each either proved by the
gate or answered by a written refusal.

## Acceptance criteria
1. `npm run verify` exits 0, read as `$?` directly and never through a pipe.
2. A page-side reading of the currently-mounted component tree exists, is bounded
   by an existing cap, takes **one** sample rather than a commit hook, and
   installs nothing on the page — `src/injected/state.ts`'s refusal holds.
3. The decisions in the map are made in `src/core/` and are pure: no `chrome.*`,
   no DOM, no `fetch`, no clock, no `node:` import. It survives `build:mcp`.
4. An MCP tool answers the living-architecture question, and its answer states
   **when** the reading was taken and **which page** it came from. A snapshot
   presented as a live feed is a failure of this criterion.
5. No second tool is built beside `get_app_architecture` answering the same
   question — the two-markdown-renderers mistake. Either the boundary between
   "accumulated" and "currently mounted" is stated, or there is one tool.
6. `ROADMAP_AND_PHASES.md` §3.3 is ticked only for what the gate proves, and any
   part of the roadmap's wording that did not survive contact is corrected in the
   roadmap with the finding written out — the `get_full_lineage(domNodeId)` and
   `compare_flows_across_deploys` precedent.
7. `ROADMAP_AND_PHASES.md` §3.5 carries a deferral that names Phase 5 §5.4 as
   where the three adapters live, with the argument recorded as an ADR in
   `.ctx/decisions/`. It is a decision, not a `[~]` carrying a condition.
8. `CHANGELOG.md` has an `## Unreleased` entry (`lint:changelog` gate).
9. Work lands on a branch and is merged; `main` is not committed to directly.

## Notes
Baseline at start: `main`, 9 commits ahead of `origin/main` and unpushed (pushing
has not been asked for). `npm run verify` EXIT=0, 145 test files, 3218 tests.

The mechanism finding that unblocks 3.3: `.ctx/contexts/phase-3-remaining.ctx.md`
records that the MCP server has no channel *to* an open tab, and treats that as
3.3's cost. It is only a cost if the tool must **pull**. Reversing the direction —
the page agent takes one bounded reading and the extension **pushes** it over the
channel that already exists (`POST /arkg/ingest-component` and its four
neighbours) — needs no new channel, no persistent connection and no service
worker kept awake. What it costs instead is honesty about age, which is why
criterion 4 exists.

`src/injected/render.ts` + `src/core/render/blame.ts` are the pattern to copy:
impure bounded walk in `injected/`, judgement in `core/`, cap from
`recording.renderNodeCap` in `src/features/settings/fields.ts`.

3.5 deferral rests on the roadmap's own Phase 3 preamble ("starting one and
leaving two would be worse than starting none"), "What NOT to Build", and the
fact that Phase 5 §5.4 already carries the same three frameworks at deeper scope.
User confirmed this scope on 2026-09-03.

## Outcome (2026-09-03)

Shipped. `npm run verify` EXIT=0 — 146 test files, 3246 tests, up from 145/3218.

**3.3 built.** The mechanism the ledger recorded as its cost — no channel from
the server back to an open tab — dissolved once the direction was reversed. The
extension pushes a bounded reading over the channel that already exists; the
tool renders it with its age. The roadmap's "real-time" did not survive contact
and is corrected in the roadmap, with ADR 0016 carrying the argument.

Files: `src/core/architecture/index.ts` (pure, bundled), `src/injected/
architecture.ts` (one bounded walk, installs nothing), `src/injected/roots.ts`
(the shared root finder `render.ts` and `state.ts` each said they would become on
the day a third caller wanted it), `POST /architecture` and
`get_living_architecture` in `mcp-server/server.js`, the panel's **Read
architecture**, and `tests/architecture.test.ts` — 28 tests, the server half
driven through a real spawned server.

Three mutations were run against the load-bearing decisions and all three were
killed: the age removed from the rendered first line, the component ordering
flipped from depth to instance count, and the server's `takenAt` guard disabled.
Files restored by checksum against a snapshot taken immediately before each.

**3.5 deferred**, as three work streams, to Phase 5 §5.4 — ADR 0017. Phase 4
depends on none of it.

**Left undone, deliberately and named in the roadmap:** active API calls are not
in the reading (an in-flight request leaves no trace on the fiber tree, so it
would need ambient bookkeeping on every page), and the animated "show me
everything that renders when I click checkout" graph is not built — 1.3 and 1.4
already ship its data, so what is missing is a visualisation, and a second
component-tree view beside the panel's own would be the two-renderers mistake.

## Addendum (2026-09-03) — the cascade

The audit after this task asked whether anything in Phases 0–3 was still
buildable. One thing was, and one line of this repository's own roadmap had
dressed it as a refusal: the animated render graph in §3.3 was argued away as "a
second component-tree view beside the panel's Parent tree and Siblings", which is
the wrong surface — the panel is the locator, and `ui/viewer/review-view.ts`
already reads `FlowRenders` per step. Corrected first, then built.

Shipped: `src/core/cascade/index.ts` (pure — the evidence-gated join),
`src/ui/viewer/cascade.ts` (columns in the DOM, wires in one SVG overlay, an
ordered reveal), the dialog and three templates in `src/viewer.html`, styles in
`viewer.css` with confidence carried in weight and dash rather than hue, and
`tests/cascade.test.ts` — 22 tests, most of them about the edge a render was
**not** given.

`npm run verify` EXIT=0 — 147 test files, 3271 tests. Three mutations killed the
suite: guessing a cause for an unexplained render, ordering a layer so wasted
renders fall out under budget, and flattening the confidence rank so layers come
from shortest path again.

`tests/viewer-markup.test.ts` earned its keep twice here, catching five invented
Lucide icon names that would have rendered as nothing at all, and a graph whose
boxes were built in TypeScript where no gate could see them.
