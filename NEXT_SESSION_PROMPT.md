# DevFlow — next session

Read `CLAUDE.md`, `ROADMAP_AND_PHASES.md` (start at its "Status key" section) and
`graphify-out/GRAPH_REPORT.md` before touching anything. This file is the
handoff; the roadmap is the truth about what is done.

## Where the project actually is

`main` @ the merge of `phase-2/repair-loop`, clean. `npm run verify` is green:
**132 test files, 2665 tests** (was 121 / 2406 at the start of the campaign).

> **Run `npm run verify` and read its exit code, not its tail.**
> `npm run verify 2>&1 | tail -20` reports *`tail`'s* exit code, which is always
> 0. Use `npm run verify > /tmp/v.log 2>&1; echo "EXIT=$?"` and believe the
> number.
>
> One new trap, seen this session: a stray file dropped into the repo root — an
> exported `*.spec.ts` a browser download had left there — makes `eslint .` fail
> with `parserOptions.project` and nothing else, on a tree `git status` calls
> clean. If lint fails for a file you do not recognise, look for it before you
> look at your own diff.

A previous AI ("Antygravity") built Phase 0–2 badly and it shipped as v3.2.0. An
audit found the MCP server would not boot, typecheck was red, 29 tests failed,
and 12 roadmap items were ticked for stubs, dead code, or things that actively
broke user apps. `main` was reset to v3.1.1 and only what survived audit was
carried forward. That work is on `archive/antygravity-phase-0-2` — useful as a
source of *ideas*, never of code to copy.

---

## What shipped last session

Four work streams, each of which v3.2.0 had ticked and none of which survived
its audit. Read `ROADMAP_AND_PHASES.md` §2.1, §2.2, §2.3 and §2.5 in full before
touching anything nearby — the reasoning is there, not here.

**2.1 — the recorder.** A `MutationObserver` over the whole document for the
length of each step, folded into a handful of facts and bounded by **two**
numbers because there are two costs: `recording.domMutationCap` bounds the work
and disconnects the observer, `recording.domMaxChanges` bounds the recording
after folding. Ranking is structural → text → attribute → `style`, never by
count. It sits beside `StepBase.domDelta` rather than replacing it and neither
is derivable from the other. **Periodic layout snapshots are refused**, with the
reason in the roadmap. `causedBy` stamping is refused, with the reason in the
roadmap. State changes now reach the exported Playwright/Cypress specs as
comments; a generated store reader is refused, and the generated file says why.

**2.2 — `get_value_provenance`.** A search for one value across four
independent observations of a recording, reported in the direction data flows
and repeatedly described as a search rather than a trace. The roadmap's
`domNodeId` argument does not exist and could not: a recording describes an
element and addresses none.

**2.3 — `suggest_actions`.** What people have actually done on a page, folded
across recordings. It takes **no** graph argument, because the graph holds no
selectors. **The headless replay harness is refused**, and the reason matters
for your planning: the artifact it would run already exists, what is missing is
a runner, and where that runner lives is a decision that belongs with 2.4.

**2.5 — `explain_feature`.** Lexical matching that says it is lexical matching,
expanded one hop through the graph — which is the half that reaches an endpoint
whose name carries none of your words.

**And an adversarial review of all of it found five defects, all fixed.** That
review was worth more than any of the four streams. Read the pattern rather than
the list: every one of the five was a *claim* the code did not support, not a
crash. Describing four hundred groups to print twelve was the reverted v3.2.0
cost profile relocated one function along. A `<style>` written through was
reported as content. A withheld send option was reported as a recording that
never sampled. **Run one.**

---

## Where Phase 2 stands

**Closed, but for one bullet and four halves — and every one of those is a
written refusal rather than an omission.** Eleven `[x]`, four `[~]`, one `[ ]`.
Read `ROADMAP_AND_PHASES.md` §2.1 to §2.5 in full; the reasoning is there.

The refusals, so you do not re-open them by accident:

- **Periodic layout snapshots** (2.1) — a timer reading layout forces a reflow
  on every recorded page, and a snapshot taken between steps belongs to no step.
- **`causedBy` stamping** (2.1) — 1.3 derives the chain from facts the flow
  already carries; a stamp would be a second copy, absent from every recording
  already on disk, freezing today's rules.
- **Generated store assertions in E2E specs** (2.1) — a fiber walk pasted into
  somebody's repo goes red when React moves an internal, reporting a bug in
  their app that is not there.
- **Patch generation** (2.4) — DevFlow is not a model. Everything a model needs
  to write the patch is now in place; a generator here could only be the
  template the reverted version was.

If a future session wants any of these, the argument to beat is in the roadmap,
not here.

## Your task, in order

Phase 0's three remaining items — `git_commits` nodes, the `changed_in` edge,
the `git_sha` columns — **cannot be done in this campaign at all.** They need
Phase 3's git integration. They stay `[ ]`. If you find yourself about to tick
one, you are about to repeat the exact failure that made v3.2.0 worthless.

### 1 · Work Stream 1.1 — `@devflow/compiler-plugin`

The last item left in Phases 0–2, and marked *strictly optional*. Invariant 1 is
that DevFlow needs no app changes. The risk is not that a plugin would fail —
it is that it would work **better**, making the zero-dependency path the
degraded one and losing the invariant without anyone deciding to lose it. Any
build of it starts by writing down what it may not improve.

