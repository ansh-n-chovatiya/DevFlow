# DevFlow — merge plan

Merging **DevFlow** (`Flow-Recorder`, 2.7.1) and **react-source-locator** (2.2.0) into one
Chrome extension, on one shared React/source-map engine instead of two copies of one.

> **This is the execution plan, kept as the record of what was intended.** It is not
> documentation of the product: the repo describes what shipped, and where the two
> disagree the repo is right. `README.md` is the front door, `CLAUDE.md` the working
> rules, `docs/CORE.md` the engine, and `docs/CONTRACTS.md` the Wave 0 freeze the
> parallel sessions were built against.

| | DevFlow | react-source-locator | DevFlow |
| --- | --- | --- | --- |
| Version | 2.7.1 | 2.2.0 | new |
| Source | ~9k LOC | 3.8k LOC | — |
| Tests | 75 files | 6 files | 81+ |
| Surface | popup + content + viewer + options | DevTools panel | all of it |

---

## Decisions taken

| Question | Decision | Consequence |
| --- | --- | --- |
| Repo name | **DevFlow** | package `devflow`; extension "DevFlow — Record & Locate" |
| Where locating lives | **Both surfaces, one engine** | DevTools panel kept *and* locating reachable from the popup. Needs the provider seam (W1·B) |
| Git history | **Fresh init** | both source repos untouched; provenance survives in docs + existing file headers |
| First milestone | **Full merge, theme included** | Waves 0–3 all in scope |

---

## One product, not two features

**The governing rule: nothing may read as "the recorder half" and "the locator half".** A user
should never be able to tell that DevFlow was two extensions. Sharing an engine is not enough —
two features that share a source-map parser but keep their own icons, vocabulary, history and
settings groups still read as a bundle.

Concretely, that means these are requirements, not polish:

**1. The flow review *is* a locate surface.** This is the biggest integration win and it is almost
free. DevFlow already captures a component needle on every click and resolves it to a source path
in the background — `ComponentSource` is already on the step. So every recorded step in the viewer
shows its component and file, and clicking it opens **the same result card** the DevTools panel
shows, with the same "Open in Editor" action. Recording and locating stop being two things the user
does and become one thing they see. *(Package K.)*

**2. The bridge runs both ways.** From a recorded step → locate its component. From a picked
component → the steps that touched it, when a recording is live.

**3. One icon system.** DevFlow generates icons from `lucide-static` into `icons.generated.ts`;
the locator hand-draws a bespoke SVG sprite in `panel.html` (`#i-react`, `#i-target`, `#i-mouse`…).
Two icon vocabularies is the single most visible tell. The sprite is **replaced**, not ported.

**4. One shell.** Same app bar, same buttons, same toast, same empty states, same focus ring. The
panel's hero — "React Source", the spinning React mark, the DevPrecision identity — is locator
branding and goes.

**5. One vocabulary.** `flow`, `step`, `component`, `pick`, `locate` need one glossary, frozen in
Wave 0 because every package writes user-facing strings. Nothing ships saying "React Source", and
no `rst:` storage prefix or `__RST_*` page global survives.

**6. One settings page, organised by concept, not by origin.** Not a "Recording" section and a
"Locator" section. The groups are *React & source resolution* (which both halves use — the editor
and project root already serve both today), *Recording*, *Export & MCP*, *Appearance*. *(Package J.)*

**7. One history.** The locator's recent picks and DevFlow's flow library share a surface and a
visual language rather than being two unrelated lists.

**8. Either door works.** The popup offers both actions. DevTools is a power surface for locating,
never the only way to reach it — which is what W1·B's `WorkerProvider` exists to make possible.

---

## Why this merge is smaller than it looks

These two repos already know about each other. `react-source-locator/docs/SHARED-CORE.md`
documents six files that exist twice by copy, a `core:drift` script that keeps the copies level,
and per-file `Ported from … @ <sha>` provenance headers.

That document also records that extracting a shared package was **planned, designed, and
deliberately dropped**, and gives four reasons. A merged repo dissolves three outright:

