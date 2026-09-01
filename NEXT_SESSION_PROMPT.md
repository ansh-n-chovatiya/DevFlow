# DevFlow — next session

Read `CLAUDE.md`, `ROADMAP_AND_PHASES.md` (start at its "Status key" section) and
`graphify-out/GRAPH_REPORT.md` before touching anything. This file is the
handoff; the roadmap is the truth about what is done.

## Where the project actually is

**You are on branch `phase-1/compiler-plugin`, eight commits ahead of `main`,
working tree clean, `npm run verify` green: 135 test files, 2732 tests** (was
132 / 2665 at the start of the session).

**The branch is not merged.** That is the first decision of the next session —
see "Stop here and decide" below.

> **The standing instruction for this session: finish everything that can be
> finished in Phases 0–2 before starting Phase 3.** The full inventory of what
> that means — 7 items open and unblocked, 3 genuinely blocked on Phase 3, 4
> refused on the record — is under "The rule for the next session" below. Read
> that section before planning anything.

> **Run `npm run verify` and read its exit code, not its tail.**
> `npm run verify 2>&1 | tail -20` reports *`tail`'s* exit code, which is always
> 0. Use `npm run verify > /tmp/v.log 2>&1; echo "EXIT=$?"` and believe the
> number.
>
> **And never `git checkout -- <file>` to undo a mutation you made for a
> red-check.** A checkout restores `HEAD`, not the tree, so it silently reverts
> any *uncommitted* work in that file. This session did that to itself twice —
> once losing a real fix and once making two red-checks meaningless, because the
> "broken" code they were testing was also missing the fix. Snapshot the file's
> text and write it back; there is a working harness in the history of this
> session's approach, and the shape is four lines of Python.

A previous AI ("Antygravity") built Phase 0–2 badly and it shipped as v3.2.0. An
audit found the MCP server would not boot, typecheck was red, 29 tests failed,
and 12 roadmap items were ticked for stubs, dead code, or things that actively
broke user apps. `main` was reset to v3.1.1 and only what survived audit was
carried forward. That work is on `archive/antygravity-phase-0-2` — useful as a
source of *ideas*, never of code to copy.

---

## What shipped this session: Work Stream 1.1, `@devflow/compiler-plugin`

Phase 1's last open bullet. **Read `ROADMAP_AND_PHASES.md` §1.1 in full before
touching anything nearby** — the rule, the five clauses, the precedence argument
and every refusal are there, not here.

The short version:

- **`compiler-plugin/`** — a third package at the repo root, mirroring
  `mcp-server/`. A Babel plugin that emits
  `try { Cart.__devflow = { f: "src/Cart.tsx", l: 12 }; } catch {}` after each
  component at module scope. Development builds only by default.
- **`src/core/react/stamp.ts`** — `readStamp`, pure, validates hard, never
  throws.
- **Precedence is stamp → `debugSource` → needle**, in `table.ts` (recorder) and
  `locate.ts` (picker), plus `classifyPicked`, `rowBadge` and `observationFor`.
- **`ComponentSource.via` gained `'plugin'`**; the panel spells it `build stamp`
  and so does `get_step_detail`, through the new pure `sourceProvenance()`.
- **`private: true`, not published.** It has never been run against a real
  application's build. `sync-version.mjs` and `tests/versions.test.ts` keep it in
  step so publishing later is one field, not a rediscovery.

### Step 0 was the point, and it did its job

The rule was written before the first line of plugin code and shipped in the
same commit. Writing it honestly immediately cost something: **the proposed
first clause is false.** *"It may not produce an answer the standalone path
cannot"* — a bundle with no source map is `no-map` forever and the stamp
resolves it. What can be held is that it may not produce a *kind* of answer the
standalone path cannot. That correction is recorded in §1.1 rather than quietly
dropped, and it is the reason the rule is worth having.

### What the review found, and what it says about the work

**An adversarial review of the whole branch found eleven things. Three were
serious, and all three were claims the code did not support** — the same pattern
the last session recorded. Read them, because two of them are about *tests*:

1. **`readStamp` threw on a throwing `f`/`l` getter** while its header said
   nothing there could throw. The `try` covered the `__devflow` read but not the
   payload destructure. A throw escapes `describeEntry` into the agent's
   interaction listener, so the step records **no component chain at all**,
   silently, for the life of the page. The covering test only trapped
   `__devflow` itself — it passed against the exact bug it read as preventing.
