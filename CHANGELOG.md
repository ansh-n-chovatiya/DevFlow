# Changelog

## Unreleased

**A flow can become a Playwright or Cypress test.** `Export` offers two more
formats beside the zip, the Markdown and the JSON, and they are a runnable spec
rather than a transcript: the selector for each step is chosen by how well it
survives the next refactor — the accessible name first, then role and name, then
the visible text of a button or link, and a CSS path only as a last resort,
where the generated line says in a comment that it is fragile and will break.
Every response the recording captured comes with it as a route mock, so the
test does not need the API that was running when you recorded it. A body that
was cut at the capture cap is left out rather than mocked, and the script says
which call it skipped and why — half a JSON body is not the response the page
received, and a mock that lies is worse than a mock that is missing.

**DevFlow keeps a knowledge graph of the app it has been watching.** Every flow
you send, and every component you pick, is recorded in a small SQLite graph in
`~/.devflow/arkg.db`: which components render inside which, which endpoints
they call, how long those took, and how often they failed. Claude can read it
with three new tools — `get_app_architecture` for the shape of the app,
`get_component_history` for one component over time, and `get_anomalies` for
what is failing or slow relative to its own past. Sending the same recording
twice counts it once, so the numbers mean what they say. Observations older than
90 days are swept on the same pass that enforces flow retention.

The graph is additive and never load-bearing: if it cannot be opened — a corrupt
file, or a native module that will not load after a Node upgrade — the server
says so once and every other tool carries on unaffected.

**Starting a recording asks before it deletes the last one.** The steps from a
recording you have stopped but not saved are not written anywhere else, and
`Start recording` swept them silently, from a button sitting directly above the
card counting them. It now says how many are about to go, and `Reload and
record` asks before the reload rather than after.

**A component whose file was found says why it cannot be opened.** When no
project root is set, the path resolves and `Open in Editor` cannot use it. The
explanation for that was a tooltip on a disabled button, which Chrome does not
render — so the first run of every install showed a correct source path beside a
dead button with nothing to say why. It is on the card now.

## 3.1.1 — 2026-08-29

**The panel's result view reads in the right order.** `Source preview` is the
picked component's own code, so it now sits directly under the card that named
it. The filter field and the category chips move down to where they belong —
immediately above the trees they act on. They used to be interleaved: the
filters sat between the card and a preview they do not filter, which left the
chips stranded from the list they control.

**One copy button on the result card, not two.** `onCopyPath` turned the path
line into a button — the path is its text, `Copy path` is its label, and the copy
icon sits at the end of the very string it copies — and *also* added a `Copy` to
the action row, which fired the identical handler with the identical argument
while saying nothing about copy what. The row is for going somewhere; the second
button is gone and `Open in Editor` and `Open in Sources` get the room back.

**`Pick another`, spelled the way the panel spells it.** The card said
`Pick Another`; the status bar six pixels below it said `Pick another`, which is
also what CONTRACTS §4.4 freezes.

## 3.1.0 — 2026-08-29

**Locating is the DevTools panel's alone.** The popup's **Locate component**
action is gone, along with the detached window behind it and the **Recent** card
it fed. It could show you where a component was written and then not take you
there: `Open in Sources` needs a DevTools window to reveal a compiled position
in, and a popup has none — so every answer arrived one action short of the one
people actually wanted next. Picking, the parent tree, the siblings, the history
and both `Open in` actions now live in one surface that can serve all four:
**React Locator**, in DevTools beside Elements and Sources.

Nothing about recording changes, and nothing about attribution changes: a
recorded step still carries the component it happened in, resolved in the service
worker, whether or not DevTools was ever opened.

Upgrading drops the now-unread `lastLocate` key, which was otherwise counted into
the storage figure in the popup's footer for good.

**The popup no longer squashes itself.** Its body is a flex column with a bounded
height, so once the content passed 600px Chrome compressed **Start recording**
from 40px down to its line box instead of scrolling. It scrolls.

