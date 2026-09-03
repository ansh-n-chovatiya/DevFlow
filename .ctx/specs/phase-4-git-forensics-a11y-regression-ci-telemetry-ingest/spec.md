---
ctx_schema: 1
spec: phase-4-git-forensics-a11y-regression-ci-telemetry-ingest
status: done
created: 2026-09-03
verify:
  - kind: cmd
    run: npm run verify
---

## Intent
Build Phase 4 as the costed subset — 4.3 Git Forensics, 4.6 Accessibility
Autopilot, 4.4 Autonomous Regression Watcher, 4.1a production telemetry webhook
ingestion — in that order, and close the remaining three boxes (4.1b Production
Time Capsule, 4.2 VS Code extension, 4.5 self-healing fix bot) as argued
deferrals rather than leaving them unticked with no argument beside them.

Scope confirmed by the user on 2026-09-03, against a costing of all six work
streams. The ordering is this repository's own habit and was argued, not
incidental: **cheapest join onto existing data first, new mechanism later** —
the sequence that made 3.4, then 3.1, then 3.2 go well. 4.3 is a join onto
`changed_in`, `git_commits` and per-node `git_sha`, all of which shipped in
Phase 3. 4.6 is a new bounded page-side read, which is 3.3's pattern exactly.
4.4 is a new *process* — something that runs in CI, outside a browser — which is
the first thing in this product that is neither. 4.1a is a new inbound wire from
a third party, which is the first thing that ingests data DevFlow did not
observe itself.

## Baseline
`main`, working tree clean but for two journal files. `npm run verify` **EXIT=0**
read as `$?` directly — 147 test files, 3271 tests. Eleven-plus commits ahead of
`origin/main` and unpushed; pushing has not been asked for.

## Acceptance criteria

### Cross-cutting — every unit
1. `npm run verify` exits 0, read as `$?` directly and never through a pipe.
   `${PIPESTATUS[0]}` is empty in this repo's zsh; the array is `$pipestatus[1]`.
2. Every decision is made in `src/core/` and is pure — no `chrome.*`, no DOM, no
   `fetch`, no clock, no `node:` import — and survives `npm run build:mcp`. DOM
   access lives in `src/injected/`, `chrome.*` in `src/chrome/`, everything
   impure in `src/features/`.
3. No new setting exists outside `src/features/settings/fields.ts`, and
   `npm run build:settings` has been run and its output committed.
4. `CHANGELOG.md` carries an `## Unreleased` entry for every change touching
   `src/` or `public/` (`lint:changelog`).
5. Work lands on a branch and is merged. `main` is not committed to directly.
6. No module ships without a caller, and **no field ships without a renderer**:
   a value no surface prints does not exist from outside. `getBlastRadius` is
   the standing example of that failure and criterion 12 repays it.
7. `ROADMAP_AND_PHASES.md` boxes are ticked only for what the gate proves. Any
   roadmap wording that does not survive contact is corrected **in the roadmap**
   with the finding written out — the `get_full_lineage(domNodeId)`,
   `compare_flows_across_deploys` and `get_living_architecture` precedent, which
   is now three signatures in a row that assumed a caller could address
   something it cannot.
8. No second MCP tool is built beside an existing one answering the same
   question. Either the boundary is stated in both tools' descriptions, or there
   is one tool. This repo made the two-markdown-renderers mistake once and
   `src/core/mcp-bundle.ts` exists because of it.

### Unit A — Work Stream 4.3, Git Forensics & Blame Intelligence
9. Given a component or source file the ARKG has observed, DevFlow answers
   **which commits changed it, when, and who authored them**, drawn from the
   `changed_in` edges and `git_commits` nodes already in the graph.
10. The answer **states its own coverage** and does not present a partial join as
    a complete one. `changed_in` is drawn only onto source files the graph has
    already seen code run in, and `git_sha` is written only from a clean working
    tree — so a deploy touching forty files may have three edges. Three is the
    honest number and the answer says which of the two it is reporting.
11. **No cause is named.** `changed_in` crossed with an anomaly is a
    correlation: the commit that last touched a file is not thereby the commit
    that broke it. `diagnose_failure` names no cause for the same reason and is
    the shape to copy. A tool that ranks candidates must say what the ranking is
    made of, per candidate, the way the cascade's edges say what evidence they
    rest on.
