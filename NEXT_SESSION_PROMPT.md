# DevFlow — Phase 3, continued

Read `CLAUDE.md`, `ROADMAP_AND_PHASES.md` (start at "Status key", then read the
**Phase 3** preamble and **Work Stream 3.1** in full) and
`graphify-out/GRAPH_REPORT.md` before touching anything. This file is the
handoff; the roadmap is the truth about what is done.

## Where the project is

**You are on `main`; `phase-3/git-lineage` is merged into it. `npm run verify`
is green: 139 test files, 2922 tests.** Nothing is pushed — `main` is well ahead of `origin/main`, and pushing
has not been asked for. Do not push without being asked.

**Phases 0–2 are finished, and now genuinely so.** The three items that were
blocked on Phase 3 — `git_sha`, `git_commits`, `changed_in` — are closed. What is
left in those phases is five refusals with the argument on the record, listed at
the foot of this file.

**Phase 3 is one-fifth done.** Work Stream 3.4 is shipped. 3.1, 3.2, 3.3 and 3.5
are not started, and nothing among them is blocked by anything else.

> **Run `npm run verify` and read its exit code, not its tail.**
> `npm run verify 2>&1 | tail -20` reports *`tail`'s* exit code, which is always
> 0. Use `npm run verify > /tmp/v.log 2>&1; echo "EXIT=$?"` and believe the
> number.
>
> **Never `git checkout -- <file>` to undo a mutation you made for a red-check.**
> A checkout restores `HEAD`, not the tree, so it silently reverts any
> *uncommitted* work in that file. Snapshot the file's text and write it back —
> four lines of Python.
>
> **If you run subagents, give each a private scratch directory.** The session
> scratchpad is shared. Two agents wrote `mutate.py` to the same path last
> session, one silently executed the other's script, and its first mutation run
> read as a survival when nothing had been mutated at all.

A previous AI ("Antygravity") built Phase 0–2 badly and it shipped as v3.2.0. An
audit found the MCP server would not boot, typecheck was red, 29 tests failed,
and 12 roadmap items were ticked for stubs, dead code, or things that actively
broke user apps. `main` was reset to v3.1.1 and only what survived audit was
carried forward. That work is on `archive/antygravity-phase-0-2` — useful as a
source of *ideas*, never of code to copy.

---

## What last session built, and the four things it settled

### The commit stamp, and what it does not claim

`src/core/git/index.ts` is the pure half — the decisions — and
`mcp-server/git.js` is the spawning. Read the first file's header before
extending any of this; it carries four arguments you would otherwise have to
re-derive.

The one worth repeating here: **the stamp is the state of the checkout the
server runs in when the recording arrived, and not the build that served the
page.** Those coincide on `localhost` and are unrelated on staging.
`recordedLocally()` and `commitCaveats()` exist so that every surface printing a
commit says which of the two it is looking at. If you add a fifth surface, print
the caveats with it — the field was deliberately wired into `list_flows` (which
returns whole metas, so it came free), the `get_flow` header, `flow.md` and
`compare_flows_across_deploys`, and `get_flow_summary` was deliberately left out
because its whole budget is answering *did this break*.

**A dirty tree records the SHA on the flow and writes no `git_sha` anywhere in
the graph.** `joinableSha()` is that rule, in one expression, deliberately.

### `git` runs without `replay_flow`'s gate, and the argument is on the record

It reads, its argv is fixed, and the only non-literal argument is a commit
`isShaPrefix()` has vouched for. `DEVFLOW_GIT=0` is the inverse switch. The full
argument is at the top of `mcp-server/git.js`. **If you add a second command
there, it takes a fixed argv or a validated hex, and nothing else.**

### 3.4 is a join, not a second comparison

`compare_flows` already did the hard half. The roadmap's
`compare_flows_across_deploys(flowId, sha1, sha2)` signature does not survive
contact and the correction is in the roadmap: a flow id names one recording made
at one commit, so the tool takes a flow **name**.

