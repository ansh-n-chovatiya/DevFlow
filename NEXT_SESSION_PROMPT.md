# DevFlow — Phase 3, continued

Read `CLAUDE.md`, `ROADMAP_AND_PHASES.md` (start at "Status key", then the
**Phase 3** preamble and **Work Streams 3.2 and 3.3** in full) and
`graphify-out/GRAPH_REPORT.md` before touching anything. This file is the
handoff; the roadmap is the truth about what is done.

## Where the project is

**You are on `main`, working tree clean, `npm run verify` green: 145 test files,
3152 tests.** Three branches have been merged and none is work in progress:
`phase-3/git-lineage` (3.4 and the Phase 0 git items), `phase-3/trace-headers`
(3.1 Tier 1) and `phase-3/otel-ingest` (3.1 Tier 2, and the preflight
measurement).

**`main` is two commits ahead of `origin/main`** — Tier 2 has not reached the
remote. Pushing has not been asked for. Do not push without being asked, and
check `git rev-list --count origin/main..main` rather than trusting this
sentence, which was true when it was written.

**Phases 0–2 are finished.** What is left in them is five refusals with the
argument on the record, listed at the foot of this file.

**Phase 3: 3.1 and 3.4 are shipped; 3.2, 3.3 and 3.5 are not started.** 3.1 is
now complete through Tier 2 — the header goes out, the spans come back, and the
two are joined. Tier 3 is `[~]` and the distinction is written down: a span
carrying `db.query.text` is rendered, but that is Tier 2 data that happens to
describe a query, not DevFlow instrumenting a database.

> **Run `npm run verify` and read its exit code, not its tail.**
> `npm run verify 2>&1 | tail -20` reports *`tail`'s* exit code, which is always
> 0. Use `npm run verify > /tmp/v.log 2>&1; echo "EXIT=$?"` and believe the
> number. **`${PIPESTATUS[0]}` does not work either** — this shell is zsh, where
> the array is `$pipestatus[1]` and the bash spelling silently expands to the
> empty string. It looks exactly like a passing gate.
>
> **Never `git checkout -- <file>` to undo a mutation you made for a red-check.**
> A checkout restores `HEAD`, not the tree, so it silently reverts any
> *uncommitted* work in that file. Snapshot the file's text and write it back.
>
> **`git diff --stat <path>` proves nothing about a file git is not tracking.**
> It returns empty for an untracked file and for a perfectly restored one, and
> the two are indistinguishable. A whole new directory — `src/core/otel/` was
> one — is untracked until its first commit, so the obvious restoration check
> passes vacuously. **Compare checksums against your snapshot instead.** This
> was caught by a subagent auditing its own report, not by the parent.
>
> **If you run subagents, give each a private scratch directory.** The session
> scratchpad is shared.

A previous AI ("Antygravity") built Phase 0–2 badly and it shipped as v3.2.0. An
audit found the MCP server would not boot, typecheck was red, 29 tests failed,
and 12 roadmap items were ticked for stubs, dead code, or things that actively
broke user apps. `main` was reset to v3.1.1 and only what survived audit was
carried forward. That work is on `archive/antygravity-phase-0-2` — useful as a
source of *ideas*, never of code to copy.

---

## What the last session built

### The preflight, finally watched — 3.1's one unmeasured claim is closed

The previous handoff named it: the whole work stream rested on the belief that a
cross-origin request carrying a non-safelisted header preflights, and fails when
the backend does not allow it. It had been checked from the specification and
from the *server* side with `curl`, neither of which watches a browser decide.

**It now has, against real Chromium**, and the method is recorded in
`src/core/trace/index.ts`'s header so it reproduces in ten minutes: two origins,
an API that answers the preflight and allows the origin and method on *both*
paths, differing only in whether `Access-Control-Allow-Headers` names the
header. Every clause held. Two findings sharpen the rules rather than confirm
them, and both are in the header:

- **A failed preflight leaves no server-side evidence.** The API logged the
  `OPTIONS` and never a `GET`. Somebody whose app breaks this way sees a failed
  fetch in the browser and *nothing whatsoever* in their backend logs.
- **DevFlow cannot observe the preflight.** Page-level instrumentation saw an
  outbound `GET` and then `net::ERR_FAILED`; Chromium makes the preflight in the
  network service and never surfaces it as a page request, and DevFlow patches
  `fetch` and `XMLHttpRequest` *in the page*. Any future "did our header break
  this?" diagnostic has the rejection and nothing else.

**The browser is reachable from here.** The Claude-in-Chrome extension was not
connected, but Playwright 1.62.1 with a real Chromium is installed on this
machine (resolvable out of the npx cache; `find ~/.npm/_npx -path
'*node_modules/playwright/index.js'`). For any claim about *browser* behaviour
that is as good as the extension — it is the same network stack.

