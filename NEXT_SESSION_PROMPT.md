# DevFlow — Phase 3

Read `CLAUDE.md`, `ROADMAP_AND_PHASES.md` (start at "Status key", then read
**Phase 3** in full) and `graphify-out/GRAPH_REPORT.md` before touching
anything. This file is the handoff; the roadmap is the truth about what is done.

## Where the project is

**You are on `main`, working tree clean, `npm run verify` green: 135 test files,
2753 tests.** `phase-1/compiler-plugin` is merged. Nothing is pushed — `main` is
well ahead of `origin/main`, and pushing has not been asked for. Do not push
without being asked.

**Phases 0–2 are finished.** Everything in them that can be completed is
completed. What is left in them is three items that need the git integration
Phase 3 builds, and five refusals with the argument on the record. The inventory
is at the foot of this file and it is exhaustive.

**So this session is Phase 3.** Nothing gates it.

> **Run `npm run verify` and read its exit code, not its tail.**
> `npm run verify 2>&1 | tail -20` reports *`tail`'s* exit code, which is always
> 0. Use `npm run verify > /tmp/v.log 2>&1; echo "EXIT=$?"` and believe the
> number.
>
> **Never `git checkout -- <file>` to undo a mutation you made for a red-check.**
> A checkout restores `HEAD`, not the tree, so it silently reverts any
> *uncommitted* work in that file. Snapshot the file's text and write it back —
> four lines of Python. Last session ran seventeen mutations that way without
> incident.

A previous AI ("Antygravity") built Phase 0–2 badly and it shipped as v3.2.0. An
audit found the MCP server would not boot, typecheck was red, 29 tests failed,
and 12 roadmap items were ticked for stubs, dead code, or things that actively
broke user apps. `main` was reset to v3.1.1 and only what survived audit was
carried forward. That work is on `archive/antygravity-phase-0-2` — useful as a
source of *ideas*, never of code to copy.

---

## Read this before planning Phase 3

Phase 3 as written in the roadmap is the most ambitious phase in the document
and the one most likely to be half-built. Four things are already known and
would otherwise cost you a day each to find out.

### 1. The one decision that can break somebody's application

**Work Stream 3.1's header injection is the first time DevFlow would change what
the recorded app sends to its own backend.** Everything before it observes.

It is *not* a new patch: `src/injected/agent.ts` already replaces
`window.fetch` and `window.XMLHttpRequest`, unconditionally, at
`document_start`, on every page the user opens — see `install()` near the foot
of that file, and `patchedFetch` at line ~430. The machinery to add a header is
already sitting in the function that records one.

The hazard is CORS, and it is concrete rather than theoretical. Adding a custom
request header to a **cross-origin** request makes it a non-simple request, so
the browser sends an `OPTIONS` preflight where it previously sent none; if the
backend does not name the header in `Access-Control-Allow-Headers`, the request
**fails**. That is a working page broken by DevFlow being installed — Invariant
1 failing on a recorded page, which is exactly what got v3.2.0 reverted, in a
different subsystem.

So before any code: decide, and write the decision down where a test can reach
it. The shape that survives that argument is probably *off by default, opted
into, same-origin by default, and never silently converting a simple request
into a preflighted one* — but that is a recommendation, not a finding. Whatever
you choose, `X-DevFlow-Trace-Id` on `fetch` is four lines and the reasoning
around it is the whole work stream. Do the reasoning first, the way §1.1's rule
was written before the first line of plugin code.

Note also that `traceparent` (W3C Trace Context) is a *standard* header a
backend may already accept, and `X-DevFlow-Trace-Id` is bespoke. They do not
carry the same risk and should not be decided as one switch.

### 2. Git belongs to the server, not the browser

`git_sha`, `git_commits` and `changed_in` are the three Phase 0 items Phase 3
unblocks, and the roadmap says to pick them up **inside** the git pass rather
than as an errand afterwards. Everything you need already exists:

