# DevFlow

**The Ambient Runtime-to-Source Intelligence Platform.**
*Record what happened in the browser, trace causality across runtime state, link directly to source code AST, and accumulate living knowledge of your application across every session.*

DevFlow is an AI-assisted developer platform and Chrome extension for understanding, navigating, debugging, and modifying web applications. By connecting **live browser execution (DOM, React Fiber, state stores, wire requests) ↔ source code AST ↔ Accumulating Runtime Knowledge Graph ↔ AI coding agents**, DevFlow enables deterministic, automated development workflows — not just when something breaks, but continuously as you build.

---

## 🧭 Platform Vision & Architecture

- 🌟 **[Grand Vision & Architecture (`VISION.md`)](./VISION.md):** The core thesis, Accumulating Runtime Knowledge Graph (ARKG), unified runtime-to-source graph, 10 novel capabilities, 18-stage autonomous debugging loop, prioritization matrix, competitive moat analysis, and the ultimate 2–3 year vision.
- 🗺️ **[Implementation Roadmap & Phased Plan (`ROADMAP_AND_PHASES.md`)](./ROADMAP_AND_PHASES.md):** 5-phase rollout plan (Phase 0: ARKG Foundation → Phase 5: Ambient Intelligence Platform), modular work streams, and production-grade engineering benchmarks.

```
       TRADITIONAL AI CODING TOOLS                     DEVFLOW CORE MOAT
┌──────────────────────────────────────┐     ┌──────────────────────────────────────┐
│  Static Codebase + LLM + Terminal    │     │      LIVE RUNTIME EXECUTION FABRIC   │
│  • Guesses runtime state             │     │  (DOM + Fiber + State + Wire + DB)   │
│  • Reads logs post-facto             │     │                  ↕                   │
│  • Blind to UI/render lifecycle      │     │  UNIFIED RUNTIME-TO-SOURCE GRAPH     │
│  • Trial-and-error reproduction      │     │                  ↕                   │
│                                      │     │ ACCUMULATING APPLICATION INTELLIGENCE│
└──────────────────────────────────────┘     └──────────────────────────────────────┘
```

### The Strategic Difference

Other AI tools are debuggers you invoke when something breaks. DevFlow is the **ambient intelligence layer** between your running application and your source code — always on, accumulating knowledge of your app across every session, every developer, and every deployment. The Accumulating Runtime Knowledge Graph (ARKG) is DevFlow's deepest competitive moat: it knows your application's normal behavior, its history, and its architecture as well as your best senior engineer does.

---

## What it does today

**Record a flow.** Open the popup, press **Start recording**, and use the page.
Clicks, typed values and navigations become steps; network calls and console
lines attach to the step that caused them rather than to one long timeline, which
is the difference between "there was a 500 somewhere" and "the Checkout button
did this". Screenshots are captured per step. Stop when the bug has happened.

**Read it back.** The **Library** lists your flows; **Flow review** walks one of
them. Each step shows what was done, what broke, and — on a React page — the
component that rendered the element, with a click through to its source.

**See what a click set off.** **What this caused** on any step draws the cascade:
the stores that moved, the components that re-rendered, the requests that went
out and the console lines that came back, in causal order. Every arrow says what
it is made of — whether DevFlow *observed* that component reading that store, or
only matched a name, or only saw the two happen in the same step. A component
with no evidence connecting it to anything hangs off the interaction rather than
off whatever store happened to move, because a graph that joined those would be
inventing the answer.

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
with a sentence and a confidence score, because *this component has no source* is
discouraging and usually untrue, while *most likely a lazy chunk that was never
fetched* tells you to load that route and pick again.

An ambiguous match says how many places matched and across how many scripts. The
path it offers may be the wrong one of them, and that is better learnt before you
open it than after you edit it.

When the compiled position is known but the original is not, the card still
offers **Open in Sources** in the DevTools panel — the minified line is a worse
answer than the original, and a much better one than nothing.

### The optional plugin, and what it is not for

