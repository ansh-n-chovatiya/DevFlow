# DevFlow — starting a session

Read [`CLAUDE.md`](CLAUDE.md), then `graphify-out/GRAPH_REPORT.md`, then run
`/ctx:resume` — or `/ctx:load devflow-state` when you want the whole picture
rather than the last few days of it. `phase-3-remaining` is the bundle for what
Phase 3 still owes.

**This file used to be the handoff, and is not one any more.** It carried branch
state, what the last session built and what to do next — all of which now live in
`.ctx/`, the roadmap and the changelog. A second copy here is exactly the failure
this repository names as its own (two markdown renderers that disagreed, which is
why `src/core/mcp-bundle.ts` exists), and it had already happened: the copy went
stale announcing 3.2 as next after 3.2 shipped. What is left is only what none of
those places holds — how to work here without repeating a mistake already paid
for.

## Where the durable state is

| Question | Where it is answered |
| --- | --- |
| What is done, what is refused, and the argument for each | `ROADMAP_AND_PHASES.md` — the roadmap is the truth about what is built |
| What changed and how it reads to a user | `CHANGELOG.md`, under `## Unreleased` |
| What was decided and why, one decision per file | `.ctx/decisions/` — immutable; supersede, never edit |
| What the project state is, portably | `.ctx/contexts/devflow-state`, `.ctx/contexts/phase-3-remaining` |
| What happened recently | `.ctx/journal/`, `/ctx:status` |
| Where the code is and what touches what | `graphify-out/GRAPH_REPORT.md` |
| Why a module is shaped the way it is | its own file header — `src/core/otel/index.ts`, `src/core/trace/index.ts`, `mcp-server/otel.js` are the dense ones |

Branch state is a question for `git`, never for a paragraph someone wrote last
week: `git status`, `git log --oneline -10` and
`git rev-list --count origin/main..main`. Do not push unless asked.
`archive/antygravity-phase-0-2` is a previous AI's Phases 0–2, reset off `main`
after an audit found stubs and 12 ticked items that did not work — a source of
*ideas*, never of code to copy.

## Traps that have already cost this project time

- **Run `npm run verify` and read its exit code, not its tail.**
  `npm run verify 2>&1 | tail -20` reports *`tail`'s* status, which is always 0.
  **`${PIPESTATUS[0]}` does not save you** — this shell is zsh, where the array is
  `$pipestatus[1]` and the bash spelling expands silently to the empty string.
  Use `npm run verify > /tmp/v.log 2>&1; echo "EXIT=$?"` and believe the number.
  A green gate that proved nothing looks exactly like a green gate.
- **Never `git checkout -- <file>` to undo a mutation you made for a red-check.**
  A checkout restores `HEAD`, not the tree, so it silently reverts every
  *uncommitted* change in that file — including the work you are in the middle
  of. Snapshot the text and write it back.
- **`git diff --stat <path>` proves nothing about a file git is not tracking.**
  It is empty for an untracked file and for a perfectly restored one, and the two
  are indistinguishable; a whole new directory is untracked until its first
  commit, so the obvious restoration check passes vacuously. **Compare checksums
  against your snapshot instead.** This was caught by a subagent auditing its own
  report, not by the parent that asked for it.
- **A `shasum` restore is right for your own mutation and wrong the moment
  somebody else has touched the file.** Restoring writes back the bytes you
  snapshotted, so any edit that landed in between — a parallel agent's, an
  editor's, your own from another branch of the work — is silently overwritten
  and the checksum still matches, because it is matching the wrong baseline.
  Snapshot immediately before mutating, restore immediately after, and never
  restore a file another agent may have written to since you took the snapshot.
- **A surviving mutation is a question, not a verdict.** When you break the code
  a test covers and the test stays green, ask **where the decision actually
  lives** and **what the fixture distinguishes** before you ask what the
  assertion missed. The last survivor found this way was a pure short-circuit
  whose real decision was two lines away; the finding was worth more than a new
  assertion, and it is now a comment naming the load-bearing line.
- **Measure the foreign format rather than reasoning about it.** Every wire fact
  this project got wrong, it got wrong by reasoning; each was settled in ten
  minutes by printing the real shape from a throwaway repository, exporter or
  browser. An unmeasured claim you have *named* is a known gap; one you have not
  named is a belief.

## Subagents

The parallel-agent pattern is this repo's most productive one, and is L2 in
ledger terms. What makes it work:

- **Freeze the shared contract yourself first** — a typechecking module and a
  written interface, not a description of one.
- **Disjoint file ownership, stated per agent.** Tell them not to run `verify` or
  `build*`; those are yours.
- **Give each agent a private scratch directory.** The session scratchpad is
  shared, and two agents writing one probe file is a debugging session nobody
  budgeted for.
- **Ask them to report what they notice in files they do not own, and forbid them
  from touching those files.** That single instruction produced the three best
  findings of one session, none of which the owning agent could have found — and
  one agent correcting the parent's own verification method, which was worth more
  than any of them.
- **Verify their results independently.** Re-run their suites and run your own
  mutations; a mutation report is a claim, not evidence.

## Constraints that `CLAUDE.md` does not already spell out

- `src/core/` is pure — and that includes **no `node:` imports**. (`core/dom`,
  `core/selector` and `core/describe` take DOM nodes as *arguments* and are not in
  `mcp-bundle.ts`; that is the line.)
- The ARKG stays additive through the guarded `arkgTry` funnel, and nothing about
  the graph, `git` or `otel` may fail a recording — that is what `gitTry` and
  `otelTry` are for.
- Anything published must be in its package's `files` list, and there are
  **three** packages; `scripts/sync-version.mjs`, `scripts/cut-release.mjs` and
  `tests/versions.test.ts` all know about `compiler-plugin/`.
- **A machine-level capability is not a setting.** `DEVFLOW_GIT`,
  `DEVFLOW_REPLAY`, `DEVFLOW_OTEL` and `DEVFLOW_PROJECT_ROOT` are environment
  variables on the server's own environment, because `POST /config` is reachable
  by any page the browser visits.

## How to work

- **Do not tick a roadmap checkbox unless `npm run verify` proves it**, and
  unless you have read the thing it claims. `[~]` is always available and is
  never a failure — but a `[~]` carrying a *condition* is not a decision: meet
  the condition or write the refusal.
- Do not build a module with no caller, and do not build a second tool beside one
  that already answers the question.
- Write tests that would fail against the bug; run `graphify update .` after
  modifying code; commit on a branch and merge, never straight to `main`.
- When you finish a work stream, update `ROADMAP_AND_PHASES.md` in the same
  commit, record the decisions behind it with `/ctx:decide`, run the full
  `npm run verify` and read its exit code, and say plainly what shipped, what is
  partial, and what you chose not to build and why. If something is blocked,
  finish everything else in full and name what you left out — scaling the work
  down is the user's call, not yours.