### Work Stream 3.1 Tier 2 — spans, and four facts that had to be measured

Read `src/core/otel/index.ts`'s header before touching any of it. Everything was
measured against a real `@opentelemetry/sdk-trace-node` exporter pointed at a
capturing endpoint, and **the captured deliveries are the test fixture**, inlined
in `tests/otel.test.ts`, `tests/otel-store.test.ts` and `tests/arkg-otel.test.ts`.
Three of the four would have been got wrong by reasoning:

- **Spans arrive leaf-first.** A span is exported when it *ends*, and a child
  ends before its parent — the `SELECT` at depth three arrived in the first
  delivery, the root server span in the third. Nothing may assume a parent has
  been seen.
- **The root's parent will never arrive.** The backend parents its top span on
  the `traceparent` DevFlow sent, and DevFlow is not an OTel SDK and emits no
  spans. So `buildSpanTree` roots on **"parent not present"**, not on "no
  parent" — a one-word difference that returns an empty forest for every good
  trace if you get it wrong.
- **`startTimeUnixNano` does not fit in a `number`.** It arrives as a JSON
  *string* two orders of magnitude past `Number.MAX_SAFE_INTEGER`. Subtracted as
  `BigInt`; only the difference crosses back.
- Ids are hex in OTLP/JSON and raw bytes in protobuf, which is why this reads
  JSON only.

**A span is an event and the graph needed something that outlives one.** This is
the `caused_by` rule and it bites hardest here: a node per span would stop the
ARKG being an accumulation and make it a log. `services` and `operations` are
the two node kinds; a span is an observation *of* an operation exactly as a call
is an observation of an endpoint. **`frequency` counts recordings and the timing
window counts spans**, deliberately — forty spans of one handler in one request
is one thing the recording showed, but forty real measurements of a
distribution. Do not "fix" that to agree.

**`DEVFLOW_OTEL=1`, the opposite default from `DEVFLOW_GIT`**, and the argument
is in `mcp-server/otel.js`'s header. Every other write endpoint on that port is
guarded by `extensionOrigin` and **this one cannot be** — the sender is the
user's own backend, which has no extension origin and never will.

### Three gaps the parallel agents found in files they did not own

This is the part worth copying. Each agent owned a disjoint file set and was
asked to *report* rather than fix anything outside it. Every one of the three
was real, and none would have been found by the agent that owned the file:

- **Retention never reached the new node kinds.** Services and operations are
  the ones that most need it: every other node is created by somebody recording,
  so the graph grows at the rate a person works, while these are created by a
  span arriving on an endpoint nothing on the machine paces.
- **A graph fed only by an exporter reported as empty.** Since spans normally
  arrive *before* the recording, "services and no recordings" is the ordinary
  intermediate state, and it was indistinguishable from a fresh install.
- **`mcp-server/otel.js` would have shipped unpublished.** Worse than the other
  five files in that list: a missing `otel.js` degrades into a *wrong answer*
  ("span ingest is off") rather than into silence, so the user turns the
  variable on, sees the same sentence, and has no thread to pull.

All three are fixed and covered by tests that go red without them.

---

## Phase 3, and what to do next

### 3.2 is now unblocked, and it is the obvious next thing

The previous handoff's table said 3.2's gap was "the backend half, and only Tier
2/3 can supply it". **Tier 2 now supplies it.** What exists:

| Roadmap asks for | What already exists | The actual gap |
| --- | --- | --- |
| **3.2** `get_full_lineage(domNodeId)` | `get_value_provenance` — one value across response body, store write, component and element. And now `get_backend_trace` — the span tree under the request | Joining the two. A recording still has **no DOM node ids** — an element is described, not addressed — so `domNodeId` in the roadmap is not a thing that exists, and the correction belongs in the roadmap the way 3.4's signature correction did. |

**Do not build a third tool beside those two.** That is the mistake this
repository has already made once with two markdown renderers, and 3.4 was
written to avoid it. The honest shape is almost certainly `get_value_provenance`
gaining a fifth layer — the backend — when the step's call carries a trace id
that joined. Its header already argues the four-layer ordering as "the direction
a value travels in a React application"; a controller and a query are the next
two steps in that same direction, and the module's central discipline (**this
finds; it does not trace**) has to survive the extension. A value found in a
response body and also in a `db.query.text` is two sightings, not a lineage.

### 3.3 is a different mechanism and still worth costing before promising

`get_app_architecture` is the accumulated graph. "Real-time" and "currently
mounted" are a **live connection to an open page**, not a graph query — nothing
shipped so far works that way.

### 3.5 is three work streams and should be planned as three

Vue 3, Svelte 5 and React Server Components do not share React's fiber tree and
nothing in `src/core/react/` transfers. Treat 3.5 as out of scope unless told
otherwise, and say so rather than starting one and leaving two.

