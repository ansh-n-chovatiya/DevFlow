# DevFlow — next session

Read `CLAUDE.md`, `ROADMAP_AND_PHASES.md` (start at its "Status key" section) and
`graphify-out/GRAPH_REPORT.md` before touching anything. This file is the
handoff; the roadmap is the truth about what is done.

## Where the project actually is

`main` @ the merge of `phase-1/causal-threading`, clean. `npm run verify` is
green: **115 test files, 2314 tests**.

> **Run `npm run verify` and read its exit code, not its tail.**
> `npm run verify 2>&1 | tail -20` reports *`tail`'s* exit code, which is always
> 0. Two "green" readings last session were false because of exactly this. Use
> `npm run verify > /tmp/v.log 2>&1; echo "EXIT=$?"` and believe the number.

A previous AI ("Antygravity") built Phase 0–2 badly and it shipped as v3.2.0. An
audit found the MCP server would not boot, typecheck was red, 29 tests failed,
and 12 roadmap items were ticked for stubs, dead code, or things that actively
broke user apps. `main` was reset to v3.1.1 and only what survived audit was
carried forward. That work is on `archive/antygravity-phase-0-2` — useful as a
source of *ideas*, never of code to copy.

---

## Your task, in order

### 1 · Audit the two unverified items — do this first

Two pieces of work are on `main`, green, and **deliberately not ticked**. They
were written by a subagent whose session was held before it delivered its
report, so the code exists and the reasoning behind its two hardest judgement
calls does not. `ROADMAP_AND_PHASES.md` Work Stream 0.1 marks both `[~]` with
"**Audit before ticking**".

**`caused_by` edges** (`ingestCausal` in `mcp-server/arkg.js`, edge type
`caused_by:<basis>:<confidence>`). The question to answer: the causal links are
between *events inside one recording* — `net:3.1`, `log:3.2` — and those refs
are meaningless in a graph that accumulates across recordings, exactly as
`StateStoreRef.id` was. So the edge has to join nodes the graph already keys
stably: components, api_endpoints, source_files, state_stores, state_keys.
Check which links it projected, and whether any class of link was made to fit by
inventing a node or by a cross-product. A console entry in particular maps to
nothing stable at all — check what it did about that. An edge nobody observed,
sitting beside edges somebody did, is the failure that got the whole phase
reverted last time.

**`getAnomalies` on a >2σ baseline** (same file). It computes σ over each
entity's own timing window, which is a real baseline. The question: failure rate
has no per-entity distribution, only a rolling scalar, and a σ test needs a
distribution. Check that a threshold is not being *presented* as a baseline, and
that "not enough observations" is still distinct from "nothing is wrong" — the
old tool got that right and it must not have been lost.

Then either tick both, or tick what survives and say in one sentence which half
did not and why. `[~]` is always available and is never a failure.

### 2 · Then Phase 0 is as complete as it can be

After that audit, only three Phase 0 items remain and **none of them can be done
in this campaign at all**: `git_commits` nodes, the `changed_in` edge, and the
`git_sha` columns all need Phase 3's git integration. They stay `[ ]`. If you
find yourself about to tick one, you are about to repeat the exact failure that
made v3.2.0 worthless. Say the item is Phase-3-blocked and move on.

### 3 · Then continue the phase order

The remaining open work, in dependency order:

- **1.4 — "Why did this render?"** Render blame evaluator; render performance
  autopilot. *The landmine:* the reverted attempt walked the whole fiber tree on
  every commit, on every page, gated on nothing, against the <2% CPU NFR, while
  computing two reference-equality booleans and no actual blame — and nothing
  consumed the output. **Gated on recording, bounded per commit, and something
  reads the result before you write the producer.** `src/injected/state.ts` is
  the pattern to copy: it samples on a gesture, discovers on a timer, and is
  provably inert when idle.
- **2.1 — Time-travel recorder 2.0.** DOM MutationObserver deltas and periodic
  layout snapshots. The two other bullets are now *unblocked but not built*, and
  the roadmap says what each has become. *The landmine:* the reverted attempt
  pushed every mutation on the whole document, unbounded and unthrottled, into
  an array with no cap. **Design the budget before the implementation** — what
  is observed, what is dropped, what the cap is, and what the recording says
  when the cap bites.
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