The output has four sections and **three of them are observations and the fourth
is a shortlist**, which is stated in the answer in those words and asserted in
`tests/deploy.test.ts`. Do not let a later change blur that line.

### Two bugs the tests found, worth knowing about because of their shape

Both were found by mutation-testing rather than by reading, and both had passed
review:

- `unquotePath` never decoded an octal escape — `i` had already advanced past the
  backslash, so the gathering loop failed on its first test and emitted the
  digits literally. Every non-ASCII filename silently failed to match.
- `recordedLocally` tested `host === '::1'` under a comment claiming `new URL`
  strips the brackets from an IPv6 literal. It does not; `hostname` is `[::1]`,
  so the branch was dead and every IPv6 loopback recording was caveated as
  remote.

**Both were comments asserting a fact about a foreign API that nobody had run.**
Phase 3 touches more foreign formats than any phase so far. Print the real shape.

---

## Phase 3, and what to do next

### Do 3.1 next, and settle the argument before writing code

**Work Stream 3.1's header injection is the first time DevFlow would change what
the recorded app sends to its own backend.** Everything shipped so far observes.

It is *not* a new patch: `src/injected/agent.ts` already replaces `window.fetch`
and `window.XMLHttpRequest`, unconditionally, at `document_start`, on every page
the user opens — see `install()` near the foot of that file, and `patchedFetch`.
The machinery to add a header is already in the function that records one.

The hazard is CORS and it is concrete. Adding a custom request header to a
**cross-origin** request makes it a non-simple request, so the browser sends an
`OPTIONS` preflight where it previously sent none; if the backend does not name
the header in `Access-Control-Allow-Headers`, the request **fails**. That is a
working page broken by DevFlow being installed — Invariant 1, which is exactly
what got v3.2.0 reverted in a different subsystem.

Decide first, and write the decision where a test can reach it. The shape that
survives is probably *off by default, opted into, same-origin by default, and
never silently converting a simple request into a preflighted one* — but that is
a recommendation, not a finding. `X-DevFlow-Trace-Id` on `fetch` is four lines
and the reasoning around it is the whole work stream.

`traceparent` (W3C Trace Context) is a *standard* header a backend may already
accept and `X-DevFlow-Trace-Id` is bespoke. They do not carry the same risk and
must not be decided as one switch.

Note also §4.5 of the frozen `docs/CONTRACTS.md` bans `DevFlow` **in
user-facing strings**. A request header name is not one — but check rather than
assume, and `lint:brand` is the thing that will tell you.

### 3.2 and 3.3 overlap tools that already ship

Read these before designing a new tool, or you will build a second one beside a
working first — which is the mistake 3.4 was written to avoid and which this
package has already made once, with two markdown renderers.

| Roadmap asks for | What already exists | The actual gap |
| --- | --- | --- |
| **3.2** `get_full_lineage(domNodeId)` | `get_value_provenance` — the same value found across response body, store write, component and element, with the mechanism's limits stated in the reply | The backend half (controller, SQL), and only Tier 2/3 can supply it. And a recording has **no DOM node ids** — an element is described, not addressed. `domNodeId` in the roadmap is not a thing that exists. |
| **3.3** `get_living_architecture()` | `get_app_architecture` — the accumulated graph across every recording and pick | "Real-time" and "currently mounted" are the gap, and they are a **live connection to an open page**, not a graph query. A different mechanism from everything shipped so far, and worth costing before promising. |

### 3.5 is three work streams and should be planned as three

Vue 3, Svelte 5 and React Server Components do not share React's fiber tree and
nothing in `src/core/react/` transfers. Each adapter is a Phase-1-sized body of
work. Treat 3.5 as out of scope unless told otherwise, and say so rather than
starting one and leaving two.

### Tier 2 will want a setting, and the settings table is frozen at the edges