| Reason the package was dropped | Status in a merged repo |
| --- | --- |
| A third repository with its own release cadence | Gone — one repo, one cadence |
| Version skew between the two extensions | Gone — one extension, one version |
| Neither can `npm ci` from a fresh clone until the package publishes | Gone — the core is a directory, not a dependency |
| Four deliberate behavioural divergences between the copies | **Still real.** Resolved individually below |

So the central task is not "combine two extensions". It is **resolve the divergences, then delete
one copy of everything.** Two facts verified while planning make that concrete:

- `vlq.ts` is already **code-identical** across both repos apart from one extra exported helper
  (`findSegment`). Only the comments have drifted.
- Every shared constant already holds the **same value** in both: `MAX_FIBER_WALK` (2000),
  `NEEDLE_HEAD_LEN` (200), `NEEDLE_BODY_LEN` (80), `MAX_MATCHES_TRACKED` (5),
  `MAX_RESOURCE_BYTES` (24 MB).

---

## The nine divergences, and how each is neutralised

D1–D5 are from `SHARED-CORE.md`. **D6–D9 were found while planning and are not documented
anywhere** — D6 in the token files, D7–D9 in the settings systems.

None is resolved by "pick one". Each gets a mechanism that makes the wrong choice **fail loudly**
rather than silently produce a wrong answer — which is exactly the objection that killed the
shared package.

### D1 · Line base: 0-based vs 1-based

The locator is 0-based end to end. DevFlow converts to 1-based once, at the source-map edge
(`sourcemap.ts`, `(segment.originalLine ?? 0) + 1`), so everything downstream is already 1-based.
Both are correct in their own repo. Consequently `buildEditorUrl` means **opposite things** by
`{line1}` in the two copies. SHARED-CORE rejects a `base: 0 | 1` parameter because a call site
that passes the wrong one opens every file one line off, silently, forever.

**Fix — make it a type, not a parameter.** Branded `Pos0` / `Pos1` types in
`core/react/positions.ts`, with `toOneBased()` as the only bridge. Core lookup returns `Pos0`
(spec-true). `buildEditorUrl` accepts `Pos1` only. The recorder converts at its existing edge; the
panel converts at its one call site. A wrong base becomes a **compile error** — the guarantee a
runtime flag could not give.

### D2 · `force` on the fiber walk

The locator passes `force = true` when resolving a lazy component on a pick — the user asked for
it. DevFlow must never force: `_init` can start a dynamic `import()`, so a passive recorder that
forced would change what the page loads and stop describing the session it claims to. DevFlow's
copy removed the flag entirely.

**Fix — required parameter, no default.** `getComponentFn(fiber, { force })` with no default, so
every call site must state intent or fail to compile. Backed by a unit test asserting the
recorder's capture path passes `force: false`.

### D3 · `sourcesContent` retention

The locator keeps it and renders a source preview. DevFlow drops it deliberately: a flow is sent
to an AI, and inlined original source is both a token disaster and a way to leak code the user did
not mean to send.

**Fix — opt-in parse flag.** `parseSourceMap(json, { keepSourcesContent })`. Recorder passes
`false`, panel passes `true`. Safe to parameterise *because the failure mode is bounded*: getting
it wrong costs a missing preview or a larger object, never a wrong path. That is the test D1 fails
and this one passes.

### D4 · Fetching and caching inside the core

The locator's `sourcemap.ts` owns a fetch callback and module-level caches. DevFlow's is pure —
its worker's resolver owns every fetch, because that is also what owns the time and count budgets.

**Fix — DevFlow's purity wins; caching moves to the providers.** Not a preference: `src/core/` is
bundled into `mcp-server/core.js` for a Node process with no `chrome` object, so purity is
**already CI-enforced** — a fetch or a `chrome.*` in core fails `npm run build:mcp`. Both caches
move into the two `BundleProvider` implementations (W1·B).

### D5 · Panel-only code in `classify.ts`

The locator's copy carries filter chips, their labels, `filterComponents` and `countByCategory`.
DevFlow classifies only to pick one owner out of a chain and drops all of it.