---

## Loose ends worth an hour, none of them blocking

- **`explain_feature` cannot see backend nodes.** `EntityKind` in
  `src/core/navigator/index.ts` has six kinds and no `service` or `operation`,
  and `NAVIGATOR_NODE_TYPE` in `mcp-server/arkg.js` has no arm for them — so a
  service is listed by `get_app_architecture` and walked onto by
  `getNeighbours` (which labels it correctly) and cannot be found by name. This
  is a **named gap, not a refusal**; it was left because a half-scored entity
  kind in a matcher whose whole risk is overstating what it knows is worse than
  an absence somebody can see.
- **OTLP/protobuf is refused with a `415`** naming the one line that fixes it.
  A decoder is a second wire format to get exactly right and a subtly wrong
  varint does not throw — it writes a plausible number into somebody's graph.
  If you ever build it, real protobuf bytes are trivial to recapture: the
  emitter is described in `core/otel`'s header.
- **`componentTable` in `mcp-server/server.js:974` is dead** — still no caller,
  noticed six sessions ago. Somebody should.
- **Every call in the flow review draws four `.call__panel` elements, two
  permanently empty.** `src/viewer.html`'s `<template id="tpl-call">` ships
  `data-panel="request"` and `data-panel="response"` placeholders and `buildCall`
  appends its own two instead of filling those. Harmless on screen; a trap for a
  test, because a naive `querySelector('.call__panel[data-panel="request"]')`
  matches the empty one and passes against a renderer printing nothing.
  `tests/trace-render.test.ts` selects `[data-active]` and says why.
- **`compiler-plugin` is `private: true` and unpublished**, and has never been
  run against a real application's build. `sync-version.mjs` and
  `tests/versions.test.ts` keep it in step, so publishing is one field — but the
  honest gate is running it against a real app once.
- **SWC is not covered and there is no port.** `@vitejs/plugin-react-swc` and
  Next.js take no Babel plugin. The README says so rather than implying coverage.

---

## What is left in Phases 0–2

### Refused, with the argument on the record — 5 items

**These are done.** Each is a decision written out in `ROADMAP_AND_PHASES.md`,
not an omission. To overturn one, the argument to beat is in the roadmap.

- **Module-level Zustand stores** (1.2) — refused on measurement against React
  19.2.8 and Zustand 4.5.7/5.0.15. §1.2 names the evidence that would overturn it.
- **Periodic layout snapshots** (2.1) — a timer reading layout forces a reflow on
  every recorded page, and a snapshot taken between steps belongs to no step.
- **`causedBy` stamping** (2.1) — 1.3 derives the chain from facts the flow
  already carries; a stamp would be a second copy, absent from every recording
  already on disk, freezing today's rules.
- **Generated store assertions in E2E specs** (2.1) — a fiber walk pasted into
  somebody's repo goes red when React moves an internal, reporting a bug in their
  app that is not there.
- **Patch generation** (2.4) — DevFlow is not a model.

---

## Things earlier sessions learned the hard way

- **Measure the internals rather than reasoning about them.** This is now the
  most load-bearing habit in the project. Ten minutes of throwaway git
  repositories settled 3.4's parser before a line of it was written; a throwaway
  OTel service settled every one of Tier 2's four wire facts, three of which
  reasoning would have got wrong; a two-origin Playwright probe closed 3.1's
  last open claim. **Foreign formats and foreign APIs are where this codebase's
  bugs come from**, and every one of them was found by printing the real shape.
- **Know what you did not measure, and say so.** An unmeasured claim you have
  named is a known gap; one you have not is a belief.
- **Comments asserting a fact about a foreign API that nobody ran are the
  recurring defect.** Three now: `new URL` and IPv6 brackets, `new Request` and
  `bodyUsed`, and `blob:` origins. Two were load-bearing and false.
- **`replay_flow` is the first tool that executes code**, off behind
  `DEVFLOW_REPLAY=1`. `mcp-server/git.js` is deliberately *not* that shape and
  its header says why. `mcp-server/otel.js` is a third shape again — off by
  default like replay, but for the input's provenance rather than for what it
  does. Three gates, three arguments, none copied from another.
- **A decision that cannot be reached by a test does not belong where it is.**
  `core/replay`, `core/git`, `core/deploy` and `core/otel` are all the same split
  for the same reason: the decisions are pure, the spawning and the sockets are
  not.
- **The write and the renderer are one deliverable, and there is usually more
  than one renderer.** The commit stamp has four, counted on purpose. Tier 2's
  are `get_backend_trace`, `get_app_architecture`'s services section, and the
  `flow.md`/tool surfaces that already print a trace id. **Count the renderers.**