None of the above needs anything installed in your application. DevFlow reads
the page's own bundles, and that is the path it is built and tested around.

There are builds that path cannot answer for — a bundle shipping no source map,
a map hosted somewhere the browser will not fetch from, a compiled body that
genuinely appears in more than one place. For those there is
[`@devflow/compiler-plugin`](./compiler-plugin/README.md), a Babel plugin that
writes each component's own file and line onto the component function at build
time. It is not the fix for poor attribution generally: the common failure is a
lazy chunk that never loaded, and a chunk that did not load carries no stamp
either.

Nothing in DevFlow requires it, every attribution says which path answered it
(the card reads `build stamp`), and the plugin covers Babel builds only — SWC,
which is what `@vitejs/plugin-react-swc` and Next.js use, takes no Babel plugin
at all.

---

## Where DevFlow is going

What is described above is what works today. The roadmap below is what is being
built, and a phase is called done when `npm run verify` proves it — see the
status key at the top of [`ROADMAP_AND_PHASES.md`](./ROADMAP_AND_PHASES.md).

| Phase | Capability | Status |
|---|---|---|
| **Phase 0** | Accumulating Runtime Knowledge Graph (ARKG) — the foundational data layer | In progress: the graph, its ingestion pipeline and its three MCP tools are in. `state_keys` and `git_commits` nodes wait on Phases 1 and 3 |
| **Phase 1** | Runtime-to-Source Intelligence: source mapping with confidence scoring, causal threading, "Why did this render?" | Partly done: source mapping and the locator are the shipped product. Causal threading, state-store inspection and render blame are not started |
| **Phase 2** | Autonomous bug reproduction, "Why is this value here?" provenance, Interaction-to-Test compiler, natural language app navigator | Started: the Interaction-to-Test compiler exports Playwright and Cypress. The rest is Months 4–6 |
| **Phase 3** | Full-stack wire & DB lineage (OTel), Living Architecture Map, Temporal Diff & regression detection, Source → Browser live link | Closed: trace headers, OTel span ingest, value lineage to the backend, cross-deploy comparison, the Living Architecture Map and the cascade are all in. The map turned out not to need a live connection — it is a reading with an age on it, because a tool call is a moment and not a stream. The Vue/Svelte/RSC adapters are deferred to Phase 5 as the three separate work streams they are |
| **Phase 4** | Production telemetry ingestion, autonomous regression watcher (CI), self-healing CI bot, Accessibility Autopilot | Months 10–12 |
| **Phase 5** | Team intelligence, counterfactual replay, platform-level ambient intelligence | Year 2+ |

The ultimate experience: a developer right-clicks a broken button, types *"Why is this disabled?"*, and gets an instant answer tracing the exact state, the event that set it, the source line, and the commit that introduced the bug — along with a two-line fix, a generated test, and a PR link. Under 5 minutes. Zero manual investigation.

---

## Surfaces

| | Where | For |
| --- | --- | --- |
| **Popup** | the toolbar button | start, pause and stop a recording |
| **Panel** | the DevTools panel, "React Locator" | locating: picking, the full component tree — **Parent tree**, **Siblings** — and **Recent**. Also **Read architecture**, which is about the page rather than about any pick |
| **Library** | opens in a tab | every flow you have kept |
| **Flow review** | a flow in that tab | one recording, step by step, with annotation, export and send — and **What this caused** on any step, which draws what the interaction set off |
| **Settings** | the extension's options page | the whole table, grouped by concept |

Picking is the panel's, and only the panel's. The popup used to offer it too,
from a small window of its own, but a popup has no DevTools window to reveal a
compiled position in — so **Open in Sources** was missing from every answer it
gave, at exactly the point somebody wanted to act on one. The panel has the
Sources window, the component tree and the history beside it.

The recorder still attributes each step to the component it happened in, whether
or not DevTools was ever opened: that runs in the service worker, over the
scripts the page reported while recording, under explicit concurrency and size
budgets. Same engine as the panel, same answer, same card.

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