**Fix — one superset module, tree-shaken.** The recorder imports only `isDependencyPath`; Vite
drops the rest. Guarded by the existing `build:mcp` bundle, which would grow visibly if UI strings
leaked into the worker path.

### D6 · `--gutter` means two different things — *undocumented*

Found while diffing the two token files. DevFlow's `--gutter` is a **32px page gutter**; the
locator's is a **12px panel gutter**. Same name, different scale. Merging the stylesheets naively
rescales the entire panel.

**Fix — rename at port time.** The locator's becomes `--pad-panel: 12px`; DevFlow's `--gutter` is
untouched. Caught by `npm run lint:tokens`, which already forbids any file but `tokens.css` from
naming a value, plus an explicit grep gate in W0.

### D7 · The managed-policy layer — *undocumented*

The locator reads `chrome.storage.managed` so an IT admin can push `editor` / `projectRoot`
org-wide, and `managedKeys()` disables those inputs in the UI. DevFlow **deliberately dropped
this** — `core/react/editor.ts` says so: *"a recorder has no such deployment story."*

But the merged product *is* also a locator, and that story comes back with it. Dropping the layer
silently breaks every enterprise deployment of react-source-locator.

**Fix — keep it, as a third resolution layer.** DevFlow's sparse-override model takes it cleanly:
`DEFAULTS ← user overrides ← managed overrides`, managed winning, exactly as the locator resolves
today. `resolve()` stays pure by taking the managed overrides as an argument rather than reading
storage itself. `managedKeys()` drives a disabled state in the Settings screen. Additive,
low-risk, and it preserves a feature the merge would otherwise quietly delete.

### D8 · Two settings storage shapes — *undocumented, data-losing*

| | Shape | Area |
| --- | --- | --- |
| Locator | one JSON blob under `rst:settings` | `sync` + `managed` |
| DevFlow | flat dotted keys, **sparse overrides only** | `sync` |

DevFlow's model is the one to keep — it is the one with the derivation guarantees, the generated
`settings.default.json`, and the validator the MCP server imports. But an existing
react-source-locator user upgrading to DevFlow would find `rst:settings` unreadable and **silently
lose their editor and project root.**

**Fix — a one-time migration.** On first run, read `rst:settings`; if present, write the
equivalent flat keys (only where they differ from defaults, per the sparse rule) and mark it
migrated. The locator already has migration precedent — `coerce()` upgrades the old
`hideFrameworkComponents` boolean into per-category `hidden` — so this follows an established
pattern in the same file. Needs a test with a realistic pre-merge blob.

### D9 · Two settings surfaces — *undocumented*

The locator has a **drawer inside the panel**; DevFlow has a **full options page**
(`settings.html`, `open_in_tab`). Two stores would drift; deleting the drawer would turn
"pick a component, then change your editor" into a page switch.

**Fix — one store, two views.** The options page is the source of truth. The panel drawer stays,
rebuilt as a thin view over the same `FIELDS` registry showing only the locator-relevant keys.
`lint:settings-ui` already enforces that settings DOM construction is encapsulated, so the drawer
has to go through the same components or CI fails.

---

## Settings: the merged key map

This is the part the first draft of this plan missed. DevFlow's settings system is **6,887 lines**
and is not a config file — `fields.ts` (1,911 lines) is a single data table from which the
`Settings` type, `DEFAULTS`, the `resolve()` clamp, the Settings screen inputs, the reset
affordance, and `public/settings.default.json` are all *derived*. Its own header states the goal:
*"A setting that exists in one of those and not the others is the failure this shape exists to
make impossible."*

Three consequences for the merge:

1. **Every locator setting must be registered in `FIELDS`,** or it does not exist. There is no
   second place to put one.
2. **Defaults are imported from `shared/constants.ts`, never retyped.** `tests/settings-defaults.test.ts`
   asserts the whole table.
3. **`npm run build:settings` regenerates `settings.default.json`** and `lint:settings-ui` guards
   the UI. Both are in `npm run verify`, so a half-registered setting fails CI rather than review.

### Keys that already align