2. **The plugin stamped a wrapper around a *name*.** `memo(SomeLibraryIcon)`
   put a stamp naming the consumer's file on an object React names after the
   library's function, so DevFlow would report a library component as living in
   your `src/` — resolved, `via: 'plugin'`, ahead of `_debugSource` and instead
   of a bundle search. It would also have refuted the argument for putting the
   stamp first: it is a position in the parent's file after all. Only a wrapper
   whose component is written *inside* it is stamped now.
3. **Rule 3 held for a person and not for a model.** `via` had never been
   rendered by any MCP tool, for any path. Fixed for `get_step_detail`; **still
   open for `get_flow`** — see below.

Two more, found by reading my own comments rather than by the review:

- **The `describeEntry` cache dropped a wrapper-borne stamp.** The comment said
  "it is a property of the function, so one reading of it is every reading of
  it", which is false where the stamp sits on a `forwardRef`/`memo` wrapper:
  `identifyComponent` builds an entry whose `type` *is* the function. A
  component seen first as a context subscriber cached an empty stamp.
- **A frozen target would have thrown at import.** A module is strict code, so a
  wrapper handing back a frozen object would have taken somebody's development
  build down with a stack pointing at code they did not write. The assignment is
  in a `try` now — and **the first version of that test passed with the guard
  removed**, because `runInNewContext` evaluates a *script* and a sloppy script
  fails silently exactly where a module throws. It evaluates in strict mode now.

**Roughly forty mutations were run against this branch. Two survived**, and
neither was a curiosity: one was the POSIX-separator conversion, which no test
on a POSIX machine can reach (replaced with an exact-expression source
assertion that says why it is one); the other was a `sourceProvenance` that
labels every path, which survived because the negative fixture had **no `via` at
all** and so read identically under the correct rule and the broken one.

---

## Stop here and decide: merge, or finish the review first

`npm run verify` is green and the branch is coherent as it stands. **Six review
findings are deliberately not fixed yet.** None of them breaks anything; each is
a claim that overreaches or a small gap. They are listed most-worth-doing first.

Finish them on this branch and merge, or merge now and take them as their own
branch — either is fine, but **all six are closed before Phase 3 starts**, and
three of them are sentences in shipped documents that are untrue until they are.
Merging and forgetting is the one option that is not open.

1. **(HIGH) Rule 3 still fails in `get_flow`.** `sourceProvenance` has exactly
   one call site (`mcp-server/server.js`, in `stepParts`). It is **not** used in
   `appendComponents` (`src/core/export/markdown.ts:339`) — the `## React
   components` table, whose own comment calls it *"the one place a component's
   source is written down"*, and which is what `get_flow` returns by default,
   what `flow.md` on disk holds, and what the extension's own Markdown/ZIP
   export writes — nor in `get_component_source` (`mcp-server/server.js` ~4789).
   So a model calling `get_flow`, the primary tool, reads
   `| Cart | src/Cart.tsx:12 | |` and cannot tell. **Three documents overclaim
   until this is done**: `ROADMAP_AND_PHASES.md` §1.1 rule 3, the `## Unreleased`
   changelog entry, and `compiler-plugin/README.md`. Fix the code or narrow all
   three sentences; do not leave them as they are.
2. **(MEDIUM) `mergeComponents` never upgrades `debug-source` → `plugin`.**
   `src/core/react/table.ts:81` — `if (table[component.id]) continue;`, first
   answer wins, justified by *"a later click on the same component learns
   nothing about where it lives."* That is no longer strictly true: a component
   first captured without a stamp (a re-injected content script after
   navigation resets `componentCache`) is frozen at `via: 'debug-source'` with
   the parent's file, while the panel shows the component's own file — the exact
   panel-versus-flow contradiction the shared precedence exists to prevent. The
   narrow fix is to allow **one** upgrade, `debug-source` → `plugin`, and
   nothing else; do not let a stamp overwrite a resolved bundle-search answer.
   Or leave the behaviour and make the header honest. Either, not neither.