If you conclude it should not be built, say so in the roadmap with the argument,
and Phases 0–2 are done.

### 2 · Then Phase 3

`ROADMAP_AND_PHASES.md` §3.1 onward, and it is where the three Phase 0 items
finally unblock. Note that 3.1's trace-header injection is the first thing in
this project that would **write to a page's outbound requests** — read §1.2's
header on why the state reader samples rather than intercepts before designing
it, because that argument applies here with more force, not less.

## Two things this session learned the hard way

- **`replay_flow` is the first tool that executes code.** It is off behind
  `DEVFLOW_REPLAY=1` and refuses to install anything. If you add a second such
  tool, copy that shape rather than inventing a new one; and note that both
  sides of the gate are asserted against two real servers in
  `tests/mcp-repair-loop.test.ts`, because a gate argued for in a comment is not
  a gate.
- **A decision that cannot be reached by a test does not belong where it is.**
  The rule for reading a runner's output first sat in `mcp-server/server.js`,
  behind a real Playwright install and a real spawn; a mutation deleting it left
  every suite green. Moving it into `core/replay` made it three inputs and an
  answer. When a mutation survives, ask where the code is before you ask what
  the test missed.

## Non-negotiables

- `src/core/` is pure — no `chrome.*`, no DOM, no `fetch`, no clock. It is
  bundled into `mcp-server/core.js` and imported by a Node process. (`core/dom`,
  `core/selector` and `core/describe` take DOM nodes as *arguments* and are not
  in `mcp-bundle.ts`; that is the line.)
- Every `chrome.*` call goes through `src/chrome/`.
- The ARKG stays additive, via the guarded `arkgTry` funnel.
- Anything published must be in `mcp-server/package.json` `files`.
- Any change touching `src/` or `public/` needs a `## Unreleased` changelog entry.
- Strings obey the frozen `docs/CONTRACTS.md` §4. It is frozen — if it is wrong,
  say so; do not fix it locally.
- A setting that is not in `src/features/settings/fields.ts` does not exist.
  After touching that table run `npm run build:settings` — and note that
  `tests/settings-defaults.test.ts` has a `SOURCE` table naming every field, and
  `tests/settings-advanced.test.ts` asserts **counts with the number written
  into the test name and the prose**. Both numbers were stale when this session
  found them; they are correct now (39 Tier 2, 23 frozen). Update the sentences,
  not just the integers.
- Comments say **why**, not what.

## How to work

- **Do not tick a checkbox unless `npm run verify` proves it** — and unless you
  have read the thing it claims. `[~]` is always available and is never a
  failure. Four of the sixteen bullets touched this session are refusals with
  reasons; that is the mechanism working.
- **Do not build a module with no caller.**
- **Write tests that would fail against the bug.** Break the code the test
  covers, confirm it goes red, revert. This session ran roughly ninety such
  checks across its own work and its subagents'; **five survived**, and every
  one of the five was a weak *test*, not a curiosity. Two examples worth
  carrying: a "the tool is reachable" test that called the tool but never
  checked `tools/list` was green against a tool that was never declared — the
  exact v3.2.0 bug it was written to prevent; and a tie-break test whose
  fixtures happened to sort the same way under both the correct rule and the
  broken one.
- **A source-text test (`expect(source).toContain(...)`) is the weakest kind
  and sometimes the only kind** — a content script and a service worker both
  register listeners at import and cannot be loaded. When you write one, assert
  the **exact expression**, not a nearby phrase. A grep for a comment passes
  against the deletion of the line under it.
- **Test at the layer that can lose the data, not below it.** Two by-name
  flow-level copies still silently drop new fields — `buildPayload` in
  `src/features/mcp/send.ts` and `saveFlow` in `mcp-server/server.js`. Step
  fields are spread and survive; flow-level fields are listed by name. Start in
  storage, or at the POST.
- **The write and the renderer are one deliverable.** A field no tool prints
  does not exist from outside.
- **Use subagents in parallel with explicit file ownership.** Freeze the shared
  contract yourself first — types, settings, signatures — or they will each
  guess at it. Tell them not to run `verify` or `build*`.
  - **And do not authorise a subagent to mutate-and-restore a file you are
    editing.** This session lost a wired MCP tool that way: a reviewer snapshotted
    `mcp-server/server.js`, and its restore wrote the file back to `HEAD` over an
    edit made in between. It was found only because a test that had passed
    started failing. Give reviewers read-only access, or give them a worktree.
- **Verify their results independently.** Re-run the red-checks on the claims
  that matter. Every subagent this session reported accurately — including two
  that reported their own tests as inadequate and fixed them — and the spot
  checks are what makes that knowable rather than hoped for.
- Run `graphify update .` after modifying code.
- Commit on a branch and merge; never commit straight to `main`.

## When you finish a work stream

Update `ROADMAP_AND_PHASES.md` in the same commit, run the full `npm run verify`
(and read its exit code), and say plainly what is shipped, what is partial and
what you chose not to build and why. If something is blocked, finish everything
else in full and name what you left out — scaling the work down is the user's
call, not yours.