`settings.default.json` already ships these — DevFlow does source resolution too, and
`core/react/editor.ts` notes its `EDITORS` table is *"kept in step with the sibling extension's
table, in the same order"*. **No work beyond confirming the tables still match.**

| Key | DevFlow | Locator |
| --- | --- | --- |
| `editor` | `"vscode"` | `"vscode"` |
| `customEditorTemplate` | `""` | `""` |
| `projectRoot` | `""` | `""` |

### Keys that overlap semantically but are not the same

| Locator | DevFlow | Resolution |
| --- | --- | --- |
| `useSourceMaps` | `reactResolve`, `reactCapture` | **Not** the same scope. `useSourceMaps` gates one interactive locate; `reactResolve` gates the recorder's whole background pass. Keep both: add `react.useSourceMaps` for the locate path, leave `reactResolve` owning the recorder pass. |
| DevTools theme (`chrome.devtools.panels.themeName`) | `theme: system \| light \| dark` | The panel currently follows DevTools' theme, which is chosen independently of the OS. DevFlow's explicit setting must win when it is not `system`; DevTools' theme becomes the fallback the `system` value resolves against, in place of `prefers-color-scheme`, **for the panel only**. |

### Keys the locator brings that DevFlow has no equivalent for

| Key | Notes |
| --- | --- |
| `locator.hidden.*` | One per `HIDEABLE_CATEGORY`, all `true` by default. Tied to D5 — these exist only because the panel keeps the classify UI. |

### DevFlow tunables the locator path must now respect

The locator hardcodes `FETCH_CONCURRENCY = 6`; DevFlow makes the same number a Tier 2 setting at
`react.resolveConcurrency` (4). After the merge **both providers read the settings**, so these stop
being two numbers:

`react.resolveConcurrency` · `react.maxResourceBytes` · `react.maxMapBytes` ·
`react.bundleCacheEntries` · `react.bundleCacheBytes`

This is W1·B's responsibility and is the main reason B is a separate package from A.

---

## The one new abstraction: `BundleProvider`

"Both surfaces, one engine" needs exactly one seam.

The locator's only hard dependency on being a DevTools panel is
`chrome.devtools.inspectedWindow.getResources()` — the list of loaded scripts and their text out of
the DevTools cache. DevFlow has no DevTools page, so it already solved the same problem
differently: `features/react/inventory.ts` collects script URLs from the page itself (a
`PerformanceObserver` on resource entries plus `document.scripts`), keyed by origin, and the worker
fetches them.

Both are real strategies with different strengths, and neither should be deleted.

```ts
// src/core/react/provider.ts — frozen in Wave 0, implemented in W1·B
export interface BundleProvider {
  /** Candidate bundle URLs for a page, in load order. */
  listScripts(pageUrl: string): Promise<string[]>;
  /** Bundle text, or null when it cannot be read. Caching is the provider's job. */
  loadScript(url: string): Promise<string | null>;
  /** A bare URL — a source map. Same caching contract. */
  loadUrl(url: string): Promise<string | null>;
}
```

| Implementation | Ported from | Used by | Strength |
| --- | --- | --- | --- |
| `DevtoolsProvider` | locator `core/resources.ts` | DevTools panel | Reads the DevTools cache; sees scripts loaded before the extension was watching; no re-fetch |
| `WorkerProvider` | DevFlow `features/react/{inventory,resolver}.ts` | Recorder, popup locate | Works with DevTools closed; budgeted, idempotent across MV3 worker deaths |

### Two simplifications fall out of this

**The agent injection dance is deleted, not ported.** The locator injects its page agent on demand
by reading the built file and `eval`-ing it into the page (`getAgentSource()` → `ensureAgent()` →
`callAgent()`). DevFlow already ships a MAIN-world agent injected at `document_start` on
`<all_urls>` by the manifest. In DevFlow there is **one agent, already present**. The picker's
listeners stay lazy — attached only on `startPick` — so it costs nothing when idle.

**The runtime permission prompt goes too.** The locator asks for `<all_urls>` at runtime via
`optional_host_permissions` and an `ensureHostPermission()` prompt. DevFlow holds `<all_urls>` as
a static `host_permissions` grant, which is a superset.