12. `getBlastRadius` — built in `mcp-server/arkg.js`, tested in
    `tests/arkg.test.ts`, and reachable from **nothing**: no MCP tool, no UI, no
    caller in `src/` — gains a reader. This is the 4.2 half that is already
    built, and closing it is why 4.2's IDE half can be deferred without leaving
    the capability unbuilt.

### Unit B — Work Stream 4.6, Accessibility Autopilot
13. A page-side a11y reading exists, is **bounded by a cap** and takes samples at
    the points the recorder already samples — it does not poll, does not
    subscribe, and **installs nothing on the page**. `src/injected/state.ts`'s
    refusal holds unviolated; it is not maintained, it is unviolatable.
14. The reading costs nothing when nobody is recording, and the <2% CPU /
    <15MB heap NFR is not argued about but **measured**, with the number written
    down.
15. Every violation carries the **WCAG criterion it fails** and the **component
    and source line** it was found in, through the attribution path that already
    exists. A violation with no criterion is a complaint, not an audit.
16. Focus-trap and keyboard-navigation findings rest on **two samples** (the
    recorder's existing in-click and after-settle pair) rather than on one, and
    a finding that needs a third sample is named as a gap rather than guessed.
17. **No fix is generated.** The roadmap's "generate a targeted fix" does not
    survive ADR 0009: DevFlow is not a model, and the caller is. The violation,
    the criterion and the line are the deliverable; the roadmap wording is
    corrected under criterion 7.

### Unit C — Work Stream 4.4, Autonomous Regression Watcher (CI)
18. A recorded flow can be re-run outside a browser session, from CI, against a
    checkout of the application — and the **semantic diff** it produces names
    what changed beyond pass/fail: re-render counts, request latencies, and the
    state sequence.
19. **What a pass proves is stated on every run.** `core/replay` answers with the
    responses the *recording* captured, so a fault living in the server is mocked
    out of the run by construction. If a live mode is added, the two modes are
    named separately and a report says which it is. `no-tests` and `unreadable`
    are not degraded `passed` — that rule in `src/core/replay/index.ts` extends
    to every new verdict this unit adds.
20. A GitHub Action exists that runs the check. **Posting to a PR is
    outward-facing and is opt-in**, never the default, and the action's output is
    readable without it — the trace-header precedent (ADR 0010): what DevFlow
    *writes down* and what it *sends* are two different switches.
21. Which files in the PR the report implicates is drawn from the ARKG's own
    knowledge of which files code has run in, and says how many of the PR's
    changed files it has never seen — that gap is what this knows and
    `git log --name-only` does not.

### Unit D — Work Stream 4.1a, Production Telemetry Ingestion
22. The MCP server accepts crash events from at least one production error
    service on a dedicated route, **JSON only and off by default** — the OTLP
    receiver precedent, ADR 0011 — and refuses any request carrying a web page's
    `Origin`, as every existing route does.
23. A production stack frame is matched to a source file through
    `matchSourceFile` in `src/core/git` — exactly after normalisation, or by a
    suffix that exactly one known file answers, and **never by a guess**. Two
    files ending `src/index.ts` in a monorepo is where a suffix rule is a coin
    toss.
24. A production-observed failure is **distinguishable in the graph from one
    DevFlow observed itself**. `frequency` counts recordings; a webhook event is
    not a recording, and merging the two silently would make every existing
    number mean something new. Either it is a separate property, or it is a
    separate node kind, and the choice is written down.
25. **A crash payload is somebody's production user data.** Its handling is
    decided explicitly and stated in the README, at least to the standard the
    existing "captured bodies are not redacted" paragraph sets. Nothing is
    ingested by default.

### Unit E — the three closures
26. §4.1b (session-replay ingestion → Playwright + HAR mocks) is recorded as the
    **Production Time Capsule**, deferred to Phase 5, with an ADR. VISION §7.3
    and §9 already scope it as Long-Term; the roadmap should not imply otherwise.
27. §4.2 (VS Code extension) is deferred with an ADR that names what it would
    cost — a fourth package, published, plus the one direction the server still
    cannot address — and points at criterion 12 as the half that shipped anyway.
    The `@devflow/compiler-plugin` precedent is the argument: it is
    `private: true` and unpublished precisely because it has never run against a
    real application's build.
28. §4.5 (self-healing fix bot) is closed by **holding ADR 0009**, in the
    roadmap's own voice, pointing at it. It is a decision, not a `[~]` carrying
    a condition — the shape §1.2, §2.1 and §3.5 were each resolved into.
29. `README.md`'s Phase 4 row and the roadmap's Phase 4 preamble both say what
    was built and what was refused, in the same commit as the work.

## Out of scope
- **Work Stream 4.1b** — session-replay ingestion, HAR mocks, Docker sandbox
  reproduction. Deferred under criterion 26.
- **Work Stream 4.2's IDE half** — the VS Code extension and any persistent
  server -> tab channel. Deferred under criterion 27. The blast-radius query
  gets a reader under criterion 12; the editor does not.
- **Work Stream 4.5** — patch generation and in-memory patch application. Held
  refused under ADR 0009, criterion 28.
- **Phase 5 anything** — team ARKG, counterfactual replay, prop-drilling
  eliminator, the Vue/Svelte/Angular/RSC adapters (already deferred there by
  ADR 0017).
- **Pushing to `origin`.** Eleven-plus commits are already ahead and unpushed.
  Pushing has not been asked for and is not assumed here.

## Units and ownership
Disjoint file sets, because that is what makes this L2 rather than one long L1.
No unit edits another's files; the shared files at the bottom are merged by
whoever lands last, deliberately.

| Unit | Work stream | Owns |
| --- | --- | --- |
| **A** | 4.3 Git forensics | `src/core/git/`, a new `src/core/forensics/`, `mcp-server/arkg.js` read paths, the new tool(s) in `mcp-server/server.js`, `tests/forensics*.test.ts` |
| **B** | 4.6 A11y autopilot | `src/injected/a11y.ts`, `src/core/a11y/`, the recorder's sample points in `src/features/recording/`, `tests/a11y*.test.ts` |
| **C** | 4.4 Regression watcher | `src/core/replay/` extensions, a CI entry point, `.github/workflows/` or `.github/actions/`, `tests/regression*.test.ts` |
| **D** | 4.1a Telemetry ingest | a new route block in `mcp-server/server.js`, `src/core/telemetry/`, the ARKG write path for production observations, `tests/telemetry*.test.ts` |
| **E** | the closures | `.ctx/decisions/0018-0020`, `ROADMAP_AND_PHASES.md` §4, `README.md` Phase 4 row |

**Shared, and therefore contended:** `src/features/settings/fields.ts` and its
generated `public/settings.default.json`, `CHANGELOG.md`,
`ROADMAP_AND_PHASES.md`, `mcp-server/server.js`'s tool declaration block. A unit
touching one of these says so before it starts.

## Notes

**Two findings from the costing, carried in so they are not re-derived.**

- `getBlastRadius` exists in `mcp-server/arkg.js` with tests in
  `tests/arkg.test.ts` and **no reader at all**. Half of 4.2's "Live
  Blast-Radius Preview" has been built since Phase 0 and is invisible from
  outside the process. Criterion 12.
- 4.5 as the roadmap words it contradicts ADR 0009 *directly* — not adjacently.
  An accepted ADR is overturned by a superseding ADR or not at all, and the user
  chose to hold it.

**The habit that made Phases 1-3 good, restated because it will matter most in
Units C and D: measure the foreign thing rather than reasoning about it.** A
two-origin Playwright probe settled the CORS rule; a throwaway
`@opentelemetry/sdk-trace-node` service settled four wire facts of which three
would have been got wrong by reasoning; throwaway git repositories settled 3.4's
parser; printing `core/causal`'s real event ref settled the cascade in minutes
after reasoning had produced a picture that looked entirely reasonable and was
wrong. Playwright 1.62.1 with real Chromium is reachable from this machine out of
the npx cache (`find ~/.npm/_npx -path '*node_modules/playwright/index.js'`).
Unit D should print a real Sentry webhook payload before designing against one.

**Unit C's first hour should settle what a CI run actually runs against**, and
by measurement. `core/replay` writes a Playwright spec and reads its JSON report,
and it replays *recorded* responses — which is fine for "does the journey still
complete" and useless for "did this PR's backend change break it". Whether 4.4
needs a live mode is the question that decides how big Unit C is, and it should
be answered before the unit is sized rather than during it.

**Unit B's cap is a real decision, not a constant.** `recording.renderNodeCap`
bounds the render walk and `architecture` reuses it. Whether an a11y walk shares
that cap or needs its own is a settings-table question, and the table is the only
place it can be answered.

**Unit A's honesty problem is the interesting one.** Everything in it is a join
onto data that is already correct, so the way it fails is not a wrong number —
it is a *confident* number over a partial graph. Criteria 10 and 11 exist
because a regression-bisect answer that does not state its coverage reads
exactly like one that does.

## Outcome (2026-09-03)

Shipped and merged. `npm run verify` **EXIT=0** — 156 test files, 3437 tests, up
from 147/3271 at the baseline. Four units built, three closures written, five
branches merged into `main`.

**Unit A — 4.3 git forensics** (`958f0db`, merge `8606515`). `get_commit_candidates`
and `get_blast_radius`. Two roadmap promises did not survive: there is no PR
number anywhere in this system, and `changed_in` alone answers "one commit" where
git answers "thirty", because `arkg_git_commits` gains a row only when a recording
arrives at that commit. **The ordering finding came from measurement**: this was
built to compare commit dates and the first end-to-end run refuted it — `%ct` has
one-second resolution, so the sighting and the change that followed it read one
date and the tie resolved to the reassuring answer. The walk is `--topo-order` and
position places a commit; dates are the fallback and the answer says which it used.
`getBlastRadius` had been built, tested and reachable from nothing since Phase 0.

**Unit B — 4.6 accessibility** (`d32c299`, merge `6566748`). Eight checks, six from
the settled page and two from the sample pair. **Measured in real Chromium**: the
settled walk is 4.9ms median on a 2107-element page at the 1500 cap, the in-gesture
reading is under a microsecond, and 542 of 1500 elements had no resolvable backdrop
— so the refusal to guess one is about a third of the page, not an edge case. Off
by default from that measurement. "Continuously audit" and "generate a targeted
fix" are both corrected in the roadmap.

**Unit C — 4.4 regression watcher** (`bec7ff6`, merge `f3a98be`). **The mode design
came from a measurement too**: `launchPersistentContext` with `--load-extension`
registers DevFlow's service worker in a headed Chromium and registers nothing in
Playwright's headless one, so re-render counts and state sequence are refused with
a reason rather than faked. Mocked mode compares no wire at all — it would measure
its own fixtures. A run it could not read is `inconclusive`, which outranks
`regressed`.

**Unit D — 4.1a crash ingest** (`2fdf26f`, merge `6556c5a`). **The fourth
reachability finding**: Sentry cannot reach a loopback port, so this takes a
relayed or replayed delivery and says so. It is the one piece of Phase 4 built
against a documented shape rather than a measured one, and the roadmap names that
risk. Almost nothing from a payload is kept, and the tests assert each absence.

**Unit E — the closures.** ADR 0018 (Time Capsule → Phase 5), ADR 0019 (the VS Code
extension, with its query shipped without it), ADR 0020 (holding ADR 0009 against
the self-healing bot). Roadmap §4.2, §4.5 and the Phase 4 preamble carry all three
in the roadmap's own voice.

**Fifteen mutations were run across the four units and every one killed the suite.**

**Two defects the criteria caught at the end, both real.** `normalisedFiles` shipped
with no caller and is deleted. And the MCP server's a11y step part had grown its
own copy of `renderA11y`'s grouping — the two-markdown-renderers mistake that
`src/core/mcp-bundle.ts` exists because of. The server now owns only `where`
(resolving a component id against the recording, which `core/` has no flow to do)
and calls the one renderer; `tests/mcp-a11y.test.ts` kills the mutation that
un-does it.

**Left undone, deliberately and named in the roadmap:** Datadog and Bugsnag
parsers (one provider done properly beats three unverified), an extension-observed
CI run (needs a display), and the three closures above.
