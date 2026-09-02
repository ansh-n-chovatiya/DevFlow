# DevFlow — next session

Read `CLAUDE.md`, `ROADMAP_AND_PHASES.md` (start at its "Status key" section) and
`graphify-out/GRAPH_REPORT.md` before touching anything. This file is the
handoff; the roadmap is the truth about what is done.

## Where the project actually is

**You are on `main`, working tree clean, `npm run verify` green: 135 test files,
2753 tests.** `phase-1/compiler-plugin` is merged. Nothing is pushed — `main` is
ahead of `origin/main` and pushing has not been asked for.

> **Phases 0–2 are finished.** Everything in them that can be completed is
> completed. What remains is three items that genuinely need Phase 3's git
> integration and five refusals with the argument on the record — the inventory
> is under "What is left in Phases 0–2" below, and it is exhaustive.
>
> **So Phase 3 starts.** That is this session's work, and nothing gates it.

> **Run `npm run verify` and read its exit code, not its tail.**
> `npm run verify 2>&1 | tail -20` reports *`tail`'s* exit code, which is always
> 0. Use `npm run verify > /tmp/v.log 2>&1; echo "EXIT=$?"` and believe the
> number.
>
> **And never `git checkout -- <file>` to undo a mutation you made for a
> red-check.** A checkout restores `HEAD`, not the tree, so it silently reverts
> any *uncommitted* work in that file. Snapshot the file's text and write it
> back. There is a working harness at four lines of Python; this session used
> one and it ran seventeen mutations without incident.

A previous AI ("Antygravity") built Phase 0–2 badly and it shipped as v3.2.0. An
audit found the MCP server would not boot, typecheck was red, 29 tests failed,
and 12 roadmap items were ticked for stubs, dead code, or things that actively
broke user apps. `main` was reset to v3.1.1 and only what survived audit was
carried forward. That work is on `archive/antygravity-phase-0-2` — useful as a
source of *ideas*, never of code to copy.

---

## What shipped last session

### The six review findings on Work Stream 1.1, all closed

The adversarial review of the compiler-plugin branch left six findings
deliberately unfixed. Each is now closed, and three of them were sentences in
shipped documents that were untrue until they were.

1. **Rule 3 held in one MCP renderer out of three.** `sourceProvenance` had a
   single call site, in `get_step_detail`. `get_flow` is the primary tool and it
   returns the `## React components` table from `src/core/export/markdown.ts` —
   which is also what `flow.md` holds on disk and what the extension's Markdown
   and ZIP exports write. A model read `| Cart | src/Cart.tsx:12 | |` and could
   not tell. The Notes cell carries it now, and so does the heading
   `get_source_snippet` prints above the lines it read: the one tool that turns
   an attribution into the *contents* of a file. `ROADMAP_AND_PHASES.md` §1.1
   rule 3, the changelog and `compiler-plugin/README.md` are all corrected.
2. **`mergeComponents` allows exactly one upgrade**, `debug-source` → `plugin`,
   because a content script re-injected after a navigation re-captures a
   component from scratch and would otherwise freeze it at the parent's file
   while the panel showed the component's own. A stamp still may not overwrite a
   bundle search; nothing may overwrite a stamp. The cap is tested only for a
   *new* id, or an upgrade would both be refused and write a cap notice on the
   strength of a component already counted in the number that tripped it.
3. **`dependency` is set on both resolved branches of `table.ts`.** The
   `debug-source` branch had the same gap and had always had it; both are fixed,
   because fixing one leaves `table.ts` and `locate.ts` disagreeing about the
   other and that is the panel-versus-flow contradiction the shared precedence
   exists to prevent.
4. **The README's ESM-only note is inside the Babel-config instruction** it
   invalidates rather than two sections below it.
5. **The `build stamp` and `dev build` tooltips say *source*, not "location"** —
   CONTRACTS §4.1's Not column. Checked over every label `viaLabel` can produce,
   with whole-word matching, so the next tooltip cannot inherit the word the way
   this one did. (`original source` is the resolver's own vocabulary and a
   substring match calls it a violation; it is not one.)
6. **Class components are stamped**, in all three binding shapes, plus the
   `declare class` and lowercase refusals. A class component's fiber `type` is
   the class itself and a class is a function object, so this is an addition to
   `stampsFor`, not a second mechanism.

### Work Stream 1.2: the module-level Zustand store, refused on measurement

This was `[~]`, "deferred on a condition — it waits for a mechanism with a
stable identity". A condition nobody has re-examined is not a decision, so it
was examined: React 19.2.8, Zustand 4.5.7 and 5.0.15, three consumers of one
module-level store, in a throwaway sandbox rather than by reasoning about React.