The MCP server (`devflow-mcp-server`) lets Claude Code inspect flows recorded by DevFlow. You only need to set it up **once globally** on your machine — no need to run setup commands in individual projects:

```sh
npx devflow-mcp-server install
```

That runs `claude mcp add devflow --scope user -- npx -y devflow-mcp-server`. The
user-scope flag registers the server globally, making it immediately available across all your repositories and workspaces without any per-project setup.

Then record a flow in DevFlow and press **Send to Claude**. It lands in `~/.devflow/flows`
and Claude can read it immediately — `get_flow_summary` for whether it broke at all,
in under 400 tokens, `get_flow_errors` for just what broke, `get_step_detail` for one
part of one step, `get_source_snippet` for the lines the component was written on, and
`compare_flows` for a working run beside a broken one, and
`compare_flows_across_deploys` for two recordings of one flow made at two commits —
which endpoints answered differently, what shipped in between, and which of the
changed files DevFlow has actually watched code run in.

Accessibility findings, when the audit was on for a recording, arrive on the step
they were found in: `get_step_detail` with the `a11y` part gives each violation
with its WCAG criterion, what was measured, and the component and file it lives
in. It says nothing about a fix — that is ADR 0009's line, and the caller is the
model. Where it could not measure something it says so rather than guessing:
contrast behind a gradient is skipped, not compared against an assumed white, and
whether focus is *trapped* in a dialog is not tested at all, because that would
mean pressing Tab in somebody's application.

`get_living_architecture` is the one that is not about a recording at all. Press
**Read architecture** in the panel and DevFlow reads the page in front of you —
every component mounted right now, how many of each, and which React contexts
they read — and Claude can ask for it. It is a reading with an age printed on it
rather than a live feed, because a tool call is a moment: the answer says how long
ago it was taken and, once that is more than a few minutes, says so in place of
claiming the page still looks like that. It carries no prop, no state and no store
value — structure only — because it is taken while you are reading code rather
than while you are recording, and nothing about it is stored between server
restarts. Screenshots are written to disk
and referenced by absolute path, so a 500-step recording costs nothing in context until
a specific image is opened.

`get_commit_candidates` reads your repository beside the graph, because neither
half answers alone. Git knows every commit that touched a file; DevFlow knows the
last moment it actually watched the component in that file run. Crossed, they give
the commits whose effect has never been observed — the shortlist worth reading
first when something is misbehaving. It names no cause and says so on every
answer: a commit that changed the file is not thereby the reason anything broke,
and the tool compares where commits sit in the history, not behaviour.
`get_blast_radius` is the other direction — what the runtime has seen in one
source file, and what those components were seen calling — and it is careful to
claim only that: components observed to have been *written in* the file, never the
files that import it, because an import is a static fact and nothing in a runtime
graph observes one.

With `DEVFLOW_WEBHOOKS=1` the server also accepts a relayed production crash and
joins it to the files its stack reaches, so `get_blast_radius` answers "what does
the runtime know about this file" and "what are users hitting in it" together.
Sentry cannot reach a loopback port, so that delivery is one you relay or replay —
see [`mcp-server/README.md`](mcp-server/README.md) — and almost nothing from the
payload is kept: the exception type but never its message, the culprit and the
count, and each frame's filename and line. No user, request, cookies, body or
breadcrumbs are read at all.

The server reads the commit of the project it runs in and stamps each recording with
it, which is what makes the cross-build comparison possible. It only ever reads the
repository, and a directory that is not one simply means no stamp — see
[`mcp-server/README.md`](mcp-server/README.md) for what the stamp does and does not
claim.