- **The columns are declared and always NULL.** `git_sha TEXT` at
  `mcp-server/arkg.js` lines 214, 243, 256, 299 and 319. `mcp-server/arkg.js:82`
  names them as the canonical example of the defect the audit called out — a
  column that is always NULL — so filling them closes that comment too.
- **Migrations have a mechanism.** `addMissingColumn(table, column, decl)` in
  `mcp-server/arkg.js`; `CREATE TABLE IF NOT EXISTS` is a no-op against a
  database somebody already has, which is the trap it exists for.
- **The graph stays additive through one funnel.** `arkgTry(what, run, fallback)`
  in `mcp-server/server.js:546`. Nothing about the ARKG may be able to fail a
  recording.

The extension has no filesystem and no repository. The MCP server runs *in* the
project — `DEVFLOW_PROJECT_ROOT`, or the directory it was started in, already
resolved at `mcp-server/server.js:2456` and already used by `get_source_snippet`
to read files. That is where a SHA comes from, and it means a recording made in
a browser gets its SHA stamped by the server at ingest, not carried on the wire.
Say so explicitly wherever you build it, because the alternative — asking the
page — has no answer.

**On spawning `git`:** `replay_flow` is currently the only thing in the server
that spawns a process, and it is behind `DEVFLOW_REPLAY=1` because it *executes
the user's code*. `git rev-parse HEAD` in a directory the server already reads
source files out of is a different risk class, and copying the replay gate
reflexively would make the feature unreachable for no gain. Decide which it is
and write the decision where a test can reach it — but do not skip the ordinary
hardening: a project root that is not a repository, a repository with no
commits, a detached HEAD, and a dirty tree are four different answers and only
one of them is "no SHA". A SHA recorded against a dirty tree names a build that
does not exist anywhere.

### 3. Three of the five work streams overlap tools that already ship

Read these before designing a new tool, or you will build a second one beside a
working first.

| Roadmap asks for | What already exists | The actual gap |
| --- | --- | --- |
| **3.2** `get_full_lineage(domNodeId)` | `get_value_provenance` — the same value found across response body, store write, component and element, with the mechanism's limits stated in the reply | The backend half (controller, SQL), and only Tier 2/3 can supply it. And a recording has **no DOM node ids** — an element is described, not addressed; `get_value_provenance` says so and takes a value or a step instead. `domNodeId` in the roadmap is not a thing that exists. |
| **3.3** `get_living_architecture()` | `get_app_architecture` — the accumulated graph across every recording and pick | "Real-time" and "currently mounted" are the gap, and they are a **live connection to an open page**, not a graph query. That is a different mechanism from everything shipped so far, and worth costing before promising. |
| **3.4** `compare_flows_across_deploys(flowId, sha1, sha2)` | `compare_flows(working, broken)` — divergence point, endpoint differences, calls and errors unique to one run | Only the SHA join. This is the cheapest work stream in Phase 3 by a wide margin and the one whose evidence already exists. |

**Recommended order, and the reasoning rather than the order alone:** 3.4 first
— it needs `git_sha` and `compare_flows`, both of which are one step away, and
it closes the three Phase 0 items on the way. Then 3.2's frontend half, which is
mostly making `get_value_provenance` say what it cannot see about the backend.
Then 3.1, with the argument above settled first. 3.3 and 3.5 last: 3.3 needs a
live channel that does not exist, and **3.5 is three separate framework adapters
that are each a Phase-1-sized body of work** — Vue, Svelte and RSC do not share
React's fiber tree, and nothing in `src/core/react/` transfers. Treat 3.5 as
out of this session's scope unless you are told otherwise, and say so rather
than starting one and leaving two.

### 4. Tier 2 wants a setting, and the settings table is frozen at the edges