3. **(LOW) The stamp branch in `table.ts` omits `dependency`.**
   `src/ui/locator/locate.ts` sets both `absolutePath` and `dependency` for
   identical input; `table.ts` sets only the first. So a stamped `node_modules`
   path in a recording is never flagged, `pickOwner` can name it as a step's
   owner, and the review view renders no `node_modules` tag. §1.1 rule 1 says
   "same shape". Note the `debug-source` branch beside it has the same gap and
   has always had it — decide whether to fix one or both, and say which.
4. **(LOW) `compiler-plugin/README.md` "Anything else that runs Babel"** tells
   people to add the package to a `plugins` list, two sections above the note
   that it is ESM-only and a CommonJS `babel.config.js` cannot `require()` it.
   Those two should be one paragraph.
5. **(LOW) The `build stamp` tooltip in `src/ui/components/result-card.ts` uses
   "location"**, which `docs/CONTRACTS.md` §4.1 lists in the *Not* column for
   **source**. The pre-existing `dev build` tooltip has the same wording, so this
   is drift rather than a regression — but the new string did not have to
   inherit it. §4 is frozen; if it is wrong, say so, do not fix it locally.
6. **(LOW) Class components are not stamped.** Named as a gap in the README on
   purpose. `class Cart extends React.Component` is a real shape and adding it
   is a small change to `stampsFor`. It was left out because the handoff's list
   did not include it, not because it is hard.

The review also confirmed, independently, that the stamp survives the wire —
`buildPayload`, `pruneComponents` and `saveFlow` copy `ComponentSource` by
reference, so nothing drops `stamp` or `via` — and that `Pos0`/`Pos1` is clean
throughout the branch, with `pos1(l)` in `stamp.ts` a genuine edge assertion
guarded by an integer check.

---

## The rule for the next session: finish Phases 0–2 before starting Phase 3

**Everything that *can* be completed between Phase 0 and Phase 2 is completed
before Phase 3 begins.** Not "mostly", and not "except the small ones". The
inventory below is exhaustive — every unticked box in all three phases, sorted
by whether anything can be done about it — so the decision is which of these to
close, not which to go looking for.

Phase 3 starts when the "open and unblocked" list is empty and the branch is
merged. Nothing else gates it.

### Open, unblocked, and therefore yours — 7 items

**Six are the review findings on this branch**, listed with their reasoning
under "Stop here and decide" above. They are the bulk of the remaining work and
three of them are sentences in shipped documents that are currently untrue.

**The seventh is the only unticked roadmap bullet in Phases 0–2 that is neither
blocked nor refused:**

- **1.2 — module-level Zustand stores.** `[~]` today. Redux, TanStack Query and
  React Context are read in full; Zustand only when the store arrives through a
  context. A module-level `create()` store is reachable in principle — a
  consumer has a `useSyncExternalStore` hook holding a `getSnapshot` — but what
  comes back is that component's *selection*, not the store, and its only
  identity is a function reference that does not survive a reload. A
  `state_keys` node keyed on that accumulates one row per recording and answers
  nothing, which is the exact shape the `v3.2.0` audit deleted.

  It is deferred **on a condition** — "it waits for a mechanism with a stable
  identity" — not refused. So this one needs a real attempt: either find that
  mechanism and ship it, or write the refusal properly, with the argument, the
  way the four in Phase 2 are written. A `[~]` that nobody has re-examined is
  not the same thing as a decision. **Do not leave it as it is.**

### Blocked on Phase 3 — 3 items, Phase 0

These genuinely cannot be done first; they need the git integration Phase 3
builds. They stay `[ ]`, and they are the one legitimate reason to touch Phase 3
work at all before the list above is empty.

- `git_commits` nodes
- the `changed_in` edge
- `git_sha` — the columns exist and are always NULL

Pick them up **inside** the Phase 3 git pass rather than as a separate errand
afterwards.

### Refused, with the argument on the record — 4 items, Phase 2

**These are done.** Each is a decision written out in `ROADMAP_AND_PHASES.md`
§2.1 to §2.5, not an omission, and "complete everything completable" does not
mean re-opening them. If you want to overturn one, the argument to beat is in
the roadmap — but read it first.

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

### The tally

| | Phase 0 | Phase 1 | Phase 2 |
| --- | --- | --- | --- |
| Open and unblocked | — | 1 (`1.2` Zustand) | — |
| Blocked on Phase 3 | 3 | — | — |
| Refused, on the record | — | — | 4 |

