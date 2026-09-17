# Contributing to DevFlow

Read `CLAUDE.md` at the repo root first — it is the working guide this file
assumes, not a duplicate of it. This file is the entry point it doesn't
provide: what a contributor coming from outside runs before opening a PR, and
what the load-bearing conventions this repo relies on actually are, since
none of them are otherwise discoverable before `npm run verify` bounces a
first PR.

## Setup

```sh
git clone https://github.com/ansh-n-chovatiya/DevFlow.git
cd DevFlow
npm install   # postinstall also runs `npm ci` inside mcp-server/ — two
              # packages, two lockfiles, no npm workspaces, on purpose:
              # mcp-server ships to npm on its own.
```

## The gates, and what `npm run verify` actually runs

`npm run verify` is the one command that decides whether a change is done. It
is also what `npm run package` runs before writing a release zip, so nothing
red ships. Read its exit code directly — piping it through `tail` (or
anything else) reports the pipe's exit status, not `verify`'s, and on this
repo's zsh `$?` after a pipeline is not what `${PIPESTATUS[0]}` would give you
either. Run the command on its own and check `$?`.

At the time of writing, `verify` runs, **in this order**:

| | |
| --- | --- |
| `npm run typecheck` | both `tsconfig.json` (the extension) and `tsconfig.node.json` (`scripts/`, Vite configs, test helpers touching the filesystem) |
| `npm run lint` | eslint |
| `npm run lint:tokens` | no colour literal outside `src/ui/styles/tokens.css` |
| `npm run lint:settings-ui` | the options page and the panel's settings drawer build their DOM only through `src/ui/settings/components.ts` |
| `npm run lint:graphify` | the graph config (`graphify-out/`) is committed, not just present on this machine |
| `npm run lint:brand` | no other product's name, no stray page global, in `src/` or `public/` |
| `npm run lint:vocab` | the frozen glossary in `docs/CONTRACTS.md` §4 — a flow is not a session, a component is not an element |
| `npm run lint:locate` | invariants specific to `src/core/locate/` |
| `npm run lint:core-purity` | nothing in `src/core/` reaches `chrome.*`, `fetch`, `window`, or the DOM — the thing that makes `core/` bundleable into a Node MCP server with none of those |
| `npm test` | vitest, node + jsdom. `pretest` builds `mcp-server/core.js` and the settings JSON first — two suites need `core.js` on disk, one of them by spawning the real server |
| `npm run build` | five builds: generated settings JSON, pages + worker, content script, page agent, MCP core |

Do not trust this table over `package.json`'s own `verify` script if the two
ever disagree — this file can go stale in a way `package.json` cannot, because
nothing gates *this* file.

`npm run lint:changelog` runs in CI as its own step, not inside `verify`,
because it needs two commits to diff against and a single working tree can't
answer that. It's still required: any change touching `src/` or `public/`
needs a corresponding entry under `## Unreleased` in `CHANGELOG.md`, or CI
fails the PR.

## The `.ctx/` Context Ledger — and what a fresh clone actually gets

`CLAUDE.md` describes `.ctx/` as this repo's second map, alongside the code
graph in `graphify-out/`: ADRs in `.ctx/decisions/`, plans in `.ctx/plans/`,
and a journal of what was established and why. It says only `.ctx/runtime/`
is gitignored and "everything else under `.ctx/` is committed."

**That is not true of this working tree right now, and it's worth saying
plainly rather than writing around it: `.ctx/.gitignore` ignores everything
under `.ctx/` (a blanket `*` rule, not just `runtime/`), so `git ls-files
.ctx` returns nothing.** A contributor working from a fresh `git clone` of
this repository will not have this repo's own ADR or journal history on
disk — and re-cloning will not fetch it back, because there is nothing checked
in to fetch. If you're relying on `.ctx/` to tell you why a decision in this
codebase was made a particular way, and your clone's `.ctx/` is empty or
missing entries you expected, this is why: it is a real gap between what
`CLAUDE.md` documents and what this tree currently does, not a mistake in
your checkout.

If you're set up with whatever tooling produced `.ctx/` locally (the `ctx`
CLI mentioned in `CLAUDE.md`), the workflow it documents still applies to
*your* machine's copy:

- `/ctx:resume` and `/ctx:status` are the cheap ways back into what's already
  there.
- Escalate the level of ceremony to the size of the change: L0 (default,
  nothing written down) for a single-session change, L1 (`/ctx:task`) when
  the change has acceptance criteria worth fixing before you start, L2
  (`/ctx:spec` plus the dispatch commands) when the work splits across
  multiple owners with disjoint file sets — the parallel-subagent pattern
  this repo runs its own larger changes through.
- **An ADR in `.ctx/decisions/` is immutable.** If a past decision is wrong,
  write a new ADR that supersedes it. Do not edit the old one. The record of
  having changed your mind is the point — an edited ADR reads as though the
  current answer was always obvious, which erases the evidence for the next
  person (or the next session) to re-argue something already settled.

None of the above is required to contribute. It is how this repository keeps
track of its own reasoning between sessions; a PR is judged by `npm run
verify` and the PR description, not by whether `.ctx/` was touched.

## Before you open a PR

1. `npm run verify` passes, checked by its real exit code.
2. If your change touches `src/` or `public/`, `CHANGELOG.md` has a new entry
   under `## Unreleased` describing it.
3. If your change touches a setting, it went through
   `src/features/settings/fields.ts` — the one table every other settings
   surface derives from — and you ran `npm run build:settings` afterward.
   `public/settings.default.json` is generated; don't hand-edit it.
4. `docs/CONTRACTS.md` is frozen. If something in your change conflicts with
   it, say so in the PR rather than editing it to match.

## Reporting a security issue

See `SECURITY.md` — do not open a public issue for a vulnerability.