**One thing the old sentence had wrong.** It said the store's "only identity is
a function reference that does not survive a reload". The `useSyncExternalStore`
hook's `queue.getSnapshot` is indeed Zustand's per-consumer closure and not
`api.getState` — but the **effect hook after it carries `deps: [api.subscribe]`**,
which is the store's own function and is one reference across every consumer of
it. Consumers *can* be grouped. (Zustand 4 additionally leaks `api.getState`
through the shim's `useMemo` deps; Zustand 5, the current major, does not.)

**Grouping does not unblock it, and that is what decides it.** What can be read
is the union of the *selections* of whichever components happened to be mounted
— a fact about the route the recording visited. A key leaves that union when its
component unmounts, so a diff emits a `remove` for a change the store never
made; and the shape it presents, which is what `labelFor` keys a
cross-recording name on, differs between two recordings of one store. That is
the `state_keys` node the v3.2.0 audit deleted.

What would overturn it is written down so the next attempt need not rediscover
it: a mechanism yielding the store *object*, recognisable by its methods before
anything is called. Subscribing produces one, and subscribing is writing to the
page.

`tests/state-reader.test.ts` carries the measured hook shape as a fixture and
asserts it yields no store — two of those four tests pass trivially today,
because nothing in `state.ts` reads a hook list, and the comment says so. They
exist to go red when somebody starts reading one. A mutation that does exactly
that turns three of them red.

### On the tests

**Seventeen mutations were run against the new tests; all seventeen died.** The
two that matter as method: `sourceProvenance` was mutated to label *every* path,
which is the mutation that survived last session because the negative fixture
had no `via` at all — both new negative fixtures carry `via: 'bundle-search'` on
purpose and both caught it. And the "someone starts reading hook lists" mutation
against `state.ts` is what makes the 1.2 characterisation tests worth having.

---

## What is left in Phases 0–2

Nothing that can be done. The list is exhaustive — every unticked box in all
three phases.

### Blocked on Phase 3 — 3 items, Phase 0

Pick them up **inside** the Phase 3 git pass rather than as a separate errand
afterwards.

- `git_commits` nodes
- the `changed_in` edge
- `git_sha` — the columns exist and are always NULL

### Refused, with the argument on the record — 5 items

**These are done.** Each is a decision written out in `ROADMAP_AND_PHASES.md`,
not an omission. If you want to overturn one, the argument to beat is in the
roadmap — but read it first.

- **Module-level Zustand stores** (1.2) — new this session, and the only one of
  the five that names the evidence that would overturn it.
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

---

## Loose ends worth an hour, none of them blocking

- **`componentTable` in `mcp-server/server.js` is dead** — no caller. Noticed two
  sessions ago while working nearby, still not removed. Somebody should.
- **`compiler-plugin` is `private: true` and unpublished.** It has never been run
  against a real application's build. `sync-version.mjs` and
  `tests/versions.test.ts` keep it in step, so publishing is one field rather
  than a rediscovery — but the honest gate on publishing it is running it
  against a real app once.
- **SWC is not covered and there is no port.** `@vitejs/plugin-react-swc` and
  Next.js take no Babel plugin, so the plugin serves a real but partial
  audience. The README says so rather than implying coverage.

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
  answer. `sourceProvenance` is a pure function in `src/core/react/attribution.ts`
  for the same reason — and this session's lesson is the other half of it: a pure
  function with one call site is a decision that holds in one renderer.

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
  failure. But a `[~]` carrying a *condition* is not a decision: either meet the
  condition or write the refusal, the way 1.2 now is.
- **Do not build a module with no caller.**
- **Write tests that would fail against the bug.** Break the code the test
  covers, confirm it goes red, revert — *by restoring the text, not with git*.
  When a mutation survives, ask **where the code is** and **what the fixture
  actually distinguishes** before you ask what the assertion missed. A negative
  fixture that is missing the field entirely reads the same under the correct
  rule and the broken one, and proves nothing about either.
- **Measure the internals rather than reasoning about them.** React and Zustand
  are not dependencies of this repo, and the state reader's fixtures are
  hand-built for exactly that reason. Installing both in a scratch directory and
  printing the real hook chain took ten minutes and corrected a sentence that
  had been in the roadmap and in `src/injected/state.ts` for two sessions.
- **A source-text test (`expect(source).toContain(...)`) is the weakest kind
  and sometimes the only kind** — `src/injected/agent.ts` registers listeners at
  import and cannot be loaded. When you write one, assert the **exact
  expression**, not a nearby phrase, and say in the comment why it is one. And
  **strip comments before counting occurrences**.
- **Test at the layer that can lose the data, not below it.** Two by-name
  flow-level copies still silently drop new fields — `buildPayload` in
  `src/features/mcp/send.ts` and `saveFlow` in `mcp-server/server.js`. Step
  fields are spread and survive; flow-level fields are listed by name.
- **The write and the renderer are one deliverable.** A field no tool prints
  does not exist from outside. This was written down in the last handoff, was
  still missed, and is finding 1 above. Count the renderers.
- **Use subagents in parallel with explicit file ownership.** Freeze the shared
  contract yourself first. Tell them not to run `verify` or `build*`.
  - **Give reviewers read-only access, or a worktree.** And if you edit while a
    reviewer is running, tell it what you changed before it reports.
- **Verify their results independently.**
- Run `graphify update .` after modifying code.
- Commit on a branch and merge; never commit straight to `main`.

## When you finish a work stream

Update `ROADMAP_AND_PHASES.md` in the same commit, run the full `npm run verify`
(and read its exit code), and say plainly what is shipped, what is partial and
what you chose not to build and why. If something is blocked, finish everything
else in full and name what you left out — scaling the work down is the user's
call, not yours.
