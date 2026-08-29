# The engine

`src/core/react/` answers one question — **where was this component written?** —
and it answers it for every surface that asks. The DevTools panel asks about a
component someone just picked. The flow review asks it about a component a
recorded step touched. The service worker asks it, unattended, for every step of
a recording.

All three get one implementation. That is worth saying explicitly because it is
the thing most easily lost: a second copy of any of this does not announce
itself, and two copies of a source-map decoder disagree slowly.

> `docs/CONTRACTS.md` §6 is the ledger of the nine divergences this engine had to
> absorb and the mechanism each one got. It is frozen and it is not repeated
> here. This file is the working description: what the engine is, what it costs
> to touch, and which properties are load-bearing.

---

## The path from a click to a file

```
element         the DOM node the user clicked, or the recorder observed
  │
  │ fiber.ts        walk up React's fiber tree, capped at MAX_FIBER_WALK
  ▼
component fn    the function React actually rendered
  │
  │ id.ts           hash(displayName + head of source) — stable identity, so the
  │                 same component clicked forty times resolves once
  │ needle.ts       two slices of that function's compiled text: a specific head
  │                 and a rename-proof body
  ▼
needle
  │
  │ provider        listScripts() / loadScript() — the page's bundles, as text
  │ search.ts       find the needle in a bundle → a Pos0 position in served code
  ▼
compiled position
  │
  │ sourcemap.ts    the bundle's map, decoded → an original file, line and column
  │ vlq.ts          streaming Base64-VLQ decode
  ▼
ComponentSource   status, source, line (Pos1), column, compiled (Pos0), detail
  │
  │ editor.ts       {path}, {line1}, {col1} into the configured editor's template
  ▼
Open in Editor
```

Two shortcuts exist and both are honest ones. On a development build React
attaches `_debugSource` to the fiber, which is the authoritative original
location and beats any bundle search — it is 1-based as React records it, so it
crosses no bridge. And `classify.ts` recognises a `node_modules` path, so a
component resolved into a dependency is marked rather than offered as something
you can edit.

`owner.ts` and `chains.ts` sit beside this rather than in it: the nearest
component fiber to a click is usually `ButtonBase` or `Primitive.div`, and the
useful answer is the nearest component *you* own — a decision that needs the
resolved paths, so it is made at export time over the finished table rather than
stamped on the step.

---

## Purity, and what actually holds it

`src/core/` runs in a Node process. `npm run build:mcp` bundles
`src/core/mcp-bundle.ts` into `mcp-server/core.js`, and the published MCP server
imports it to render the same markdown walkthrough the extension writes. That
process has no `chrome` object, no `window`, no DOM.

So the rule — no `chrome.*`, no `fetch`, no DOM, no clock in `core/` — is not
held by review. `tests/mcp-pagination.test.ts` spawns the real server as a
process, and that server imports `core.js`, so anything reaching for a browser
global on the way in fails a test rather than a review comment. What that cannot
catch is a `chrome.*` sitting in a branch the server never takes, which is the
standing argument for keeping `mcp-bundle.ts` narrow: only what it re-exports is
reachable at all.

This is why fetching and caching are not in `sourcemap.ts`, where they would be
convenient. `search.ts` is handed a string and given nothing to load it with —
which is also what makes it testable with no browser.

The seam is `BundleProvider` (`core/react/provider.ts`, contract in CONTRACTS
§2). Two implementations, neither of them a fallback for the other:

| | Reads from | Strength |
| --- | --- | --- |
| `DevtoolsProvider` | the DevTools resource cache | sees scripts that loaded before anything was watching; never re-fetches |
| `WorkerProvider` | script URLs collected from the page, fetched in the worker | works with DevTools closed, which is how a recording attributes its steps whether or not anyone opened the panel |

Both are constructed with a `BundleBudget` built from the same five settings, so
"how many bundles at once" and "how large a resource is too large" mean the same
number on both surfaces. Before that, one side read the settings and the other
had `FETCH_CONCURRENCY = 6` compiled in.

Failures are deliberately not cached. A bundle that would not load once may load
on the next pass, and a negative cache living as long as a service worker would
make the recorder's retry a lie.

---

## What replaced the drift check

Six of these concerns used to exist twice, as copies kept level by hand and by a
script that diffed them. Both the script and the document describing the
arrangement are gone, because there is one copy and nothing to compare it
against.

That is only an improvement if the reasoning survived, and the reasoning was
never "keep the copies identical". It was **four places where the copies were
deliberately different, each of which produces a plausible wrong answer if you
merge them carelessly.** A checklist cannot hold those, because a checklist is
only run by someone who remembers it exists. Each is now held by something that
fails on its own:

**Line bases are types.** `Pos0` is what a source map and V8 say; `Pos1` is what
an editor and a person read. `toOneBased()` is the only bridge and there is no
way back — a symmetric pair is an invitation to convert twice. `pos0()` and
`pos1()` are assertions at an edge, never arithmetic, and there are only three
legitimate edges: a decoded map, a value read back from storage, and a number
someone typed. The failure this prevents is the worst kind available here: one
copy added 1 while filling `{line1}` and the other had added it at the map edge,
so merging them opened **every file one line off, forever**, with nothing
throwing and the number looking entirely plausible. It is a compile error now.