`src/features/settings/fields.ts` is the one table — a setting not in it does
not exist — but `docs/CONTRACTS.md` §3.6 enumerates the prefixes each concept
owns and **§4 and §3 are frozen**. `src/features/arkg/ingest.ts` hit exactly
this and rode the existing `mcpAutoSend` switch rather than inventing a prefix,
and its header explains why that was the conservative reading rather than a way
around the rule. Do the same, or say the contract is wrong — do not fix it
locally.

---

## What is left in Phases 0–2

### Blocked on Phase 3 — 3 items, Phase 0. Pick them up inside the git pass.

- `git_commits` nodes
- the `changed_in` edge
- `git_sha` — the columns exist and are always NULL

### Refused, with the argument on the record — 5 items

**These are done.** Each is a decision written out in `ROADMAP_AND_PHASES.md`,
not an omission. To overturn one, the argument to beat is in the roadmap.

- **Module-level Zustand stores** (1.2) — refused on measurement against React
  19.2.8 and Zustand 4.5.7/5.0.15. What a consumer's fiber offers is that
  component's *selection*; the union of selections is a fact about the route the
  recording visited, so a key leaves it when its component unmounts (a state
  change the store never made) and the shape it presents differs between two
  recordings of one store. Consumers *can* be grouped — the effect hook after
  `useSyncExternalStore` carries `deps: [api.subscribe]` — and it does not help.
  §1.2 names the evidence that would overturn it.
- **Periodic layout snapshots** (2.1) — a timer reading layout forces a reflow
  on every recorded page, and a snapshot taken between steps belongs to no step.
- **`causedBy` stamping** (2.1) — 1.3 derives the chain from facts the flow
  already carries; a stamp would be a second copy, absent from every recording
  already on disk, freezing today's rules.
- **Generated store assertions in E2E specs** (2.1) — a fiber walk pasted into
  somebody's repo goes red when React moves an internal, reporting a bug in
  their app that is not there.
- **Patch generation** (2.4) — DevFlow is not a model. Everything a model needs
  to write the patch is in place; a generator here could only be the template
  the reverted version was.

---

## Loose ends worth an hour, none of them blocking

- **`componentTable` in `mcp-server/server.js` is dead** — no caller. Noticed
  three sessions ago while working nearby, still not removed. Somebody should.
- **`compiler-plugin` is `private: true` and unpublished.** It has never been run
  against a real application's build. `sync-version.mjs` and
  `tests/versions.test.ts` keep it in step, so publishing is one field rather
  than a rediscovery — but the honest gate is running it against a real app once.
- **SWC is not covered and there is no port.** `@vitejs/plugin-react-swc` and
  Next.js take no Babel plugin, so the plugin serves a real but partial
  audience. The README says so rather than implying coverage.

---

## Three things earlier sessions learned the hard way

- **`replay_flow` is the first tool that executes code.** Off behind
  `DEVFLOW_REPLAY=1`, and it refuses to install anything. If you add a second
  such tool, copy that shape rather than inventing a new one; both sides of the
  gate are asserted against two real servers in `tests/mcp-repair-loop.test.ts`,
  because a gate argued for in a comment is not a gate.
- **A decision that cannot be reached by a test does not belong where it is.**
  The rule for reading a runner's output first sat in `mcp-server/server.js`,
  behind a real Playwright install and a real spawn; a mutation deleting it left
  every suite green. Moving it into `core/replay` made it three inputs and an
  answer.
- **The write and the renderer are one deliverable, and there is usually more
  than one renderer.** `sourceProvenance` was made a pure function for the reason
  above, and then had exactly one call site — so a rule that was supposed to hold
  wherever a model reads a component held in `get_step_detail` and nowhere else,
  including in `get_flow`, the primary tool. Three shipped documents said
  otherwise. **Count the renderers.**

## Non-negotiables

- `src/core/` is pure — no `chrome.*`, no DOM, no `fetch`, no clock. It is
  bundled into `mcp-server/core.js` and imported by a Node process. (`core/dom`,
  `core/selector` and `core/describe` take DOM nodes as *arguments* and are not
  in `mcp-bundle.ts`; that is the line.)
