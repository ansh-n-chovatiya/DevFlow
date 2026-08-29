# DevFlow

**Record what happened in the browser, and find the file it happened in.**

DevFlow is a Chrome extension for debugging your own web app. You record a flow —
a run through the thing that is broken — and every step comes back with the
element you touched, the requests it fired, the console output it produced, a
screenshot, and, on a React page, the component behind it and **the file and line
that component was written in**. Or you skip the recording entirely, point at
something on the page, and get the same answer for that one component.

Both are the same question — *where in my code is this?* — so both go through the
same engine and come back on the same card, whether it was reached from a picked
element or from a step recorded twenty minutes ago.

The end of that is usually a keystroke: **Open in Editor** puts your cursor on
the line.

---

## What it does

**Record a flow.** Open the popup, press **Start recording**, and use the page.
Clicks, typed values and navigations become steps; network calls and console
lines attach to the step that caused them rather than to one long timeline, which
is the difference between "there was a 500 somewhere" and "the Checkout button
did this". Screenshots are captured per step. Stop when the bug has happened.

**Read it back.** The **Library** lists your flows; **Flow review** walks one of
them. Each step shows what was done, what broke, and — on a React page — the
component that rendered the element, with a click through to its source.

**Pick a component.** **Pick component** arms a crosshair; click any element and
DevFlow walks the React tree above it, names the component, and resolves it
through the page's source maps back to the original file, line and column. On a
production build with maps served, that is your real `src/` path, not a minified
chunk.

**Hand it to Claude Code.** **Send to Claude** posts the flow to a local MCP
server and puts a prompt on your clipboard. Claude reads the walkthrough, the
failing steps, the response bodies and the screenshots, and already knows which
files to open, because the components' sources travelled with the flow.

### Locating, and what it honestly reports

Finding the file works most of the time and not always, and when it does not,
DevFlow says which way it failed instead of showing a blank. A bundle served
without a source map, a map that would not parse, a component sitting in a lazy
chunk the page never loaded, a match found in more than one place — each comes
with a sentence, because *this component has no source* is discouraging and
usually untrue, while *most likely a lazy chunk that was never fetched* tells you
to load that route and pick again.

An ambiguous match says how many places matched and across how many scripts. The
path it offers may be the wrong one of them, and that is better learnt before you
open it than after you edit it.

When the compiled position is known but the original is not, the card still
offers **Open in Sources** in the DevTools panel — the minified line is a worse
answer than the original, and a much better one than nothing.

---

## Surfaces

| | Where | For |
| --- | --- | --- |
| **Popup** | the toolbar button | start, pause and stop a recording; **Locate component** without opening DevTools |
| **Panel** | the DevTools panel, "DevFlow" | picking with the full component tree — **Parent tree**, **Siblings** and **Recent** |
| **Library** | opens in a tab | every flow you have kept |
| **Flow review** | a flow in that tab | one recording, step by step, with annotation, export and send |
| **Settings** | the extension's options page | the whole table, grouped by concept |

Picking works from the popup **and** from the panel because the engine does not
depend on DevTools being open. The panel reads the scripts DevTools has already
cached, so it re-fetches nothing and sees scripts that loaded before anything was
watching; the popup path collects them from the page and fetches in the service
worker, under explicit concurrency and size budgets. Same engine, same answer,
same card.

---

## Install

There is no store listing yet. Build it and load it unpacked.

```sh
npm install          # also installs the MCP server's own dependencies
npm run build        # writes dist/
```

Then in Chrome: `chrome://extensions` → **Developer mode** on → **Load unpacked**
→ pick `dist/`.

Chrome 116 or newer. Node 20.11 or newer to build.

`npm run build` runs five builds, not one: the extension pages and the service
worker, the content script and the MAIN-world page agent (each its own bundle,
because a manifest-declared content script is a classic script and cannot be a
module), and `src/core/` bundled into the MCP server package as plain Node ESM.

---

## Giving a flow to Claude Code

The MCP server is a separate npm package. Register it once, for every project:

```sh
npx flowsnap-mcp install
```