`src/features/settings/fields.ts` is the one table — a setting not in it does not
exist — but `docs/CONTRACTS.md` §3.6 enumerates the prefixes each concept owns
and **§3 and §4 are frozen**. `src/features/arkg/ingest.ts` hit exactly this and
rode the existing `mcpAutoSend` switch rather than inventing a prefix; its header
explains why that was the conservative reading rather than a way around the rule.
Do the same, or say the contract is wrong — do not fix it locally.

Note that the git work needed no setting at all: `DEVFLOW_GIT`,
`DEVFLOW_PROJECT_ROOT` and `DEVFLOW_REPLAY` are environment variables on the
*server's* own environment, deliberately, because `POST /config` is reachable by
any page the browser visits. A machine-level capability is not a setting.

---

## What is left in Phases 0–2

### Refused, with the argument on the record — 5 items

**These are done.** Each is a decision written out in `ROADMAP_AND_PHASES.md`,
not an omission. To overturn one, the argument to beat is in the roadmap.

- **Module-level Zustand stores** (1.2) — refused on measurement against React
  19.2.8 and Zustand 4.5.7/5.0.15. What a consumer's fiber offers is that
  component's *selection*; the union of selections is a fact about the route the
  recording visited. §1.2 names the evidence that would overturn it.
- **Periodic layout snapshots** (2.1) — a timer reading layout forces a reflow on
  every recorded page, and a snapshot taken between steps belongs to no step.
- **`causedBy` stamping** (2.1) — 1.3 derives the chain from facts the flow
  already carries; a stamp would be a second copy, absent from every recording
  already on disk, freezing today's rules.
- **Generated store assertions in E2E specs** (2.1) — a fiber walk pasted into
  somebody's repo goes red when React moves an internal, reporting a bug in their
  app that is not there.
- **Patch generation** (2.4) — DevFlow is not a model. Everything a model needs to
  write the patch is in place.

---

## Loose ends worth an hour, none of them blocking

- **`componentTable` in `mcp-server/server.js` is dead** — no caller. Noticed four
  sessions ago while working nearby, still not removed. Somebody should.
- **`mcp-server/arkg.js.bak` is a stale 2,000-line copy** left behind by an
  earlier session's mutation testing. It is gitignored, so it is invisible to
  every gate and to `git status`, and it is the kind of file somebody eventually
  reads by mistake. Delete it.
- **`compiler-plugin` is `private: true` and unpublished.** It has never been run
  against a real application's build. `sync-version.mjs` and
  `tests/versions.test.ts` keep it in step, so publishing is one field rather than
  a rediscovery — but the honest gate is running it against a real app once.
- **SWC is not covered and there is no port.** `@vitejs/plugin-react-swc` and
  Next.js take no Babel plugin, so the plugin serves a real but partial audience.
  The README says so rather than implying coverage.

---

## Three things earlier sessions learned the hard way

- **`replay_flow` is the first tool that executes code.** Off behind
  `DEVFLOW_REPLAY=1`, and it refuses to install anything. If you add a second such
  tool, copy that shape rather than inventing a new one; both sides of the gate
  are asserted against two real servers in `tests/mcp-repair-loop.test.ts`,
  because a gate argued for in a comment is not a gate. **`mcp-server/git.js` is
  deliberately not that shape, and its header says why** — reflex, not judgement,
  is what would have put it behind the same switch.
- **A decision that cannot be reached by a test does not belong where it is.**
  The rule for reading a runner's output first sat in `mcp-server/server.js`,
  behind a real Playwright install and a real spawn; a mutation deleting it left
  every suite green. Moving it into `core/replay` made it three inputs and an
  answer. `core/git` and `core/deploy` are the same split for the same reason.
- **The write and the renderer are one deliverable, and there is usually more
  than one renderer.** `sourceProvenance` was made pure and then had exactly one
  call site, so a rule that was supposed to hold wherever a model reads a
  component held in `get_step_detail` and nowhere else. **Count the renderers.**
  The commit stamp has four and they were counted on purpose; the fifth is yours.

## Non-negotiables