## 3.0.0 — 2026-08-29

**DevFlow 3.0.0 replaces two extensions: DevFlow 2.7.1 and react-source-locator
2.2.0.** Both are superseded; neither will get another release. The version is 3
rather than 1 because it continues from the higher of the two — an installed
DevFlow should see this as an upgrade, not as something older.

Everything both extensions did, DevFlow does. What follows is what actually
changes for someone who had one of them, because most of it is invisible and two
things are not.

The one line worth reading first: **flows recorded by DevFlow 2.7.1 still read.**
The flow schema is unchanged, and so are the MCP server's wire contract, its
`~/.devflow` directory and its tools. Nothing you have recorded needs redoing.

**One thing does need redoing: the MCP registration.** The server is published
under a new name — `devflow-mcp-server`, not the 2.7.1 package — so an existing
`npx -y flowsnap-mcp` registration keeps resolving to 2.7.1 forever and upgrades
to nothing. It does not break; it just silently stops moving, which is worse.
Re-register once:

```sh
npx -y devflow-mcp-server install --force
```

`--force` is what replaces a user-scope registration that points somewhere else.
The registration is still named `devflow`, so nothing you type at Claude changes.

---

### If you had react-source-locator

**Your settings are carried across, once, on install or update.** They were one
JSON blob under a single key; DevFlow stores flat keys, sparsely, so the blob is
read and mapped:

| Was | Is now |
| --- | --- |
| `editor` | `editor` |
| `customEditorTemplate` | `customEditorTemplate` |
| `projectRoot` | `projectRoot` |
| `useSourceMaps` | `react.useSourceMaps` |
| `hidden.<category>` | `locator.hidden.<category>` |
| `hideFrameworkComponents` (pre-2.0) | every `locator.hidden.*` |

The mapping is total — every field the old shape had has somewhere to go,
including the one that stopped existing two versions ago — and sparse: a value
you had left at its default is not written, so a later release's better default
still reaches you. Everything is validated on the way through, because a blob can
name an editor this build has never heard of exactly as a hand-edited profile
can.

It is idempotent without a marker flag, which matters on a second machine: a key
already in your synced settings is never overwritten, since the blob is by
definition the older document, and the blob is removed once the mapping has
landed. A device that migrates later does not undo a change you made in between.

**Managed policy still works, unchanged.** `editor` and `projectRoot` pushed
org-wide through `chrome.storage.managed` are still read, still win over a user's
own value, and still show the field disabled rather than silently overriding it.
The policy reader keeps reading the old blob shape **permanently** — managed
storage is read-only to an extension, so there is nothing DevFlow could migrate,
and an organisation moves to flat keys by editing its own policy file when it
chooses to. An existing deployment needs no change.

**The permission prompt is gone.** The old build asked for `<all_urls>` at
runtime, through a dialog, the first time you picked on a page. DevFlow holds the
same origins as a static grant declared in its manifest, which is a superset — so
there is nothing left to ask for. You will see the permissions at install time
instead, and there are more of them than before (`downloads`, `unlimitedStorage`,
`activeTab`): DevFlow also records, and recording writes files and keeps them.

**Locating no longer requires DevTools.** The DevTools panel is still there and
is still the fuller surface — the parent tree, siblings, the picker's own
settings drawer. But the toolbar popup now has **Locate component**, which arms
the same picker and shows the same result. The engine reads the page's bundles
through the service worker when DevTools is closed and through the DevTools
resource cache when it is open; it cannot tell which answered.

**The panel looks different, and is named DevFlow.** The hand-drawn icon sprite,
the "React Source" hero and its spinning mark are gone in favour of one icon set
and one shell shared with every other surface. The tab in the DevTools strip
reads **DevFlow**.