See [`mcp-server/README.md`](mcp-server/README.md) for its tools, its retention
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
| **Audit accessibility while recording** | off by default, and the only capture that is. On, each interaction is followed by a bounded read of the settled page: contrast against the colours the browser actually computed, missing accessible names, controls the keyboard cannot reach, and whether focus moved into a dialog that opened. Every violation names the WCAG criterion and the component it was found in |
| **Theme** | System, Light or Dark. In the DevTools panel "System" means the theme DevTools itself is set to, which DevTools lets you choose independently of the OS — a panel obeying the OS sits inside a dark DevTools window wearing the light palette |

Settings sync across your Chrome profile, sparsely: only what you have actually
changed is stored, so a later release's better default still reaches you.

**Trace headers, and the one thing DevFlow will not do without being asked.**
Everything above only decides what DevFlow *writes down*. Under Advanced there
are two switches that decide what your application *sends*: while a flow is
recording, an outbound request can carry `X-DevFlow-Trace-Id`, or W3C
`traceparent`, holding the same id the recording shows — so the request in front
of you can be found in your own backend's logs by searching for that id.

Both are off by default and neither does anything outside a recording. And
neither touches a **cross-origin** request until you name that origin, because a
request that gains a custom header stops being a *simple* request: the browser
sends a preflight it did not send before, and a backend that does not allow the
header fails the request outright. Same-origin requests are exempt from CORS and
cannot fail that way, so those are traced freely. Naming an origin is you saying
that backend accepts the header — there is no way for DevFlow to find that out
except by sending the request that might fail.

**Managed policy.** `editor` and `projectRoot` can be pushed org-wide through
`chrome.storage.managed`. A managed value wins over a user's own and the field is
shown disabled rather than silently overridden.

**Settings travel with a flow.** Most of what the MCP server decides — the
response budget, how many screenshots a call returns, how much of a body is
quoted — is a property of the *recording*, so it is stamped into the flow and the
server renders that flow under it. Three settings cannot travel that way because
they are true of the machine rather than of any flow: the port and the two
retention ceilings. Those live in `~/.devflow/config.json`, which the extension
writes for you.

---

## Where things go

Flows are stored in the extension, on your machine. Nothing is uploaded. The MCP
server binds to loopback and writes to your home directory, and refuses any
request carrying a web page's `Origin` — a loopback port is reachable from any
page you happen to have open.

**Captured request and response bodies are not redacted.** Headers are, and so
are the credential-bearing parameters of a URL: `?code=`, `?access_token=`,
`?session=` and their kin are masked to `[redacted]` as the step is captured, in
the fragment as well as the query, so an OAuth callback recorded mid-flow does
not keep its code. Bodies are not touched, because a body is usually the thing
you are debugging — a recorded flow can contain whatever your app sent,
including tokens in payloads.

What survives in a URL is the parameter *names*, which is deliberate: a step
whose query was stripped is unreadable as a record of where the user was. It
also means the mask is a list, and a list is never complete — `state` and
`nonce` are left alone as CSRF machinery rather than secrets, and a flow
recorded before URL masking existed still holds whatever it held. The send
dialog says so when it sees them.

That is why auto-send is off by default, and why both the export and send
dialogs let you drop the network data, the console output, the screenshots or
the component table before a flow leaves the extension — each with the bytes it
would cost beside it.

---

## Developing

```sh
npm run verify   # typecheck · eslint · tokens · settings UI · graph config · tests · five builds
```

`verify` is the gate; the pieces run on their own too (`npm run typecheck`,
`npm test`, `npm run lint:tokens`, …). CI runs the same thing, enforces that changes to `src/` or `public/` are documented in `CHANGELOG.md` (`npm run lint:changelog`), and additionally
loads the built `dist/` far enough to prove Chrome would accept it.

Releases are cut on demand:
- **GitHub Actions:** Run the **Release** workflow with your chosen bump (`patch`, `minor`, `major`).
- **Locally:** Run `npm run release <patch|minor|major>` and push tags with `git push origin main --tags`.

The layout, the invariants a change has to hold to and the gate behind each of
them are in [`CLAUDE.md`](CLAUDE.md); the engine everything above shares is in
[`docs/CORE.md`](docs/CORE.md).

## Licence

MIT.