- **Test at the layer that can lose the data, not below it.** Two by-name
  flow-level copies still silently drop new fields — `buildPayload` in
  `src/features/mcp/send.ts` and `saveFlow` in `mcp-server/server.js`. Step
  fields are spread and survive; flow-level fields are listed by name.
- **A fixture frozen at a constant timestamp is outside every retention
  window.** `tests/arkg-otel.test.ts` uses a fixed `NOW` in 2023; a retention
  test written against it fails for a right reason and would have passed for a
  wrong one. Retention is measured against `Date.now()` — ingest at the wall
  clock when that is what you are testing.
- **Vitest reads the `@vitest-environment` directive from anywhere in the file,
  comments included.** Writing it inside a doc comment to explain why a file does
  *not* use jsdom silently switches jsdom on.
- **`src/injected/agent.ts` *can* be loaded**, and a source-text test over it is
  almost never the right answer. `tests/agent-network.test.ts` and
  `tests/agent-trace.test.ts` import it under jsdom, having installed their stubs
  for `fetch` and `XMLHttpRequest` **before** the import. Drive it with a
  `MessageEvent` carrying `source: window` and `origin: window.location.origin`
  — a bare `postMessage` supplies neither and the agent's control guard silently
  drops it.
- **Use subagents in parallel with explicit file ownership.** Freeze the shared
  contract yourself first — a typechecking module and a written-down interface,
  not a description — tell them not to run `verify` or `build*`, and give each a
  **private** scratch directory.
  - **Ask them to report what they notice in files they do not own, and forbid
    them from touching those files.** That instruction produced the three best
    findings of the last session, none of which the owning agent could have
    found. It also produced an agent correcting the *parent's* verification
    method, which is worth more than any of them.
  - **Verify their results independently.** Re-run their suites, and run your
    own mutations rather than trusting a mutation report.

## Non-negotiables

- `src/core/` is pure — no `chrome.*`, no DOM, no `fetch`, no clock, **and no
  `node:` imports**. It is bundled into `mcp-server/core.js` and imported by a
  Node process. (`core/dom`, `core/selector` and `core/describe` take DOM nodes
  as *arguments* and are not in `mcp-bundle.ts`; that is the line.)
- Every `chrome.*` call goes through `src/chrome/`.
- The ARKG stays additive, via the guarded `arkgTry` funnel. Nothing about the
  graph may fail a recording — and nothing about `git` or `otel` may either,
  which is what `gitTry` and `otelTry` are.
- Anything published must be in its package's `files` list — and there are
  **three** packages. `scripts/sync-version.mjs`, `scripts/cut-release.mjs` and
  `tests/versions.test.ts` all know about `compiler-plugin/`.
- Any change touching `src/` or `public/` needs a `## Unreleased` changelog entry.
- Strings obey the frozen `docs/CONTRACTS.md` §4. It is frozen — if it is wrong,
  say so; do not fix it locally.
- A setting that is not in `src/features/settings/fields.ts` does not exist, and
  after touching that table you run `npm run build:settings`. There is no
  free-form list type and do not add one; `tests/settings-row-shape.test.ts`
  asserts the five type names so a sixth cannot arrive unnoticed. **A
  machine-level capability is not a setting** — `DEVFLOW_GIT`, `DEVFLOW_REPLAY`,
  `DEVFLOW_OTEL` and `DEVFLOW_PROJECT_ROOT` are environment variables on the
  server's own environment, because `POST /config` is reachable by any page the
  browser visits.
- Comments say **why**, not what.

## How to work

- **Do not tick a checkbox unless `npm run verify` proves it** — and unless you
  have read the thing it claims. `[~]` is always available and is never a
  failure. But a `[~]` carrying a *condition* is not a decision: either meet the
  condition or write the refusal.
- **Do not build a module with no caller.**
- **Write tests that would fail against the bug.** Break the code the test
  covers, confirm it goes red, revert — *by restoring the text, and verifying
  with a checksum rather than with `git diff`*. When a mutation survives, ask
  **where the code is** and **what the fixture actually distinguishes** before
  you ask what the assertion missed. **A survivor is a question, not a verdict**:
  last session's one survivor was a pure short-circuit whose real decision lived
  two lines away, and the finding was worth more than a new assertion would have
  been — it is now a comment in the source saying which line is load-bearing.
- Run `graphify update .` after modifying code.
- Commit on a branch and merge; never commit straight to `main`. Suggested:
  `phase-3/lineage` for 3.2.

## When you finish a work stream

Update `ROADMAP_AND_PHASES.md` in the same commit, run the full `npm run verify`
(and read its exit code), and say plainly what is shipped, what is partial and
what you chose not to build and why. If something is blocked, finish everything
else in full and name what you left out — scaling the work down is the user's
call, not yours.