- Every `chrome.*` call goes through `src/chrome/`.
- The ARKG stays additive, via the guarded `arkgTry` funnel. Nothing about the
  graph may fail a recording.
- Anything published must be in its package's `files` list — and there are
  **three** packages. `scripts/sync-version.mjs`, `scripts/cut-release.mjs` and
  `tests/versions.test.ts` all know about `compiler-plugin/`.
- Any change touching `src/` or `public/` needs a `## Unreleased` changelog entry.
- Strings obey the frozen `docs/CONTRACTS.md` §4. It is frozen — if it is wrong,
  say so; do not fix it locally. (§4.5 bans `DevFlow` **in user-facing strings**.
  A request header name is not one, but check before you assume.)
- A setting that is not in `src/features/settings/fields.ts` does not exist.
  After touching that table run `npm run build:settings` — and note that
  `tests/settings-defaults.test.ts` has a `SOURCE` table naming every field, and
  `tests/settings-advanced.test.ts` asserts **counts with the number written into
  the test name and the prose** (39 Tier 2, 23 frozen). Update the sentences, not
  just the integers.
- Comments say **why**, not what.

## How to work

- **Do not tick a checkbox unless `npm run verify` proves it** — and unless you
  have read the thing it claims. `[~]` is always available and is never a
  failure. But a `[~]` carrying a *condition* is not a decision: either meet the
  condition or write the refusal, the way 1.2 now is.
- **Do not build a module with no caller.**
- **Write tests that would fail against the bug.** Break the code the test
  covers, confirm it goes red, revert — *by restoring the text, not with git*.
  When a mutation survives, ask **where the code is** and **what the fixture
  actually distinguishes** before you ask what the assertion missed. A negative
  fixture missing the field entirely reads the same under the correct rule and
  the broken one, and proves nothing about either.
- **Measure the internals rather than reasoning about them.** React, Zustand,
  OpenTelemetry and a git repository are none of them dependencies of this repo,
  and its fixtures are hand-built for that reason. Installing what you need in a
  scratch directory and printing the real shape took ten minutes last session
  and corrected a sentence that had been in two files for two sessions. Phase 3
  touches more foreign formats than any phase so far; do this early and often.
- **A source-text test (`expect(source).toContain(...)`) is the weakest kind and
  sometimes the only kind** — `src/injected/agent.ts` registers listeners at
  import and cannot be loaded, which will matter for 3.1. When you write one,
  assert the **exact expression**, not a nearby phrase, say in the comment why it
  is one, and **strip comments before counting occurrences**.
- **Test at the layer that can lose the data, not below it.** Two by-name
  flow-level copies still silently drop new fields — `buildPayload` in
  `src/features/mcp/send.ts` and `saveFlow` in `mcp-server/server.js`. Step
  fields are spread and survive; flow-level fields are listed by name. **A
  `gitSha` on a flow is a flow-level field**, so it is exactly the shape that
  gets dropped silently. Test it from storage or from the POST, not from a
  fixture.
- **Use subagents in parallel with explicit file ownership.** Freeze the shared
  contract yourself first. Tell them not to run `verify` or `build*`.
  - **Give reviewers read-only access, or a worktree.** If you edit while a
    reviewer is running, tell it what you changed before it reports.
- **Verify their results independently.**
- Run `graphify update .` after modifying code.
- Commit on a branch and merge; never commit straight to `main`. Suggested:
  `phase-3/git-lineage` for the SHA work and 3.4.

## When you finish a work stream

Update `ROADMAP_AND_PHASES.md` in the same commit, run the full `npm run verify`
(and read its exit code), and say plainly what is shipped, what is partial and
what you chose not to build and why. If something is blocked, finish everything
else in full and name what you left out — scaling the work down is the user's
call, not yours.