**`force` is a required parameter with no default.** Resolving a `React.lazy` can
call `_init`, which can start a dynamic `import()`. A picker should force — the
user pointed at the component and asked. A recorder must never force, because a
passive observer that changes what the page loads has stopped describing the
session it claims to describe. With no default, every call site states which one
it is or fails to compile, and a test walks a chain past an unsettled lazy
component and asserts `_init` was never called.

**`keepSourcesContent` is an ordinary parameter, and that is not an
inconsistency.** The panel renders a source preview and wants the inlined
originals; a flow does not, because inlined source is both a token disaster and a
way to leak code nobody meant to send. Getting this wrong costs a missing preview
or a larger object — never a wrong path. **A parameter is safe exactly when being
wrong is loud and bounded.** That is the whole distinction between this and the
line base, and it is the test to apply to the next one of these.

**`classify.ts` is a superset, and the bundle proves the tree-shake.** The panel
needs filter chips, category labels, descriptions and counts; the recorder needs
`isDependencyPath` and nothing else. Splitting the category table across two
modules would put the same enum in two places. Instead there is one module, and
the guard is `mcp-server/core.js`: `isDependencyPath` reaches it and
`CATEGORY_LABELS`, `CATEGORY_DESCRIPTIONS`, `filterComponents` and
`countByCategory` do not. If UI strings ever start leaking into the worker path,
the Node bundle grows visibly.

---

## Streaming, and why the decoder looks the way it does

`vlq.ts` decodes lazily rather than materialising every segment. On a real 9.3 MB
map — 896 sources, 2,671 generated lines, 413,460 segments — building the object
graph costs tens of megabytes of heap. A DevTools panel survives that. An MV3
service worker resolving a dozen components across a recording does not, and
Chrome kills it without ceremony when it does not.

The same pressure is why the resolver caches parsed maps rather than raw text,
why that cache is bounded, and why the size ceilings are settings rather than
constants: a `PreparedMap` is a core object no provider knows anything about, so
it is the one cache that stays with the resolver.

---

## Nine outcomes, eight of them not `resolved`

`ComponentStatus` has nine values. `resolved` is one. The others — `no-map`,
`map-error`, `unfetchable`, `not-found`, `ambiguous`, `compiled-only`, `skipped`,
`pending` — are the ordinary results of looking for a component in a shipped
bundle, and every one of them carries a `detail` sentence written by the code
that knows what actually happened.

This is a core concern rather than a UI one, and it is the reason the engine
returns a status rather than `string | null`. A card showing a name and no path
reads as *this component has no source*, which is discouraging and usually
false; one saying *most likely a lazy chunk that was never fetched* tells the
reader to load that route and pick again. `ambiguous` carries its match count and
how many scripts were searched, because a needle that matched in three places may
have picked the wrong one and that is not something to find out by editing the
file.

---

## Touching this

- Anything you add to `core/` is shipped to npm if `mcp-bundle.ts` re-exports it.
  That file is deliberately narrow; widen it only with a reason worth writing
  down, as the existing ones are.
- `pretest` runs `npm run build:mcp`, so `npm test` is already testing against a
  freshly bundled `core.js`. Nothing upstream of it will notice impurity:
  `npm run typecheck` is perfectly happy with a `chrome.*` in `core/`, because
  `@types/chrome` is on the extension project.
- The provenance headers on these files say what the file *is* and which
  mechanism answers which divergence. They are not "ported from" notes any more,
  and should not become them again.

---

## Why the MCP server has no `locate_component`

The merge plan left this one optional, and the answer is that it should not
exist. It is written down because "we could add a locate tool" is the kind of
idea that comes back.

A locate is three things: a walk up the fiber tree of a **live page**, a needle
cut from the function React actually rendered on it, and a search through the
bundles **that page** served. The engine is pure and runs in Node perfectly well
— that is the whole point of `core.js` — but there is nothing for it to run on. A
stdio MCP server has no page, no fiber tree and no needle. A `locate_component`
that took a component *name* and went looking would be guessing from a string,
and would report a file with the same confidence as a real match.

The useful half of the question is already answered, by the tools that exist. The
recorder resolves a `ComponentSource` for every step in the background, and it
travels with the flow: `list_flows` names the component behind a flow's commonest
failure, `get_flow_errors` and `get_flow_step` carry each step's component with
its file and line, and `get_flow` carries it per step along with the feature
component that one is rendered inside. A tool that read those same files back
would be a fourth name for an answer three tools already give — and a tool list
is a menu a model picks from, so a duplicate entry costs a wrong choice, not just
a line of documentation.

There is one question a Node process could answer that none of them do: *which
steps, across every recording, touched this component?* A reverse index over the
component tables is real work and might be worth building. It is **not** a
locate — it resolves nothing, it reads back what a browser resolved — and
CONTRACTS §4.2 reserves the word for the resolution itself. If it gets built it
should be named for what it does, and built because somebody wanted it rather
than because a plan left a slot open.