---

## Target layout

DevFlow's structure is the frame — it is the stricter and better-guarded of the two (`core/`
purity enforced by the Node bundle, colours by `lint:tokens`, settings by `build:settings` +
`lint:settings-ui`, versions by `sync-version`). The locator's code moves into it.

```
devflow/
├─ public/manifest.json      merged: popup + devtools_page + content scripts
├─ public/settings.default.json   GENERATED by build:settings — never hand-edited
├─ src/
│  ├─ core/                  PURE — no chrome.*, bundled into Node for MCP
│  │  ├─ react/              ◆ the unified engine — one copy, was two
│  │  │  ├─ positions.ts     NEW · Pos0/Pos1 brands, toOneBased()   (D1)
│  │  │  ├─ provider.ts      NEW · BundleProvider interface
│  │  │  ├─ vlq.ts           already code-identical + findSegment
│  │  │  ├─ sourcemap.ts     pure base + keepSourcesContent      (D3, D4)
│  │  │  ├─ fiber.ts         explicit force param                (D2)
│  │  │  ├─ classify.ts      superset, tree-shaken               (D5)
│  │  │  ├─ editor.ts        DevFlow's validated builder, Pos1-typed
│  │  │  └─ needle.ts search.ts owner.ts chains.ts attribution.ts id.ts table.ts
│  │  └─ flow/ export/ redact/ schema/ selector/ describe/    DevFlow, unchanged
│  ├─ features/
│  │  ├─ react/providers/{devtools,worker}.ts   ◆ the seam
│  │  ├─ settings/           ◆ FIELDS gains the locator keys  (D7, D8, D9)
│  │  └─ flows/ export/ mcp/ recording/ screenshots/
│  ├─ injected/agent.ts      ◆ ONE MAIN-world agent: recorder + picker
│  ├─ injected/{picker,overlay,highlight}.ts    from the locator
│  ├─ ui/
│  │  ├─ styles/tokens.css   ◆ DevFlow tokens + ~8 additions
│  │  ├─ locator/            ◆ the panel, re-skinned
│  │  ├─ settings/           ◆ options page + the panel's drawer view
│  │  └─ popup/ viewer/
│  └─ background/ chrome/ shared/
├─ mcp-server/               unchanged; optionally + locate_component
├─ docs/CONTRACTS.md         NEW · the Wave-0 freeze
└─ scripts/ tests/
```

`scripts/core-drift.mjs` and `docs/SHARED-CORE.md` are **deleted**, not ported — they police a
duplication that no longer exists. Their reasoning moves into `docs/CONTRACTS.md`, where it becomes
the rationale for the mechanisms above rather than a manual review checklist.

---

## Execution: four waves, thirteen sessions

Waves are numbered because they are a real dependency sequence — a wave cannot start until the
previous lands. Packages inside a wave are lettered because they are unordered and run
concurrently.

**No two packages in the same wave write the same file.** That is the property that makes them safe
to run as separate sessions, and the one to preserve if packages get resplit.

### Wave 0 — freeze the contracts · 1 session, serial

The only genuinely serial work. Everything downstream compiles against what this produces, so it
must exist before any parallel session starts, and must not change afterwards without telling every
running session.

| | Owns | Budget |
| --- | --- | --- |
| **W0** Repo scaffold + interface freeze | `package.json`, `vite.*.config.ts`, `tsconfig*`, `src/core/react/{positions,provider}.ts`, `src/shared/types.ts`, `src/ui/styles/tokens.css`, `src/ui/icons.ts`, `docs/CONTRACTS.md` | ~80k |

`git init devflow`; copy DevFlow's build spine (vite ×5, vitest, eslint, the three lint guards).
Write the type-only contracts as files that typecheck but throw `not implemented`.

`CONTRACTS.md` carries five frozen things, because every parallel package consumes them:

1. **Position types** — `Pos0` / `Pos1` / `toOneBased` (D1).
2. **The `BundleProvider` interface** — consumed by B, G, H.
3. **The settings key manifest** — every key, type, default, and owning package (B, G, H, J).
4. **The glossary** — the exact user-facing word for every concept, since seven packages write
   strings and inconsistent vocabulary is what makes a merge read as a bundle.