**Two hardcoded numbers became settings.** Bundle fetches ran at a fixed
concurrency of 6; that is now `react.resolveConcurrency` (default 4), and it is
the same number the background pass uses. The bundle and source-map caches were
unbounded `Map`s that lived as long as the panel; they are bounded now, by
`react.bundleCacheEntries` and `react.bundleCacheBytes`, and a resource that
could not be read is no longer remembered as unreadable for the life of the
session.

**Theme.** The panel followed DevTools' own theme. DevFlow has an explicit
Theme setting, and it wins whenever it is not "System". When it *is* "System",
DevTools' theme is still what the panel resolves against — a panel obeying the OS
sits inside a dark DevTools window wearing the light palette.

**Page globals.** Nine became two, and both are now under a `__DEVFLOW_` prefix.
Nothing polls the page on a timer for a pick result any more; it is pushed the
moment it happens.

---

### If you had DevFlow

**Recording is unchanged.** Flows, the library, review, annotation, export, send,
the MCP server and every existing setting behave as they did. The flow schema
version is the same, so old recordings open.

**Picking is new.** There is a DevTools panel — **DevFlow**, beside Elements and
Sources — and a **Locate component** action in the popup. Point at anything on
the page and get the component that rendered it, the file and line it was written
in, and **Open in Editor**. Recorded steps already carried this; now you can ask
for one without recording anything.

**Six new settings**, all under *React & source resolution*:

| Key | Default | |
| --- | --- | --- |
| `react.useSourceMaps` | `true` | read source maps for one interactive locate |
| `locator.hidden.routing` | `true` | hide routers, routes and switches in the component trees |
| `locator.hidden.providers` | `true` | hide context, store and client providers |
| `locator.hidden.react` | `true` | hide React's own internals — Fragment, Suspense, Portal, lazy and memo |
| `locator.hidden.styling` | `true` | hide theme, style-engine and headless UI primitives |
| `locator.hidden.dependency` | `true` | hide anything else living in `node_modules` |

`react.useSourceMaps` is deliberately **not** the existing "Find the file each
component was written in". One gates a single lookup you are waiting for; the
other gates the background pass a whole recording depends on. Merged, you would
have had to stop resolving a recording in order to stop a slow pick.

**Managed policy is new.** `editor` and `projectRoot` can now be pushed org-wide
through `chrome.storage.managed`.

**Settings are regrouped, without moving.** The eleven groups are the same
eleven and every one of the 73 existing settings is still in the group it was in.
What is new is a layer above them: four concepts — *React & source resolution*,
*Recording*, *Export & MCP*, *Appearance* — so the rail reads as four blocks
rather than a list of eleven. One heading changed with it: **React components**
is now **React & source resolution**, because it is now also where picking is
configured.

One behaviour did change: **Project root** and **Editor** no longer depend on
"Record the React component behind each step" being on. They hung off it while a
recording was the only thing that produced a source path. Picking produces one
too, so someone who only ever picks would have found the two fields their whole
workflow rests on greyed out under a sentence about recording.

**The extension is now "DevFlow — Record & Locate"**, and the manifest declares a
`devtools_page`.

---

### Under both of them

One React and source-map engine where there were two copies. Six concerns —
the VLQ decoder, the source-map reader, the fiber walk, the needle builder, the
bundle search, the editor URL builder — existed twice, kept level by hand and by
a drift script. They exist once. The four places where the two copies were
deliberately different are each answered by something that fails loudly instead
of quietly producing a plausible wrong answer; `docs/CORE.md` is the description
and `docs/CONTRACTS.md` §6 is the ledger.

One page agent, shipped by the manifest at document start, serving the recorder
and the picker. The old build read its agent out of the extension's own files and
`eval`'d it into the page on demand, which also meant exposing that file to every
page on the web; DevFlow does not, and is not fingerprintable by it.

One result card. The DevTools panel, the popup and the flow review render the
same component built once, so a match count added for one of them appears in all
three rather than in whichever asked first.