Plus the six review findings, which belong to 1.1 and are not roadmap bullets.

Everything else across all three phases is `[x]` and proved by `npm run verify`.

---

## Two things earlier sessions learned the hard way

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
  answer. This session hit the same thing and did the same thing:
  `sourceProvenance` is a pure function in `src/core/react/attribution.ts`
  rather than a condition inside `server.js`, which nothing typechecks.

## Non-negotiables

- `src/core/` is pure — no `chrome.*`, no DOM, no `fetch`, no clock. It is
  bundled into `mcp-server/core.js` and imported by a Node process. (`core/dom`,
  `core/selector` and `core/describe` take DOM nodes as *arguments* and are not
  in `mcp-bundle.ts`; that is the line.)
- Every `chrome.*` call goes through `src/chrome/`.
- The ARKG stays additive, via the guarded `arkgTry` funnel.
- Anything published must be in its package's `files` list — and there are
  **three** packages now. `scripts/sync-version.mjs`, `scripts/cut-release.mjs`
  and `tests/versions.test.ts` all know about `compiler-plugin/`.
- Any change touching `src/` or `public/` needs a `## Unreleased` changelog entry.
- Strings obey the frozen `docs/CONTRACTS.md` §4. It is frozen — if it is wrong,
  say so; do not fix it locally.
- A setting that is not in `src/features/settings/fields.ts` does not exist.
  After touching that table run `npm run build:settings` — and note that
  `tests/settings-defaults.test.ts` has a `SOURCE` table naming every field, and
  `tests/settings-advanced.test.ts` asserts **counts with the number written
  into the test name and the prose** (39 Tier 2, 23 frozen). Update the
  sentences, not just the integers.
- Comments say **why**, not what.

## How to work

- **Do not tick a checkbox unless `npm run verify` proves it** — and unless you
  have read the thing it claims. `[~]` is always available and is never a
  failure.
- **Do not build a module with no caller.** (`componentTable` in
  `mcp-server/server.js` has none — it is dead. Noticed while working nearby,
  not removed, because deleting it was not this session's job. Somebody should.)
- **Write tests that would fail against the bug.** Break the code the test
  covers, confirm it goes red, revert — *by restoring the text, not with git*.
  Three separate tests on this branch passed against the exact bug they were
  written to prevent, and each was found by mutation rather than by reading.
  When a mutation survives, ask **where the code is** and **what the fixture
  actually distinguishes** before you ask what the assertion missed.
- **A source-text test (`expect(source).toContain(...)`) is the weakest kind
  and sometimes the only kind** — `src/injected/agent.ts` registers listeners at
  import and cannot be loaded. When you write one, assert the **exact
  expression**, not a nearby phrase, and say in the comment why it is one. And
  **strip comments before counting occurrences**: a count on this branch caught
  its own prose as an instance of the thing it was counting.
- **Test at the layer that can lose the data, not below it.** Two by-name
  flow-level copies still silently drop new fields — `buildPayload` in
  `src/features/mcp/send.ts` and `saveFlow` in `mcp-server/server.js`. Step
  fields are spread and survive; flow-level fields are listed by name.
- **The write and the renderer are one deliverable.** A field no tool prints
  does not exist from outside. That is finding 1 above, and it was missed on the
  first pass despite being written down here.
- **Use subagents in parallel with explicit file ownership.** Freeze the shared
  contract yourself first. Tell them not to run `verify` or `build*`.
  - **Give reviewers read-only access, or a worktree.** And if you edit while a
    reviewer is running, tell it what you changed before it reports — this
    session's reviewer re-verified its whole report against the moved tree when
    asked, and excluded two findings that had been fixed underneath it.
- **Verify their results independently.** Every one of the eleven findings this
  session's reviewer reported was real and reproducible.
- Run `graphify update .` after modifying code.
- Commit on a branch and merge; never commit straight to `main`.

## When you finish a work stream

Update `ROADMAP_AND_PHASES.md` in the same commit, run the full `npm run verify`
(and read its exit code), and say plainly what is shipped, what is partial and
what you chose not to build and why. If something is blocked, finish everything
else in full and name what you left out — scaling the work down is the user's
call, not yours.