5. **The icon manifest** — which named icon each UI affordance uses, resolved to DevFlow's
   `lucide-static` set, so D, E, G, H and K cannot reintroduce two icon vocabularies.

### Wave 1 — port and unify · 7 sessions, parallel

The bulk of the work, all independent. Each package reads only its own sources plus
`docs/CONTRACTS.md` — no package needs to understand both codebases.

| | Package | Owns | Budget | Notes |
| --- | --- | --- | --- | --- |
| **A** | Unified React / source-map core | `src/core/react/*.ts`, `tests/{vlq,sourcemap,bundle-search,classify}.test.ts` | ~120k | D1–D5. The deletion the whole merge exists for |
| **B** | Bundle providers | `src/features/react/providers/*.ts`, `{inventory,resolver}.ts` | ~90k | D4; both providers read the Tier 2 settings |
| **C** | Unified page agent | `src/injected/{agent,picker,overlay,highlight}.ts`, `tests/overlay.test.ts` | ~90k | Page-globals collision; deletes the eval path |
| **D** | Theme port · shell **+ the shared result card** | `src/ui/locator/styles/{base,chrome,error}.css`, `src/ui/components/result-card.ts` | ~80k | 563 CSS lines, one stray literal. Also builds the one result card G, H and K all render |
| **E** | Theme port · views | `src/ui/locator/styles/{idle,picking,locating,result}.css` | ~80k | 1,378 lines; `result.css` has **45 raw colour literals** |
| **F** | Manifest, worker, build wiring | `public/manifest.json`, `src/background/index.ts`, `vite.config.ts`, `src/{devtools,panel}.html` | ~70k | MV3 surface merge |
| **J** | **Settings unification** | `src/features/settings/*`, `src/ui/settings/*`, `public/settings.default.json` | ~110k | **D7, D8, D9.** Register locator keys in `FIELDS`; managed layer; `rst:settings` migration + its test; **regroup by concept, not origin** |

**D** and **E** are re-skins, not ports: they also strip the locator's bespoke SVG sprite in favour
of the W0 icon manifest, and drop the "React Source" hero and DevPrecision identity.

### Wave 2 — wire the surfaces · 4 sessions, parallel

| | Package | Owns | Budget | Needs |
| --- | --- | --- | --- | --- |
| **G** | Locator panel | `src/ui/locator/{main,dom,history,settings}.ts`, `tests/settings.test.ts` | ~140k | A B C D E F J |
| **H** | Locate from the popup | `src/ui/popup/*`, `src/ui/viewer/locate-*.ts` | ~110k | A B C D J |
| **K** | **Flow review ↔ locate bridge** | `src/ui/viewer/{review-view,review}.ts` | ~100k | A B D J |
| **I** | Docs, MCP, changelog | `README.md`, `CLAUDE.md`, `CHANGELOG.md`, `docs/`; deletes `core-drift.mjs` + `SHARED-CORE.md` | ~70k | A |

**G** ports `panel/main.ts` — 1,023 lines, the single largest file in the merge — onto the unified
core and `DevtoolsProvider`, dropping `ensureAgent`, `getAgentSource` and `ensureHostPermission`.

**H** is the half that exists in neither repo today: a "Locate component" action in the popup that
arms the same picker and renders the same result card, backed by `WorkerProvider` so it works with
DevTools closed.

**K is what makes this one product rather than two.** It surfaces each recorded step's
already-captured `ComponentSource` in the flow review, with a click-through to the same result card
the panel and popup render. Note the ownership: the card itself is built once in **W1·D**, so G, H
and K all *import* it and none of them builds a second one — that is why D carries it rather than
whichever surface happens to need it first. If K slips, the merge still ships, but as two features
in one repo, which is the outcome this plan exists to avoid.

### Wave 3 — integrate and verify · 1 session, serial

| | Owns | Budget |
| --- | --- | --- |
| **W3** Full verify + manual QA | integration only — no new file ownership | ~80k |