- `src/core/` is pure — no `chrome.*`, no DOM, no `fetch`, no clock, **and no
  `node:` imports**. `core/git`'s `readCheckout` takes `relative` as an argument
  for exactly that reason. It is bundled into `mcp-server/core.js` and imported
  by a Node process. (`core/dom`, `core/selector` and `core/describe` take DOM
  nodes as *arguments* and are not in `mcp-bundle.ts`; that is the line.)
- Every `chrome.*` call goes through `src/chrome/`.
- The ARKG stays additive, via the guarded `arkgTry` funnel. Nothing about the
  graph may fail a recording — **and nothing about `git` may either**, which is
  what `gitTry` is.
- Anything published must be in its package's `files` list — and there are
  **three** packages. `scripts/sync-version.mjs`, `scripts/cut-release.mjs` and
  `tests/versions.test.ts` all know about `compiler-plugin/`.
- Any change touching `src/` or `public/` needs a `## Unreleased` changelog entry.
- Strings obey the frozen `docs/CONTRACTS.md` §4. It is frozen — if it is wrong,
  say so; do not fix it locally.
- A setting that is not in `src/features/settings/fields.ts` does not exist.
  After touching that table run `npm run build:settings` — and note that
  `tests/settings-defaults.test.ts` has a `SOURCE` table naming every field, and
  `tests/settings-advanced.test.ts` asserts **counts with the number written into
  the test name and the prose**. Update the sentences, not just the integers.
- Comments say **why**, not what.

## How to work

- **Do not tick a checkbox unless `npm run verify` proves it** — and unless you
  have read the thing it claims. `[~]` is always available and is never a failure.
  But a `[~]` carrying a *condition* is not a decision: either meet the condition
  or write the refusal.
- **Do not build a module with no caller.**
- **Write tests that would fail against the bug.** Break the code the test covers,
  confirm it goes red, revert — *by restoring the text, not with git*. When a
  mutation survives, ask **where the code is** and **what the fixture actually
  distinguishes** before you ask what the assertion missed. Last session ran
  twenty-one mutations across four files; one survived, and the honest answer was
  that the decision lived one function away and *was* covered.
- **Measure the internals rather than reasoning about them.** Git is not a
  dependency of this repo. Ten minutes building throwaway repositories in a
  scratch directory settled the four repository states, the merge-commit file
  list and the exact `git status --porcelain --branch` shapes before a line of
  parser was written, and every one of them is now a fixture built from real
  output.
- **A source-text test (`expect(source).toContain(...)`) is the weakest kind and
  sometimes the only kind** — `src/injected/agent.ts` registers listeners at
  import and cannot be loaded, which **will matter for 3.1**. When you write one,
  assert the **exact expression**, not a nearby phrase, say in the comment why it
  is one, and **strip comments before counting occurrences**.
- **Test at the layer that can lose the data, not below it.** Two by-name
  flow-level copies still silently drop new fields — `buildPayload` in
  `src/features/mcp/send.ts` and `saveFlow` in `mcp-server/server.js`. Step fields
  are spread and survive; flow-level fields are listed by name. `git` is a
  flow-level field and is tested from the POST and from the graph, never from a
  fixture written onto disk. Do the same for the next one.
- **Use subagents in parallel with explicit file ownership.** Freeze the shared
  contract yourself first, tell them not to run `verify` or `build*`, and give
  each one a **private** scratch directory.
  - **Verify their results independently.** Last session two agents reported four
    source bugs between them; all four were real, and one of them was a
    regression the parent had just introduced.
- Run `graphify update .` after modifying code.
- Commit on a branch and merge; never commit straight to `main`. Suggested:
  `phase-3/trace-headers` for 3.1.

## When you finish a work stream

Update `ROADMAP_AND_PHASES.md` in the same commit, run the full `npm run verify`
(and read its exit code), and say plainly what is shipped, what is partial and
what you chose not to build and why. If something is blocked, finish everything
else in full and name what you left out — scaling the work down is the user's
call, not yours.
