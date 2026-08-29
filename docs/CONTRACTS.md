# DevFlow contracts — the Wave 0 freeze

Everything in this file is consumed by packages that are written **in parallel**, by
sessions that never see each other's code. That is the only reason it exists: a
type, a key name or a noun that changes after Wave 0 invalidates work already in
flight, silently, in a way that only shows up when the branches meet.

So: **if a package finds something here genuinely wrong, it stops and reports.**
It does not fix it locally. A local fix is how two packages end up each correct
against a different contract.

Five things are frozen. They are frozen because more than one package writes
against each of them:

| | Frozen thing | Consumed by |
| --- | --- | --- |
| [§1](#1--positions) | Position types — `Pos0` / `Pos1` / `toOneBased` | A, B, G, H, K |
| [§2](#2--bundleprovider) | The `BundleProvider` interface | B, G, H |
| [§3](#3--the-settings-key-manifest) | The settings key manifest | B, G, H, J |
| [§4](#4--the-glossary) | The glossary | C, D, E, G, H, J, K |
| [§5](#5--the-icon-manifest) | The icon manifest | D, E, G, H, K |

§6 records what `docs/SHARED-CORE.md` and `scripts/core-drift.mjs` used to do, and
why neither is coming across.

---

## 1 · Positions

**File:** `src/core/react/positions.ts` · **Divergence:** D1

react-source-locator was 0-based end to end. FlowSnap converts once, at the
source-map edge, so everything downstream of `lookupOriginal` is 1-based. Both
were right in their own repo, and the consequence was that `buildEditorUrl` meant
**opposite things** by `{line1}` in the two copies of the same file.

`SHARED-CORE.md` rejected the obvious fix — a `base: 0 | 1` parameter — for the
right reason: a call site that passes the wrong one opens every file one line
off, silently, forever. Nothing throws, no test goes red, and the number looks
entirely plausible on screen.

**The base is a type, not a parameter.**

```ts
export type Pos0 = number & { readonly [ZERO_BASED]: true };  // source maps, V8
export type Pos1 = number & { readonly [ONE_BASED]: true };   // editors, humans

export function pos0(value: number): Pos0;   // assertion at a map/stack edge
export function pos1(value: number): Pos1;   // assertion at a storage/user edge
export function toOneBased(value: Pos0): Pos1;  // the ONLY bridge
```

Rules every package holds to:

1. **Core lookup returns `Pos0`.** A source map says 0-based, so the module that
   reads one says 0-based. It does not editorialise.
2. **`buildEditorUrl` accepts `Pos1` only**, as does anything stored on
   `ComponentSource`, rendered in the result card, or shown to a person.
3. **There is no `toZeroBased`.** Nothing needs to walk back across the edge, and
   a symmetric pair is an invitation to convert twice.
4. **`pos0` / `pos1` are assertions, not conversions** — no arithmetic. Every use
   is a place a reviewer should look, and there are only three legitimate kinds:
   decoding a source map, reading a stored `ComponentSource`, and parsing a
   number a person typed.

Where the conversions actually live, once the waves land:

| Site | Package | Conversion |
| --- | --- | --- |
| `lookupOriginal()` in `core/react/sourcemap.ts` | A | returns `Pos0`; the recorder's existing edge applies `toOneBased` |
| `debugSource` from React | C | already 1-based — `pos1`, no arithmetic |
| `ComponentSource` read back from storage | B, K | `pos1(raw.line)`, once, at the read |
| `compiled` → DevTools Sources | G | stays `Pos0`; the DevTools API is 0-based too |

A wrong base is now a compile error. That is the guarantee a runtime flag could
not give, and the reason D1 gets a type where D3 gets a parameter (§6).

---

## 2 · `BundleProvider`

**File:** `src/core/react/provider.ts` · **Divergence:** D4

The locator's only hard dependency on being a DevTools panel was
`chrome.devtools.inspectedWindow.getResources()`. FlowSnap, having no DevTools
page, had already solved the same problem from the page side. Both strategies are
real and neither is deleted.

```ts
export interface BundleProvider {
  listScripts(pageUrl: string): Promise<string[]>;
  loadScript(url: string): Promise<string | null>;
  loadUrl(url: string): Promise<string | null>;
}
```

| Implementation | Ported from | Used by | Strength |
| --- | --- | --- | --- |
| `DevtoolsProvider` | locator `core/resources.ts` | DevTools panel | Reads the DevTools cache; sees scripts loaded before the extension was watching; no re-fetch |
| `WorkerProvider` | FlowSnap `features/react/{inventory,resolver}.ts` | Recorder, popup locate | Works with DevTools closed; budgeted, idempotent across MV3 worker deaths |

The contract, in four points:

- **Caching is the provider's job.** `src/core/` is bundled into
  `mcp-server/core.js` for a Node process with no `chrome` object, so a `fetch`
  or a `chrome.*` in core fails `npm run build:mcp`. The purity rule is
  CI-enforced, not a convention — which is why D4 is settled by "FlowSnap's
  purity wins" rather than by preference.
- **Every method resolves, never rejects.** Unreadable is `null`, and `null` is an
  ordinary outcome: a cross-origin script with no CORS headers, a chunk that 404s
  after a deploy, a resource over the size cap. Callers report *why* a component
  has no source. They do not catch.
- **Idempotent and re-entrant.** An MV3 worker dies whenever Chrome likes and a
  panel can ask twice at once. Calling any method twice with the same argument
  must be safe and should be cheap.
- **Budgets are constructor arguments**, as `BundleBudget` — the five Tier 2 keys
  in §3.2. This is what stops the locator's hardcoded `FETCH_CONCURRENCY = 6` and
  FlowSnap's `react.resolveConcurrency` from being two numbers again.

---

## 3 · The settings key manifest

**Owner:** J · **Divergences:** D7, D8, D9

FlowSnap's settings system is not a config file. `features/settings/fields.ts` is
a data table from which the `Settings` type, `DEFAULTS`, the `resolve()` clamp,
the Settings screen inputs, the reset affordance and
`public/settings.default.json` are all *derived*. Its own header states the goal:
*"A setting that exists in one of those and not the others is the failure this
shape exists to make impossible."*

Three consequences bind every package:

1. **Every locator setting must be registered in `FIELDS`,** or it does not
   exist. There is no second place to put one.
2. **Defaults are imported from `shared/constants.ts`, never retyped.**
   `tests/settings-defaults.test.ts` asserts the whole table.
3. **`npm run build:settings` regenerates `settings.default.json`** and
   `lint:settings-ui` guards the UI. Both are in `npm run verify`, so a
   half-registered setting fails CI rather than review.

### 3.1 · Keys inherited unchanged

The 74 keys already in `public/settings.default.json` keep their names, types and
defaults. They are generated, so that file — not this one — is the authority for
their values. Grouped by prefix: `annotation.*`, `console.*`, `export.*`,
`mcp.*`, `network.*`, `react.*`, `recording.*`, `screenshots.*`, `thumbnails.*`,
`ui.*`, plus the flat `editor`, `customEditorTemplate`, `projectRoot`,
`reactCapture`, `reactResolve`, `mcpAutoSend`, `mcpServerUrl`, `theme`.

Three of those already align exactly with the locator's own settings, because
FlowSnap does source resolution too and its `EDITORS` table was *"kept in step
with the sibling extension's table, in the same order"*:

| Key | FlowSnap | Locator | Action |
| --- | --- | --- | --- |
| `editor` | `"vscode"` | `"vscode"` | confirm the `EDITORS` tables still match; then nothing |
| `customEditorTemplate` | `""` | `""` | nothing |
| `projectRoot` | `""` | `""` | nothing |

### 3.2 · Keys the providers now read

These already exist and already have these defaults. What changes is who reads
them: **both** `BundleProvider` implementations, via `BundleBudget` (§2), where
before only FlowSnap's worker did and the panel hardcoded its own numbers.

| Key | Type | Default | Was, in the locator |
| --- | --- | --- | --- |
| `react.resolveConcurrency` | number | `4` | `FETCH_CONCURRENCY = 6`, hardcoded |
| `react.maxResourceBytes` | number | `25165824` | same value, separate constant |
| `react.maxMapBytes` | number | `67108864` | no equivalent — unbounded |
| `react.bundleCacheEntries` | number | `24` | unbounded `Map` |
| `react.bundleCacheBytes` | number | `50331648` | unbounded `Map` |

### 3.3 · New keys

Every one of these is J's to register. Nothing else may invent a key.

| Key | Type | Default | Group | Tier | Consumers | Why |
| --- | --- | --- | --- | --- | --- | --- |
| `react.useSourceMaps` | boolean | `true` | react | 1 | worker, ui | Gates **one interactive locate**. Deliberately not `reactResolve`, which gates the recorder's whole background pass — merging them would mean turning off background resolution to stop a slow pick. |
| `locator.hidden.routing` | boolean | `true` | react | 1 | ui | One per `HideableCategory`. Flat dotted keys, not a nested object: a nested value cannot be partially overridden, which is the whole basis of the sparse model. |
| `locator.hidden.providers` | boolean | `true` | react | 1 | ui | ” |
| `locator.hidden.react` | boolean | `true` | react | 1 | ui | ” |
| `locator.hidden.styling` | boolean | `true` | react | 1 | ui | ” |
| `locator.hidden.dependency` | boolean | `true` | react | 1 | ui | ” |

> `locator.` is a **storage prefix, not a word the product says.** See §4 — no
> user-facing string calls anything "the locator". The prefix is here because the
> keys belong to one feature's UI state and a flatter name would collide with
> `react.*`, which is about resolution.

### 3.4 · Three mechanisms, not keys

**D7 — the managed-policy layer.** The locator reads `chrome.storage.managed` so
an IT admin can push `editor` / `projectRoot` org-wide, and `managedKeys()`
disables those inputs. FlowSnap dropped this deliberately — `core/react/editor.ts`
says *"a recorder has no such deployment story."* The merged product **is** also a
locator, so the story comes back with it, and dropping the layer would silently
break every enterprise deployment of react-source-locator.

Resolution order becomes three layers, managed winning, exactly as the locator
resolves today:

```
DEFAULTS  ←  user overrides (sync)  ←  managed overrides (managed)
```

`resolve()` **stays pure**: it takes the managed overrides as an argument rather
than reading storage itself. `managedKeys()` drives a disabled state in the
Settings screen and in the panel's drawer.

**D8 — the `rst:settings` migration.** The locator stored one JSON blob under
`rst:settings` in `sync` + `managed`; FlowSnap stores flat dotted keys, sparse
overrides only. FlowSnap's model is the one to keep — it is the one with the
derivation guarantees, the generated defaults file and the validator the MCP
server imports. But an existing react-source-locator user upgrading to DevFlow
would find `rst:settings` unreadable and **silently lose their editor and project
root**.

So: on first run, read `rst:settings`; if present, write the equivalent flat keys
— only where they differ from defaults, per the sparse rule — and mark it
migrated. The mapping is total:

| `rst:settings` field | DevFlow key |
| --- | --- |
| `editor` | `editor` |
| `customEditorTemplate` | `customEditorTemplate` |
| `projectRoot` | `projectRoot` |
| `useSourceMaps` | `react.useSourceMaps` |
| `hidden.<category>` | `locator.hidden.<category>` |
| `hideFrameworkComponents` (pre-2.0) | every `locator.hidden.*` |

The locator already has migration precedent — its `coerce()` upgrades the old
`hideFrameworkComponents` boolean into per-category flags — so this follows an
established pattern in the same file it came from. **Needs a test with a
realistic pre-merge blob**, including the pre-2.0 boolean.

**D9 — one store, two views.** The options page (`settings.html`, `open_in_tab`)
is the source of truth. The panel's drawer stays — deleting it would turn "pick a
component, then change your editor" into a page switch — rebuilt as a thin view
over the same `FIELDS` registry, showing only the keys a locate uses: `editor`,
`customEditorTemplate`, `projectRoot`, `react.useSourceMaps`, `locator.hidden.*`.
`lint:settings-ui` already enforces that settings DOM construction is
encapsulated, so the drawer goes through the same components or CI fails.

### 3.5 · Theme

The panel currently follows `chrome.devtools.panels.themeName`, which DevTools
lets the user choose independently of the OS. FlowSnap has an explicit
`theme: system | light | dark`.

**The explicit setting wins whenever it is not `system`.** When it *is* `system`,
DevTools' theme is what `system` resolves against — in place of
`prefers-color-scheme`, **for the panel only**. Every other surface resolves
`system` against the OS, unchanged.

### 3.6 · Settings are grouped by concept, not by origin

Not a "Recording" section and a "Locator" section. The groups are:

- **React & source resolution** — `editor`, `customEditorTemplate`, `projectRoot`,
  `reactCapture`, `reactResolve`, `react.*`, `locator.hidden.*`. Both halves use
  these; the editor and project root already served both today.
- **Recording** — `recording.*`, `screenshots.*`, `network.*`, `console.*`,
  `annotation.*`, `thumbnails.*`.
- **Export & MCP** — `export.*`, `mcp.*`, `mcpAutoSend`, `mcpServerUrl`.
- **Appearance** — `theme`, `ui.*`.

A group that is recognisably "the locator's settings" fails the merge.

---

## 4 · The glossary

Seven packages write user-facing strings. Inconsistent vocabulary is the thing
that makes a merged product read as a bundle, so the words are frozen with the
types.

### 4.1 · Nouns

| Word | Means | Not |
| --- | --- | --- |
| **flow** | one recording, start to stop | session, capture, trace, recording *(as a noun)* |
| **step** | one interaction inside a flow | action, event, entry |
| **component** | a React component | element, node |
| **element** | a DOM node on the page | node, target |
| **source** | the file and line a component was written in | location, origin, definition |
| **project root** | the absolute local path source paths resolve against | workspace, repo path |
| **editor** | the external program a source opens in | IDE |

### 4.2 · Verbs

| Word | Means |
| --- | --- |
| **record** | capture a flow |
| **pick** | arm the picker and click an element on the page |
| **locate** | resolve a component to the source it was written in |
| **open in editor** | hand the source to the configured editor |
| **open in sources** | reveal the compiled position in DevTools' Sources panel |

**Pick and locate are two steps of one gesture and both words are needed.** A pick
can succeed where a locate fails — the component was found, its file was not — and
the difference is exactly what the `detail` sentence on a non-`resolved`
`ComponentSource` exists to explain.

### 4.3 · Surfaces, as the product names them

**Popup** · **Panel** (the DevTools panel; "DevTools panel" on first mention) ·
**Library** · **Flow review** · **Settings**.

### 4.4 · Button and label strings, frozen

| String | Where |
| --- | --- |
| `Pick component` | popup, panel idle, empty states |
| `Pick another` | panel result, panel error |
| `Cancel` + `Esc` | panel picking |
| `Open in Editor` | result card, panel status bar |
| `Open in Sources` | result card, panel status bar |
| `Copy path` | result card |
| `Locate component` | popup — H's new action |
| `Recent` | the panel's history drawer, and the popup's |
| `Parent tree` / `Siblings` | panel tree sections |

### 4.5 · Banned, and grep-checkable

Wave 3 runs the greps below over `src/` and `public/`. Each returns nothing —
**including in code comments**, with the single exception noted in the last row.
A gate with a standing exception is not a gate, so a comment that needs to
explain what did not survive says it without naming it.

| Grep | Because |
| --- | --- |
| `React Source` | the other product's name |
| `DevPrecision` | the other product's design-system identity |
| `rst:settings` | the other product's storage key. **Not bare `rst:`** — that matches `first:` and `worst:` in ordinary prose, and a gate that cries wolf is one nobody reads. D8 migrates the key, then it is gone. |
| `__RST` | the other product's page globals — one agent now, one namespace |
| `symbol id="i-` | the bespoke SVG sprite (§5) |
| `FlowSnap` **in user-facing strings** | the recorder's own former product name, which is as much a tell as the locator's. Ordinary comments may still name FlowSnap and react-source-locator as the repos this code came from — that is provenance, and it is worth keeping. What may not survive is a string a person reads: page titles, button labels, error sentences, settings copy, console prefixes. |
| "the recorder" / "the locator" *in user-facing text* | names the two halves the merge exists to dissolve. Fine in code comments and in this document; never on screen. |

DevFlow's page globals take the `__DEVFLOW_*` prefix, and its `localStorage`
mirror key is `devflow.theme`.

---

## 5 · The icon manifest

**Source:** `src/ui/icons.ts` + `src/ui/icons.generated.ts`, generated by
`scripts/build-icons.mjs` from `lucide-static`.

FlowSnap generates icons from `lucide-static`; the locator hand-drew a bespoke
SVG sprite in `panel.html` (`#i-react`, `#i-target`, `#i-mouse`…). **Two icon
vocabularies is the single most visible tell that a product used to be two
products**, so the sprite is replaced, not ported. `<use href="#i-…">` does not
survive into DevFlow in any form.

Markup declares an icon by name — `<span data-icon="crosshair"></span>` — and
`hydrateIcons()` fills it in.

Every sprite symbol, resolved:

| Sprite symbol | DevFlow icon | Affordance |
| --- | --- | --- |
| `#i-react` | `atom` | a React component — already FlowSnap's word for it |
| `#i-target` | `crosshair` | **new** · pick a component |
| `#i-mouse` | `mouse-pointer` | hover-to-highlight |
| `#i-cursor` | `mouse-pointer` | the picking view's decorative cursor |
| `#i-tree` | `network` | **new** · the component tree |
| `#i-clock` | `clock` | **new** · recently located components |
| `#i-code` | `code` | **new** · Open in Sources |
| `#i-settings` | `settings` | Settings |
| `#i-close` | `x` | dismiss |
| `#i-check` | `check` | a completed stage |
| `#i-warning` | `triangle-alert` | ambiguity, error banner |
| `#i-copy` | `copy` | copy a path |
| `#i-external` | `arrow-up-right` | Open in Editor — FlowSnap's "leave for another surface" |

Plus one addition the sprite had no equivalent for, because the surface is new:

| Icon | Affordance |
| --- | --- |
| `file-code` | **new** · the source file a step's component was written in — the flow review's per-step affordance (K) |

The spinner stays CSS, as in both repos; `loader-circle` is for in-flight work
inside a button.

---

## 6 · What `SHARED-CORE.md` and `core-drift.mjs` were for

Both are **deleted, not ported** — they police a duplication that no longer
exists. Their reasoning is here, because it is still the reasoning:

`SHARED-CORE.md` documented six files that existed twice by copy, a `core:drift`
script that kept the copies level, and per-file `Ported from … @ <sha>` headers.
It also recorded that extracting a shared package was planned, designed and
**deliberately dropped**, for four reasons. A merged repo dissolves three
outright:

| Reason the package was dropped | Status here |
| --- | --- |
| A third repository with its own release cadence | Gone — one repo, one cadence |
| Version skew between the two extensions | Gone — one extension, one version |
| Neither can `npm ci` from a fresh clone until the package publishes | Gone — the core is a directory, not a dependency |
| Four deliberate behavioural divergences between the copies | **Still real** — resolved below |

The fourth was the real objection, and it is answered one divergence at a time.
None is resolved by "pick one". Each gets a mechanism that makes the wrong choice
**fail loudly** rather than silently produce a wrong answer:

| | Divergence | Mechanism | Fails how |
| --- | --- | --- | --- |
| **D1** | 0-based vs 1-based lines | branded `Pos0`/`Pos1` (§1) | compile error |
| **D2** | `force` on the fiber walk | `getComponentFn(fiber, { force })` — required, no default | compile error, plus a test asserting the capture path passes `force: false` |
| **D3** | `sourcesContent` retention | `parseSourceMap(json, { keepSourcesContent })` | bounded: a missing preview or a larger object, never a wrong path |
| **D4** | fetching and caching in core | `BundleProvider` (§2) | `npm run build:mcp` fails on a `fetch` or `chrome.*` in core |
| **D5** | panel-only code in `classify.ts` | one superset module, tree-shaken | the `build:mcp` bundle grows visibly if UI strings reach the worker path |
| **D6** | `--gutter` meant 32px and 12px | renamed to `--pad-panel` at port time | `lint:tokens` + a W3 grep |
| **D7** | the managed-policy layer | kept, as a third resolution layer (§3.4) | — additive; its absence is the failure |
| **D8** | two settings storage shapes | one-time `rst:settings` migration (§3.4) | a test with a realistic pre-merge blob |
| **D9** | two settings surfaces | one store, two views (§3.4) | `lint:settings-ui` |

**Why D1 gets a type and D3 gets a parameter.** The difference is the failure
mode, not the taste. Get `keepSourcesContent` wrong and you lose a source preview
or carry a bigger object — visible, bounded, harmless. Get the line base wrong and
every file opens one line off, forever, with nothing to notice. A parameter is
safe exactly when being wrong is loud.

---

## Ownership, so no two packages write the same file

This is the property that makes the waves safe to run as separate sessions, and
the one to preserve if packages get resplit. The file lists in
`docs/MERGE-PLAN.md` are the allowlist: a package reads its own sources, its own
destinations, and this file. Nothing else.

Wave 0 owns, and has now written: `package.json`, `tsconfig*`, `vite.*.config.ts`,
`vitest.config.ts`, `eslint.config.js`, `scripts/`,
`src/core/react/{positions,provider}.ts`, `src/shared/types.ts`,
`src/ui/styles/tokens.css`, `src/ui/icons.ts`, `src/ui/icons.generated.ts`, and
this document.