`npm run verify` — typecheck, eslint, `lint:tokens`, `lint:settings-ui`, `lint:graphify`, tests,
five builds. Then load unpacked and check what static analysis cannot.

---

## Running this in parallel without collisions

1. **One package per session, one branch per package** — `wave1/a-core`, `wave1/j-settings`, and so
   on. Use a git worktree per session so checkouts never fight.
2. **Give each session only its own brief.** The file lists above are the allowlist: a package reads
   its sources, its destinations, and `docs/CONTRACTS.md`. Nothing else. This is what keeps a
   session short — no package needs to load both codebases, and the largest brief still fits
   comfortably in one context.
3. **Contracts are frozen.** If a package finds the W0 contract genuinely wrong it *stops and
   reports* rather than editing locally — a changed interface invalidates every sibling session
   running against it.
4. **Merge order inside a wave does not matter,** because file ownership is disjoint.
5. **Each package proves itself before merging:** `npm run typecheck` plus its own tests. The full
   `verify` is Wave 3's job, not every session's.

| Wave | Sessions | Serial cost | Parallel wall-clock |
| --- | --- | --- | --- |
| 0 · Freeze | 1 | ~80k | ~80k |
| 1 · Port & unify | 7 | ~640k | ~120k *(longest: A)* |
| 2 · Wire surfaces | 4 | ~420k | ~140k *(longest: G)* |
| 3 · Integrate | 1 | ~80k | ~80k |
| **Total** | **13** | **~1.22M** | **~420k across 4 sync points** |

Budgets are estimates from line counts, not measurements — treat them as relative sizing for
splitting work, not as promises. If a package runs long it splits cleanly:

- **A** along the file boundary between the source-map chain (`vlq`, `sourcemap`, `positions`) and
  the fiber chain (`fiber`, `classify`, `owner`, `chains`).
- **J** between the registry work (`fields.ts` + defaults) and the migration + managed layer.
- **G** along view boundaries (`idle`/`picking` versus `result`/tree rendering).

---

## Definition of done

- [ ] `npm run verify` passes — typecheck, lint, `lint:tokens`, `lint:settings-ui`,
      `lint:graphify`, 81+ test files, five builds.
- [ ] Exactly one implementation of each of the six formerly-shared concerns. `core-drift.mjs` is
      gone because it has nothing left to compare.
- [ ] `src/core/` still bundles clean into `mcp-server/core.js` for Node — the standing proof D4 held.
- [ ] No colour literal outside `tokens.css`. The panel renders in DevFlow's IBM Plex + teal
      identity, in light, dark and system themes.
- [ ] **Every setting from both extensions appears in `FIELDS`,** in the options page, and in the
      generated `settings.default.json`.
- [ ] **A pre-merge `rst:settings` blob migrates** to flat keys with no loss — covered by a test.
- [ ] **`chrome.storage.managed` still overrides `editor` and `projectRoot`,** and the UI disables
      those inputs.
- [ ] On one page, with DevTools open: a recording resolves component sources **and** the panel
      locates a picked component — one agent, one engine, two surfaces.
- [ ] Locating works from the popup with DevTools closed.
- [ ] `Flow-Recorder/` and `react-source-locator/` are byte-for-byte unchanged.

**Integration — the "one product" bar.** These are the criteria that fail a merge which technically
works but still reads as two extensions:

- [ ] **One icon set.** No bespoke SVG sprite survives; every glyph resolves through the W0 icon
      manifest. `grep -r 'symbol id="i-'` returns nothing.
- [ ] **One vocabulary.** No "React Source", no `rst:` storage key, no `__RST_*` page global, no
      "DevPrecision" anywhere in the tree.
- [ ] **Settings are grouped by concept, not by origin.** No group in the options page is
      recognisably "the locator's settings".
- [ ] **The flow review shows each step's component and file,** and clicking through opens the same
      result card the panel and popup render — one component, imported three times, built once in D.
- [ ] **Screenshot test:** the DevTools panel and the popup, side by side, are visibly the same
      product — same typeface, same accent, same buttons, same empty states.
