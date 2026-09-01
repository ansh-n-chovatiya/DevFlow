# DevFlow — next session

Read `CLAUDE.md`, `ROADMAP_AND_PHASES.md` (start at its "Status key" section) and
`graphify-out/GRAPH_REPORT.md` before touching anything. This file is the
handoff; the roadmap is the truth about what is done.

## Where the project actually is

`main` @ the merge of `phase-1/render-blame`, clean. `npm run verify` is green:
**121 test files, 2406 tests**.

> **Run `npm run verify` and read its exit code, not its tail.**
> `npm run verify 2>&1 | tail -20` reports *`tail`'s* exit code, which is always
> 0. Use `npm run verify > /tmp/v.log 2>&1; echo "EXIT=$?"` and believe the
> number. It has already produced two false "green" readings in this campaign.

A previous AI ("Antygravity") built Phase 0–2 badly and it shipped as v3.2.0. An
audit found the MCP server would not boot, typecheck was red, 29 tests failed,
and 12 roadmap items were ticked for stubs, dead code, or things that actively
broke user apps. `main` was reset to v3.1.1 and only what survived audit was
carried forward. That work is on `archive/antygravity-phase-0-2` — useful as a
source of *ideas*, never of code to copy.

---

## What shipped last session

**The two unverified Phase 0 items were audited and both now tick.** Each
survived the hard question and each turned out to be one defect lighter.

`caused_by` projects honestly — a link reaches the graph only when *both* ends
land on a node the ARKG keys stably, a console entry projects onto nothing and
its links are dropped rather than given an invented node, and neither the
self-loop nor the component↔endpoint pair (which is `calls` drawn twice from one
fact) is written. The defect: the projection is many-to-one, so a response
echoed into two keys of one store was counted as two observations of one edge,
contradicting the rule stated in `ingestFlow`'s own comment. Fixed with a
per-flow dedupe on the full edge identity.

`getAnomalies` is a real per-entity σ baseline and does not dress a threshold as
one — failure rate keeps `basis: 'threshold'` and says so in words. The defect:
`getAnomalyReport` existed precisely so "not enough observations" and "nothing is
wrong" could be told apart, and the MCP tool was still calling the bare array
while hedging in prose that it could not tell which it held. The tool now spends
`examined` and `tooNew`.

**Work Stream 1.4 shipped in full.** Render blame is sampled off the two
readings 1.2 already takes — nothing is installed on the page — and the
"Autopilot" bullet shipped narrowed to wasted-render detection, which is what
two readings can carry. Read `ROADMAP_AND_PHASES.md` §1.4 for the whole of it
before touching anything nearby.

---

## Your task, in order

Phase 0's three remaining items — `git_commits` nodes, the `changed_in` edge,
the `git_sha` columns — **cannot be done in this campaign at all.** They need
Phase 3's git integration. They stay `[ ]`. If you find yourself about to tick
one, you are about to repeat the exact failure that made v3.2.0 worthless. Say
the item is Phase-3-blocked and move on.

### 1 · Work Stream 2.1 — Time-travel recorder 2.0

Three open bullets, and they are not equally ready.

**DOM MutationObserver deltas and periodic layout snapshots.** *The landmine:*
the reverted attempt pushed every mutation on the whole document, unbounded and
unthrottled, into an array with no cap. **Design the budget before the
implementation** — what is observed, what is dropped, what the cap is, and what
the recording says when the cap bites. `src/injected/render.ts` is now the
closest pattern: a bounded walk, gated on recording, that reports the fact it
was cut. Note that `StepBase.domDelta` already exists and is something *else* —
the text of the region around the touched element, before and after. Do not
conflate them, and say plainly how the new thing relates to it.

**All events carry `causedBy` references.** Unblocked but narrower than it
reads: 1.3 derives the chain at read time, so what is left is the decision to
*stamp* it at capture. That is worth doing only if something needs it before the
flow reaches a reader — and nothing does yet. The honest move is probably to
leave it and write why into the roadmap.

**State assertions from before/after store diffs** (the E2E compiler's last
bullet). Unblocked by 1.2 but not built. It needs a decision about which of a
patch's operations are worth asserting on, which is a question about a real
app's patches and not one to answer from a fixture.