## What shipped last session, and the shape of it

Two work streams, both merged, both green.

**1.2 — state capture.** Every step carries the difference between what the
page's stores held when the interaction was dispatched and what they held once
it settled, as an RFC 6902 patch; `get_state_patch` hands that to Claude Code.
The design decision worth knowing: **it samples, it does not intercept.** The
stores are read off the fibers React already keeps, and nothing is defined,
patched, wrapped or subscribed to on the page at any point. The v3.2.0 landmine
(assigning `window.__REDUX_DEVTOOLS_EXTENSION__` a non-callable object, which
crashed the classic enhancer at boot on every Redux page) cannot recur by
construction: there is no global to restore and no restore path to get wrong.
`tests/state-reader.test.ts` asserts that directly. Zustand held in a *module*
rather than a provider is deliberately **not** read, and the recording says so.

**1.3 — causal threading.** `get_causal_chain` and `get_effects_of` walk one
graph in both directions. Every link states the evidence it rests on, on four
bases **named rather than scored** — a `0.8` implies a precision this evidence
does not have and cannot be argued with; "the log line contains the request's
path" can. The graph is **derived at read time, never stored**, so it covers
every recording already on disk and a rule improved later reaches all of them.

---

## Non-negotiables

- `src/core/` is pure — no `chrome.*`, no DOM, no `fetch`, no clock. It is
  bundled into `mcp-server/core.js` and imported by a Node process.
- Every `chrome.*` call goes through `src/chrome/`.
- The ARKG stays additive, via the guarded `arkgTry` funnel.
- Anything published must be in `mcp-server/package.json` `files`.
- Any change touching `src/` or `public/` needs a `## Unreleased` changelog entry.
- Strings obey the frozen `docs/CONTRACTS.md` §4. `docs/CONTRACTS.md` is frozen —
  if it is wrong, say so; do not fix it locally. Note §3.6 enumerates the
  settings prefixes each group owns, which is why state capture's eight settings
  are under `recording.` and not a `state.` prefix of their own.
- A setting that is not in `src/features/settings/fields.ts` does not exist.
  After touching that table, run `npm run build:settings`.
- Comments say **why**, not what.

## How to work

- **Do not tick a checkbox unless `npm run verify` proves it** — and unless you
  have read the thing it claims. That habit is what made the previous attempt
  worthless.
- **Do not build a module with no caller.** If the thing that would consume it
  does not exist yet, say so and defer, with the reasoning written into the
  roadmap rather than left implicit.
- **Write tests that would fail against the bug.** After writing a test, break
  the code it covers and confirm it goes red, then revert. A test that passes
  against both the correct code and the obvious defect is worse than no test,
  because it reports safety.
- **Test at the layer that can lose the data, not below it.** Last session
  `saveFlow` copied named fields out of a posted payload and `state` was not one
  of them, so every real recording lost its stores on the way to disk while
  every fixture kept them — three test layers, all green, none of them crossing
  the layer that dropped it. `tests/state-end-to-end.test.ts` is the shape that
  catches this: it starts at the POST and ends at the tool output.
- **A node type no tool prints does not exist** from outside. The write and the
  renderer are one deliverable — `subscribes_to` edges and `topStateKeys` were
  both written and unreadable until a second pass added the rendering.
- **Use subagents in parallel with explicit file ownership**, tell them not to
  run `verify` or `build*` concurrently, and have them report bugs in files they
  do not own rather than fixing them. **Verify their results independently** — a
  plausible report can still be wrong, and last session two were: one shipped
  0-based event refs beside 1-based step numbers, and one's tests could not see
  a bug that lost a whole feature.
- Run `graphify update .` after modifying code.
- Commit on a branch and merge; never commit straight to `main`.

## When you finish a work stream

Update `ROADMAP_AND_PHASES.md` in the same commit, run the full `npm run verify`
(and read its exit code), and say plainly what is shipped, what is partial and
what you chose not to build and why. If something is blocked, finish everything
else in full and name what you left out — scaling the work down is the user's
call, not yours.
