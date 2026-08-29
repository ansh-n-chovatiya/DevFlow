# FlowSnap — project rules

Kept separate from `.agent/rules/graphify.md` on purpose: that file is rewritten
in full every time `graphify antigravity install` runs, so anything project
specific put there is lost on the next `npm install`. This file is ours.

`CLAUDE.md` in the repo root is the long version of everything below, and is
worth reading in full before a non-trivial change.

## The knowledge graph comes first

Read `graphify-out/GRAPH_REPORT.md` before grepping or opening source files.

If `graphify-out/` does not exist, build it — one second, offline, no API key:

```sh
npm run graphify:setup     # first time: also installs git hooks + agent config
npm run graphify:update    # afterwards
```

For structural questions use `graphify query "<question>"`,
`graphify path "<A>" "<B>"` or `graphify explain "<concept>"` rather than grep.
Grep is still right for a literal string or an identifier you can already name.

## What this is

A Chrome MV3 extension that records browser flows and exports them as AI
context, plus `mcp-server/` — a separately published npm package that serves
those recordings over MCP.

## Rules CI enforces

- **`src/core/` is pure.** No `chrome.*`, no module-level state. It is bundled
  into `mcp-server/core.js` for a Node process with no `chrome` object.
  Extension APIs belong in `src/features/` or `src/chrome/`.
- **Only `src/ui/styles/tokens.css` may name a colour** (`npm run lint:tokens`).
- **`package.json` and `public/manifest.json` versions must agree**
  (`npm run sync-version`).
- **Never commit a `.mcp.json`.** It shadows contributors' real FlowSnap
  installation. Use `claude mcp add flowsnap -s local -- node ./mcp-server/server.js`.
- `dist/`, `releases/`, `.render/`, `graphify-out/` and `mcp-server/core.js`
  are generated — never commit or hand-edit them.

## Before pushing

```sh
npm run verify    # typecheck + lint + token guard + tests + builds — what CI runs
```