### 2 · Then, in dependency order

- **2.2 — Provenance engine** (`get_value_provenance`). *The landmine:* the
  previous one was unreachable dead code. Wire the tool first and let it fail
  honestly, then fill it in.
- **2.5 — NL navigator** (`explain_feature`). Needs only the ARKG. *The
  landmine:* the previous one was stopword-matching substring filtering dressed
  as understanding. If what you build is lexical matching, the tool description
  must say it is lexical matching.
- **2.3 — Sandbox execution.** *The landmine:* the previous generator returned
  hardcoded buttons and ignored the ARKG argument it was given. If the generator
  cannot use the graph yet, it takes no graph argument.
- **2.4 — Closed-loop repair.** Last: it needs 1.3 and 2.3 both, and it is the
  item most likely to be faked under time pressure.
- **1.1 — `@devflow/compiler-plugin`.** Marked *strictly optional*. Last of all.
  Invariant 1 is that DevFlow needs no app changes; a plugin must never become
  the path that works properly.

---

## Non-negotiables

- `src/core/` is pure — no `chrome.*`, no DOM, no `fetch`, no clock. It is
  bundled into `mcp-server/core.js` and imported by a Node process.
- Every `chrome.*` call goes through `src/chrome/`.
- The ARKG stays additive, via the guarded `arkgTry` funnel.
- Anything published must be in `mcp-server/package.json` `files`.
- Any change touching `src/` or `public/` needs a `## Unreleased` changelog entry.
- Strings obey the frozen `docs/CONTRACTS.md` §4. It is frozen — if it is wrong,
  say so; do not fix it locally. §3.6 enumerates the settings prefixes each group
  owns, which is why state capture and render sampling are both under
  `recording.` rather than prefixes of their own.
- A setting that is not in `src/features/settings/fields.ts` does not exist.
  After touching that table run `npm run build:settings` — and note that
  `tests/settings-defaults.test.ts` has a `SOURCE` table naming every field, and
  `tests/settings-advanced.test.ts` asserts **counts with the number written into
  the test name and the prose**. Update the sentences, not just the integers.
- Comments say **why**, not what.

## How to work

- **Do not tick a checkbox unless `npm run verify` proves it** — and unless you
  have read the thing it claims. That habit is what made the previous attempt
  worthless. `[~]` is always available and is never a failure.
- **Do not build a module with no caller.** If the thing that would consume it
  does not exist yet, say so and defer, with the reasoning written into the
  roadmap rather than left implicit.
- **Write tests that would fail against the bug.** After writing a test, break
  the code it covers and confirm it goes red, then revert. A test that passes
  against both the correct code and the obvious defect is worse than no test,
  because it reports safety.
- **Test at the layer that can lose the data, not below it.** There are now
  **two** by-name flow-level copies that silently drop new fields — `buildPayload`
  in `src/features/mcp/send.ts` and `saveFlow` in `mcp-server/server.js`. Both
  have already eaten a shipped feature once (`state` last session; `renders`
  would have been next). Steps are spread and survive; flow-level fields are
  listed by name and do not. A test that hands the renderer a fixture passes
  against both bugs — start in storage, or at the POST.
- **The write and the renderer are one deliverable.** A field no tool prints does
  not exist from outside. This failure has now happened three times:
  `subscribes_to`, `topStateKeys`, and `moreChanges` last session.
- **Use subagents in parallel with explicit file ownership**, tell them not to
  run `verify` or `build*` concurrently, and have them report bugs in files they
  do not own rather than fixing them. **Freeze the shared contract yourself
  first** — types, settings, function signatures — or they will each guess at it.
- **Verify their results independently.** A plausible report can still be wrong.
  Last session one subagent's own test *asserted the defect that same subagent
  had reported in its summary*, and it was green. Re-run their red-checks
  yourself on the claims that matter.
- Run `graphify update .` after modifying code.
- Commit on a branch and merge; never commit straight to `main`.

## When you finish a work stream

Update `ROADMAP_AND_PHASES.md` in the same commit, run the full `npm run verify`
(and read its exit code), and say plainly what is shipped, what is partial and
what you chose not to build and why. If something is blocked, finish everything
else in full and name what you left out — scaling the work down is the user's
call, not yours.