That runs `claude mcp add flowsnap --scope user -- npx -y flowsnap-mcp`. The
scope flag is the whole reason the command exists: `claude mcp add` defaults to
*this directory*, so the same line typed without it gives you a server that works
in one folder and is silently absent everywhere else. `install` never takes a
scope.

Then record a flow and press **Send to Claude**. It lands in `~/.flowsnap/flows`
and Claude can read it immediately — `get_flow_errors` for just what broke,
`get_latest_flow` for what you just did, `compare_flows` for a working run beside
a broken one. Screenshots are written to disk and referenced by absolute path, so
a 500-step recording costs nothing in context until a specific image is opened.

The package is not named after the extension, and keeps the name it publishes
under: renaming it would leave every project that has already registered it
pointing at a package that no longer exists, and nothing would say so. See
[`mcp-server/README.md`](mcp-server/README.md) for its tools, its retention
ceilings and how it is configured.

---

## Settings

Every setting lives in one table and is derived from it — the type, the defaults,
the options page, the reset affordance and the shipped `settings.default.json`
all come from the same rows, so a setting cannot exist in one of them and not the
others. They are grouped by what they are about, not by which part of the product
reads them.

The ones worth setting on day one:

| Setting | Why |
| --- | --- |
| **Editor** | the program **Open in Editor** hands a source to. VS Code, VS Code Insiders, Cursor, Windsurf, WebStorm/JetBrains, Sublime Text, Zed, or a custom URL template |
| **Project root** | the absolute local path a source path is resolved against. Source maps give you `src/components/Cart.tsx`; your editor needs the other half |
| **Find the file each component was written in** | the background pass that gives every recorded step a source. Off, and a flow still records — it just arrives without file names |
| **Read source maps when you locate one component** | the same, for one interactive locate. Deliberately a separate switch: you should be able to stop a slow pick without turning off the pass a recording depends on |
| **Capture screenshots** | screenshots are most of a flow's size and most of its value; the quality dial sits beside this one |
| **Capture request/response bodies** | the most useful thing in a flow and the most likely to hold something private. Headers are always stripped; bodies are not |
| **Theme** | System, Light or Dark. In the DevTools panel "System" means the theme DevTools itself is set to, which DevTools lets you choose independently of the OS — a panel obeying the OS sits inside a dark DevTools window wearing the light palette |

Settings sync across your Chrome profile, sparsely: only what you have actually
changed is stored, so a later release's better default still reaches you.

**Managed policy.** `editor` and `projectRoot` can be pushed org-wide through
`chrome.storage.managed`. A managed value wins over a user's own and the field is
shown disabled rather than silently overridden.

**Settings travel with a flow.** Most of what the MCP server decides — the
response budget, how many screenshots a call returns, how much of a body is
quoted — is a property of the *recording*, so it is stamped into the flow and the
server renders that flow under it. Three settings cannot travel that way because
they are true of the machine rather than of any flow: the port and the two
retention ceilings. Those live in `~/.flowsnap/config.json`, which the extension
writes for you.

---

## Where things go

Flows are stored in the extension, on your machine. Nothing is uploaded. The MCP
server binds to loopback and writes to your home directory, and refuses any
request carrying a web page's `Origin` — a loopback port is reachable from any
page you happen to have open.

**Captured request and response bodies are not redacted.** Only headers are. A
recorded flow can contain whatever your app sent, including tokens in payloads,
and URLs keep their query strings, so an OAuth callback recorded mid-flow keeps
its `?code=`. That is why auto-send is off by default, and why both the export
and send dialogs let you drop the network data, the console output, the
screenshots or the component table before a flow leaves the extension — each with
the bytes it would cost beside it.

---

## Developing

```sh
npm run verify   # typecheck · eslint · tokens · settings UI · graph config · tests · five builds
```

`verify` is the gate; the pieces run on their own too (`npm run typecheck`,
`npm test`, `npm run lint:tokens`, …). CI runs the same thing and additionally
loads the built `dist/` far enough to prove Chrome would accept it.

The layout, the invariants a change has to hold to and the gate behind each of
them are in [`CLAUDE.md`](CLAUDE.md); the engine everything above shares is in
[`docs/CORE.md`](docs/CORE.md).

## Licence

MIT.
