# DevFlow — Phase 3, continued

Read `CLAUDE.md`, `ROADMAP_AND_PHASES.md` (start at "Status key", then read the
**Phase 3** preamble and **Work Stream 3.2** in full) and
`graphify-out/GRAPH_REPORT.md` before touching anything. This file is the
handoff; the roadmap is the truth about what is done.

## Where the project is

**You are on `main`; `phase-3/git-lineage` is merged into it. `npm run verify`
is green: 142 test files, 3019 tests.** Nothing is pushed — `main` is well ahead of `origin/main`, and pushing
has not been asked for. Do not push without being asked.

**Phases 0–2 are finished, and now genuinely so.** The three items that were
blocked on Phase 3 — `git_sha`, `git_commits`, `changed_in` — are closed. What is
left in those phases is five refusals with the argument on the record, listed at
the foot of this file.

**Phase 3: 3.4 is shipped, 3.1's Tier 1 is shipped, and 3.2, 3.3 and 3.5 are not
started.** 3.1's Tier 2 — ingesting OpenTelemetry spans — is the one piece of a
started work stream left undone, and it was left deliberately: it is an endpoint,
a wire format this repo has never parsed and a set of graph edges, and it is
worth costing on its own rather than being finished in the tail of the work
stream that unblocked it. Nothing among the rest is blocked by anything else.

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

## What the last two sessions built

### Work Stream 3.1 — the trace header, and the six refusals that make it safe

**This is the first thing DevFlow does that is not observation**, so read
`src/core/trace/index.ts`'s header before touching any of it. The rule was
written before the first line of injector code and it is a pure module three
inputs can be handed, for exactly the reason `core/replay` is.

The short version: off by default; only while a flow is recording; same-origin
freely; cross-origin only for an origin the user named; never over a
`traceparent` the page already set; never by rebuilding a `Request` that carries
a body; and a fresh id per request. `traceparent` and `X-DevFlow-Trace-Id` are
two switches because they carry different risk in both directions.

**The one thing that was not measured, and should be.** The claim the whole work
stream rests on — that adding a non-safelisted header to a cross-origin request
makes the browser preflight it, and that a backend which does not allow the
header fails the request — was verified only as far as `curl` reaches, because
the Chrome extension was not connected. The design does not depend on it (the
rule is safe whether or not the preflight fails), but **nobody has watched Chrome
do it**. If you have a browser to hand, it is a ten-minute experiment: two local
origins, a page on one fetching the other with and without the header, and the
API allowing the header on one path and not the other. That is worth doing before
Tier 2 is built on top of it.

**A pre-existing bug this work surfaced, and its shape is the lesson.** A reused
`XMLHttpRequest` never cleared its recorded request headers on `open()`, so the
second request through one instance — which is how every long-poll and retry loop
is written — was recorded carrying the first one's. It was found only because a
stale `traceparent` in that list made the second request refuse itself as already
traced. The `loadend` listener a few lines away already carries a comment about a
*different* bug of the same shape. **Instance reuse is this file's blind spot.**

### Work Stream 3.4, and the four things it settled

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

### Do 3.1's Tier 2, or 3.2 — and 3.2 is the cheaper of the two

**Tier 2 is ingesting OpenTelemetry spans**, which is what turns the header
already going out into the FE → BE → DB chain the roadmap promises. It is a
receiver endpoint, a parser for the OTLP wire format, and `calls` edges in the
ARKG. Two things to settle before writing any of it: whether spans arrive by
push (a collector exporter pointed at this server) or by pull, and what happens
to a span whose trace id matches no recording — the `caused_by` rule says both
ends must project onto a node the graph already keys, and a span from a request
DevFlow never saw has only one end.

Note the header is only useful to Tier 2 if the backend records the trace, which
is why `traceparent`'s sampled flag is `01` — and why turning it on costs the
user money on their own observability bill. That is on the record in
`core/trace`'s header; do not quietly re-decide it.

**3.2's frontend half is cheaper and is mostly honesty work** — see the table
below. `get_value_provenance` already finds one value across four layers; what
it cannot do is say anything about the backend, and saying *that* clearly is most
of the remaining work until Tier 2 exists.

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

- **`componentTable` in `mcp-server/server.js` is dead** — no caller. Noticed five
  sessions ago while working nearby, still not removed. Somebody should. (The
  stale `mcp-server/arkg.js.bak` that sat beside it is gone.)
- **Every call in the flow review draws four `.call__panel` elements, two of them
  permanently empty.** `src/viewer.html`'s `<template id="tpl-call">` already
  ships `data-panel="request"` and `data-panel="response"` placeholders, and
  `buildCall` appends its own two into `.call__panels` rather than filling those.
  Harmless on screen, because the CSS keys off `data-active` — but it is a trap
  for a test: a naive `querySelector('.call__panel[data-panel="request"]')`
  silently matches the empty one and passes against a renderer printing nothing.
  `tests/trace-render.test.ts` selects `[data-active]` and says why.
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
- **Vitest reads the `@vitest-environment` directive from anywhere in the file,
  comments included.** Writing it inside a doc comment to explain why a file does
  *not* use jsdom silently switches jsdom on. It cost an agent a debugging cycle.
- **`src/injected/agent.ts` *can* be loaded, and a source-text test over it is
  almost never the right answer.** Earlier handoffs said it could not, and that
  was wrong: `tests/agent-network.test.ts` and `tests/agent-trace.test.ts` both
  import it under jsdom, having installed their stubs for `fetch` and
  `XMLHttpRequest` **before** the import, because the agent binds whatever is
  there at load. Drive it with a `MessageEvent` carrying `source: window` and
  `origin: window.location.origin` — a bare `postMessage` supplies neither and
  the agent's control guard silently drops it, which reads exactly like a
  feature that does not work. A behavioural test over what the stub received is
  worth many source-text tests: two of this work stream's bugs were invisible to
  reading and obvious to a stub.
- **Test at the layer that can lose the data, not below it.** Two by-name
  flow-level copies still silently drop new fields — `buildPayload` in
  `src/features/mcp/send.ts` and `saveFlow` in `mcp-server/server.js`. Step fields
  are spread and survive; flow-level fields are listed by name. `git` is a
  flow-level field and is tested from the POST and from the graph, never from a
  fixture written onto disk. Do the same for the next one.
- **Use subagents in parallel with explicit file ownership.** Freeze the shared
  contract yourself first, tell them not to run `verify` or `build*`, and give
  each one a **private** scratch directory.
  - **Verify their results independently.** Across the last two sessions six
    agents reported nine source findings; every one was real, one was a
    regression the parent had just introduced, and one was a wrong claim in a
    comment that read as a safety guarantee. Two agents also flagged that they
    had *loosened* a check — both were right to, and both said so unprompted,
    which is the behaviour to keep asking for.
- Run `graphify update .` after modifying code.
- Commit on a branch and merge; never commit straight to `main`. Suggested:
  `phase-3/otel-ingest` for 3.1's Tier 2, or `phase-3/lineage` for 3.2.

## When you finish a work stream

Update `ROADMAP_AND_PHASES.md` in the same commit, run the full `npm run verify`
(and read its exit code), and say plainly what is shipped, what is partial and
what you chose not to build and why. If something is blocked, finish everything
else in full and name what you left out — scaling the work down is the user's
call, not yours.
