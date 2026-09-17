# devflow-server

Gives Claude Code the browser flow you just recorded — the clicks, the console
errors, the failed requests and their bodies, and a screenshot of every step —
so it can fix the bug in your project instead of being told about it.

Pairs with the DevFlow Chrome extension, which is what records the flows and
posts them here.

**On the name.** The binary, the server's MCP name (`devflow`) and the
`~/.devflow` directory keep the names they were published under, because a
rename there would leave every recording anyone has kept in a directory nothing
reads — and nothing would say so.

The npm package is the one exception, and it has now moved twice — neither time
by choice.

**It publishes as `devflow-server`.** The obvious name, `devflow-mcp`, was taken
on npm by an unrelated package before this one existed. The name this server
*used* to publish under, `devflow-mcp-server`, is still on npm at 3.0.0 — but
the account that owns it was lost and cannot be recovered, so nothing can ever
be published to it again. The same is true of `flowsnap-mcp` at 2.7.1.

**If you installed either of those, they still work and will never update.** They
are frozen at the last version their old owner published. Nothing breaks; it
just stops moving, and npm has no way to tell you that. Move across with:

```sh
npx -y devflow-server install --force
```

`--force` is what replaces a user-scope registration that points at the old
package. The extension is DevFlow; this is the server it talks to.

## Install (Global Setup)

Register once globally on your machine — all your projects and workspaces can use it immediately without any per-project setup:

```sh
npx devflow-server install
```

Once, globally, for every project you open — the Claude Code CLI and the VS Code extension
alike. Nothing to clone, nothing to build, and safe to run again.

It runs `claude mcp add devflow --scope user -- npx -y devflow-server` for you.
Setting up at user scope (`--scope user`) ensures DevFlow is available globally across all your repositories. You do not need to run this per project or add `.mcp.json` to individual folders.

| | |
| --- | --- |
| `npx devflow-server install` | Register globally for every project |
| `npx devflow-server install --force` | Replace a user-scope registration pointing elsewhere |
| `npx devflow-server uninstall` | Remove the user-scope registration |
| `npx devflow-server` | Run the server — what Claude Code does |

**The command name is `devflow-mcp`, not `devflow-server`, if you install globally.**
This package's `bin` entry — the one thing on this page still named for the npm
name this server published under before the name freeze above ("the binary...
keep[s] the name it was published under") — is `devflow-mcp`, while the package
itself is `devflow-server`. The two invocation paths this leaves:

- **`npx devflow-server ...`** (every command on this page) always works,
  regardless of the mismatch: `npx` resolves a package name to its sole `bin`
  entry and runs that, whatever it is called.
- **`npm install -g devflow-server`** installs a global command named
  `devflow-mcp`, not `devflow-server` — the natural guess after a global
  install fails with `command not found`. Run `devflow-mcp` (or
  `devflow-mcp install`, `devflow-mcp regression`, …) instead.

`npx` is what every instruction above and the one-line installer at the top of
this file use, so most readers never hit this. It is called out here because
the mismatch is real and undocumented anywhere else, not because the global
path is the recommended one.

If a project has its own `.mcp.json` naming `devflow`, that local entry takes precedence inside that directory. `install` detects this and gives you the line to remove it if you want to use the global registration instead.

Then record a flow in DevFlow and press **Send to Claude**. It lands in
`~/.devflow/flows` and Claude can read it immediately.

## Tools

| Tool | Use it for |
| --- | --- |
| `list_flows` | What has been recorded, newest first, with a count of failing steps |
| `get_flow_summary` | One flow in under 400 tokens — what it was, what broke, what to open |
| `get_flow_errors` | Only the steps that broke |
| `get_step_detail` | One part of one step: its network, console, element, component or text change |
| `get_flow_step` | One step entire, with bodies kept four times longer |
| `get_source_snippet` | The lines a component was written on, read off this machine |
| `get_flow` | The whole recording: walkthrough, step data, screenshot paths |
| `get_flow_screenshots` | Images inline, when reading files from disk isn't possible |
| `get_latest_flow` | The recording you just made |
| `compare_flows` | A run that worked beside one that did not |
| `compare_flows_across_deploys` | Two recordings of one flow made at two different commits, and what shipped between them |
| `replay_flow` | Run a recorded journey again with your own Playwright, and say whether it still passes |
| `diagnose_failure` | Everything one recording says about what broke, plus whether it has failed before |
| `get_causal_chain` | What led to one event in a recording, walked backwards to the interaction |
| `get_effects_of` | What followed from one event, walked forwards — the same graph as `get_causal_chain` |
| `get_state_patch` | How the app's own state changed across a step or a range of steps, as a JSON Patch |
| `get_value_provenance` | Where one on-screen value came from — response, store, component, element, and backend trace |
| `get_backend_trace` | The span tree your backend exported for one traced request |
| `explain_feature` | Which components, endpoints, files, flows and stores a description points at |
| `suggest_actions` | What can be done on a page, drawn only from what recordings actually did |
| `get_app_architecture` | What every recording together says about the app |
| `get_component_history` | Everything observed about one component |
| `get_anomalies` | What has started failing or slowing recently |
| `get_living_architecture` | What is mounted on the open page, as of when it was read |
| `get_commit_candidates` | Which commits changed a component's file, and which of them has never been watched running |
| `get_blast_radius` | What the runtime has observed in one source file, and what it was seen calling |

`get_living_architecture` is the only one that is not about a recording, and it
is the only one whose answer can go out of date while you read it. It is a
**reading with an age**, not a feed: somebody presses **Read architecture** in the
DevFlow panel, the extension takes one bounded walk of the page's component tree
and posts it here, and the tool renders that with its age and its URL on the first
line. Past ten minutes the answer stops saying *this is mounted* and starts saying
*this was the last reading*. It carries structure and no values — component names,
source paths where the page knows them, and which React contexts each component
reads — and it is held in memory only, so a server restart loses it, which is
correct: a saved map can only describe a page that is no longer open.

`get_commit_candidates` is the one that reads your repository as well as the
graph, and it exists because neither half can answer alone. Git knows every
commit that touched a file; the graph knows the last moment DevFlow actually
watched the component in that file run. Crossed, they give the commits whose
effect has never been observed — which is a bounded, checkable statement about
what the graph does not know, and the shortlist worth reading first.

It names no cause and says so on every answer. A commit that changed the file is
worth reading first and is not thereby the reason anything broke; the mechanism
compares where commits sit in the history against one observation date, and it
cannot tell a coincidence from a culprit. The ordering is ancestry rather than
dates — git records a commit date only to the second, so two commits made inside
one second cannot be separated by it — and when the sighting is older than the
walk, the answer says it fell back to dates instead.

`get_blast_radius` makes its claim at the size it is true at. A `maps_to` edge
points from a component to the file it was **written in**, so this answers which
components the runtime has observed in a file, not which files import it: an
import is a static fact and nothing in a runtime graph observes one. A component
your application has never exercised while DevFlow was watching does not appear
at all, and the answer says so rather than reading as a complete dependency list.

`get_app_architecture` and `get_living_architecture` answer two different
questions and each says so in its own output. One is the accumulation over every
recording and pick, with frequencies and failure rates; the other is a census of
one page at one moment, which never reaches the graph — a component mounted on a
page nobody interacted with must not count as often "seen" as one somebody
exercised.

They are meant to be used in that order rather than all at once:
`get_flow_summary` costs about a fiftieth of `get_flow`, so finding out whether a
recording is the one you want is nearly free.

`compare_flows_across_deploys` extends `compare_flows` across time instead of
across two separate recordings. Give it a flow — its name as `list_flows`
reports it, or the id of any one recording of it — and, optionally, two
commits, and it returns the same runtime comparison `compare_flows` gives
(where the runs diverge, which endpoints answered differently, which errors
are new) for the two most recent recordings of that flow, plus the commits
that shipped between the two builds and which of the files they changed
DevFlow has actually watched code run in. That last list is a shortlist to
read first, never a cause. It needs recordings made after commit stamping —
see [The commit a flow was recorded at](#the-commit-a-flow-was-recorded-at).

```json
{ "flow": "checkout", "sha": "a1b2c3d", "otherSha": "e4f5a6b" }
```

Omitting `sha` and `otherSha` compares the two most recent recordings of the
named flow.

`get_causal_chain` and `get_effects_of` are one graph walked in opposite
directions. `get_causal_chain` walks backwards from one event in a
recording — a console error, a network call, a state change — to the
interaction it came from; `get_effects_of` walks the same graph forwards from
an event to what followed it: the requests a click made, the state they were
echoed into, the errors that followed. Both name the evidence behind every
link rather than presenting a guess as a fact: `attributed` is temporal
containment and nothing more (a timer poll lands in the same place as a
click's own request), `named` means the log line names the request's own
path, `echoed` means a response value turned up in what a store was written
with, and `followed` is ordering after a failed call and nothing else. Both
take an event ref — `"step:3"`, `"net:3.1"`, `"log:3.2"`,
`"state:3/redux:0/0"` — and list the refs worth asking about when `event` is
omitted; `depth` caps how far each walks (default 8 — honest chains run two
or three links).

```json
{ "id": "flow-1755000000000", "event": "net:3.1", "depth": 4 }
```

`get_state_patch` answers what the app's own state did across one step or a
range of steps, as an RFC 6902 JSON Patch. DevFlow samples state rather than
watching it continuously: each recognised store (Redux, Zustand, React Query,
React context) is read once when an interaction is dispatched and once after
the app settles, so a value that changed and changed back inside that window
shows no change at all, and the reply says which of "state was never
captured", "no store was recognised" and "no store moved" applies — only the
last one is a statement about the application. Pass `step` for one step, or
`from`/`to` for a range (passing both is refused); pass `store` — the id this
tool prints, or the label the page gave it — to see only one store.

```json
{ "id": "flow-1755000000000", "from": 2, "to": 5, "store": "redux:0" }
```

`explain_feature` takes a description in your own words — "the checkout
flow", "cart badge", "invoice totals" — and returns the components,
endpoints, source files, recorded flows and stores whose names overlap it,
each expanded one hop through the accumulated graph so a matched component
also surfaces the endpoint it calls and the file it was written in. The match
is lexical, not semantic: it lower-cases the description, cuts it into words
and looks for those words in names and paths, so a component called `Cart`
matches "cart" whether or not it has anything to do with a shopping cart, and
a feature named `PurchaseFlow` is not found by "checkout" at all. Silence
means your words did not overlap the code's, never that the feature is
absent. `limit` caps how many matches are expanded (default 8; the reply
counts anything beyond it).

```json
{ "description": "the checkout flow", "limit": 8 }
```

`suggest_actions` lists what can be done on a page, according to every
recording DevFlow holds of it: the clicks and the fields, with the selector
the recorder chose and the value that was actually typed, folded across
flows so the action three recordings performed is one row saying three.
Nothing here is invented — DevFlow has no model of your application, so a
control nobody has ever touched does not appear, which is the point rather
than a limitation: for reproducing a bug, the things people actually do on a
page are a better starting set than anything guessed, and each one comes with
a selector that resolved at least once. Filter with `url` (compared on
origin and path, so a query string does not split one page into several),
`component` (an id from `get_app_architecture` or a flow's component table),
or both; `limit` caps how many actions come back (default 20).

```json
{ "url": "https://app.example.com/checkout", "limit": 10 }
```

`replay_flow` runs a recorded journey again, in your project, with your own
Playwright, and says whether it still does what it did when it was recorded.
It is the only tool here that **executes code on this machine**, so it stays
off until the server is started with `DEVFLOW_REPLAY=1`; called while off, it
says exactly that rather than failing quietly. It compiles the flow to the
same spec the extension's own export produces, writes it under
`.devflow/replays/` in your project, and runs your project's own
`node_modules` copy of Playwright — it will not install one. The reply
distinguishes a replay that passed, one that failed, one where no test ran
and one where the runner never produced a readable report, because a crashed
runner reported as a pass is how a repair loop concludes a fix worked when it
did not. When the original recording carried failures, the reply says
whether the replay reproduced them, which is the check to run after making a
change. `timeoutMs` bounds how long the run may take (default 120000 — a
replay still going after that is waiting on something that is not coming).

```sh
DEVFLOW_REPLAY=1 npx devflow-server   # start the server with replay switched on
```

```json
{ "id": "flow-1755000000000", "timeoutMs": 60000 }
```

`diagnose_failure` is what to reach for once a recording has failures and you
want more than the message: for each one it gives the component the step was
attributed to and the file it was written in, the causal evidence leading
back to the interaction — the same evidence `get_causal_chain` names — and,
the part no single recording can supply on its own, whether the thing that
failed has failed before, and how often, from the accumulated graph. An
endpoint that has failed twice in a hundred and forty observations and failed
here points somewhere different from one that fails six times in ten, and the
graph is the only thing that can tell those apart. It names no cause: every
link carries the basis it rests on, "we have never seen this fail" and "we
have not seen it enough to say" are kept as different answers, and whatever
the recording cannot decide is left undecided. Omit `id` for the most recent
recording; `limit` caps how many failures it diagnoses (default 5).

```json
{ "id": "flow-1755000000000", "limit": 3 }
```

Screenshots are written to disk and referenced by absolute path. Claude Code
reads them with its own file tools, one at a time, so a 500-step recording costs
nothing until a specific image is opened.

## Production crashes

With `DEVFLOW_WEBHOOKS=1` the server accepts a Sentry delivery on
`POST /webhooks/sentry` and joins the issue to the source files its stack
reaches. `get_blast_radius` then shows it beside what the runtime has observed in
that file.

**Sentry cannot reach this port.** The server binds to loopback, so their servers
can no more POST to it than to any other machine behind a router. This takes a
delivery you *relay* — `smee.io`, an `ngrok` tunnel, a small forwarder — or
*replay*, by curling an exported event at it. It is not a direct integration and
does not claim to be one.

Almost nothing from the payload is kept: the exception **type** but never its
message, the culprit, the level, the count, the link, and each frame's filename
and line. No user, request, headers, cookies, body, breadcrumbs, contexts, local
variables or source context lines are read at all. A stack that matches no file
the graph has watched code run in draws no edge, which is reported as none rather
than filed against a plausible neighbour.

The counts stay separate: DevFlow's own frequencies are recordings it made, and a
provider's event count is events your users hit. They are never added.

## Replaying flows in CI

`devflow-mcp regression` replays the flows committed to a repository against the
current checkout. It is a command rather than an MCP tool because nobody is
watching: it runs on a machine that has just checked out a branch, and its answer
has to become an exit code.

```sh
DEVFLOW_REPLAY=1 npx devflow-server regression --base origin/main --mode mocked
```

A flow has to be **committed** for CI to reach it — `.devflow/flows/<id>/flow.json`
by default — because a recording otherwise lives only in `~/.devflow/flows` on the
machine that made it. Finding none is reported as inconclusive rather than as a
pass; `--strict` makes that fail the build.

`--mode mocked` (the default) answers each request with the response the recording
captured, so a pass proves the journey completes and the report compares no
statuses or latencies: they would be the recording's own, played back.
`--mode live` mocks nothing and talks to whatever is running, so those are real and
are compared — a change is reported only when it is both 100ms and 30% different,
with the numbers printed. Re-render counts and state changes are not compared at
all, and the report says why: the extension observes those, a replay has no
extension, and the service worker does not register in Playwright's headless
Chromium.

It posts nothing. The report goes to stdout and to `--out`, and publishing it is
the workflow's decision — `.github/actions/devflow-regression` in this repository
is a composite action that runs the check and hands the report back as an output.

## Where flows live

`~/.devflow/flows`, one directory per flow:

```
~/.devflow/flows/flow-1755000000000/
  flow.json          steps, network calls, console output
  flow.md            readable walkthrough
  meta.json          index entry
  screenshots/       step-01.jpg, step-02.jpg, …
```

Set `DEVFLOW_DIR` to put them somewhere else.

## Reading your source

`get_source_snippet` opens files, which nothing else here does. A component's
source path is whatever the recorded page's source map claimed, and any page
your browser visits can post a flow to this server, so that path is never joined
to a directory and opened on trust: it is resolved underneath **one** project
root, re-checked after symlinks are followed, and refused if it lands anywhere
else.

The root is the directory the server was started in — which, under Claude Code,
is the project you are working in. Set `DEVFLOW_PROJECT_ROOT` if it is somewhere
else, or pass `root` on the call. In remote mode the tool is off unless
`DEVFLOW_PROJECT_ROOT` is set, because the machine running the server is not the
machine the caller is working on.

Not inside the npm package: under `npx` that directory is a cache which gets
cleared without warning, and it would take every recording with it.

### How much is kept

The newest 200 flows, up to 2 GB. Past either ceiling the oldest recordings are
deleted as new ones arrive, oldest first, and each one is named on stderr and in
the POST response rather than disappearing quietly.

| Setting | Default | |
| --- | --- | --- |
| `mcp.maxFlows` | `200` | Recordings kept |
| `mcp.maxFlowBytes` | `2147483648` | Bytes kept, screenshots included |

Set either in DevFlow's Settings, in `~/.devflow/config.json`, or as
`DEVFLOW_MAX_FLOWS` / `DEVFLOW_MAX_BYTES` — see [Settings](#settings).

Two ceilings because they fail differently: a handful of enormous flows blows the
disk budget while the count still looks fine, and a great many tiny ones blow the
count while the bytes look fine. Both are runaway guards rather than a retention
policy — losing a recording someone still wanted is the worse failure — so they
sit well above any plausible working set.

A recording is ordered by when it was *made*, not when it was last sent, so
re-sending an old flow does not make it look new. It is never evicted by its own
save: the flow you just sent is always there when you go to read it.

## The commit a flow was recorded at

Every recording is stamped, as it arrives, with the commit the project this
server runs in is at — the directory it was started in, or
`DEVFLOW_PROJECT_ROOT`. `flow.json` and `meta.json` grow a `git` object: `sha`,
`branch`, `dirty`, and the commit's subject line.

**What that names, narrowly.** The state of *this checkout*, at the moment the
recording arrived — not necessarily the build that served the page. The two
coincide when you record `localhost` against the app you are editing, which is
the ordinary case. They do not when you record a deployed environment: you are
on a feature branch, the deployment is last Tuesday's, and the stamp names your
branch. Every tool that prints a commit says which of the two it is looking at.

A dirty working tree is still stamped, with `dirty: true` — "HEAD plus my
edits" is where you actually were. The knowledge graph's `git_sha` join columns
stay empty for it, because a dirty tree names a build that exists on no machine
and a join key has no room beside it for a caveat.

It only ever **reads** the repository — `rev-parse`, `status`, `log`, `show` —
and never writes, checks out or fetches; the one argument it passes that is not
a literal is a commit it has checked is hex. So unlike `replay_flow`, which
runs your project's own code and stays off until you switch it on, this is on
by default. `DEVFLOW_GIT=0` turns it off.

A project root that is not a repository, a repository with no commits yet, and
a machine with no `git` all mean the same thing: no stamp, a line on stderr,
and a recording saved exactly as it would have been. Nothing about git can fail
a send.

In remote mode there is no stamp unless `DEVFLOW_PROJECT_ROOT` is set, for
`get_source_snippet`'s reason: the server's own working directory is a
container and not your project, and a wrong commit is worse than none.

## Backend traces

Turning on DevFlow's trace header puts an id on the requests a recorded page
makes. That id is useful on its own — it is the id in your own backend's logs,
so you can go and search for it. This is the other end: your backend exports the
spans it recorded under that id, DevFlow receives them, and the request the
recording watched leave the browser is joined to the work it caused on the far
side. `get_backend_trace` prints the result as the span tree it is — which
service answered, what it called, how long each step took and which one failed.

`get_value_provenance` uses the same join for a narrower question: given one
value you can see on the screen, it now reaches past the response body to the
work that produced it — the handler that answered, the calls it made, the query
at the bottom, with the file and line each was written on when your
instrumentation records them. **That chain is a known attachment and the value
search over it is not.** Which call a span belongs to is known, because it is
joined by the 128-bit id DevFlow minted and your backend echoed. That the same
text appears in a span is a sighting, exactly as weak as the other four layers,
and the reply keeps the two apart.

**Do not expect the value itself to be in the query.** Real instrumentation
parameterises: what a tracer records is `SELECT total_amount FROM invoices WHERE
id = $1`, so a search for `$120.00` finds nothing there and finds it in the
response body one layer up. That is why the chain is printed whenever the value
turned up at *either* end of the call, rather than only where the text matched.
The query is shown exactly as your tracer recorded it and is never rewritten —
a tidied query your database never saw would be the wrong kind of helpful.

**It is off unless you turn it on.** Start the server with `DEVFLOW_OTEL=1`.
This is the opposite default from the commit stamp, deliberately: that reads a
repository this machine already owns, while this accepts a document from off the
machine and turns it into rows in the accumulated graph. Every other write this
server accepts is checked to have come from the DevFlow extension; this one
cannot be, because the sender is your backend, which has no extension origin.

**Any exporter, in any language.** There is no DevFlow adapter to install and no
supported-language list to be on. What this endpoint reads is OTLP/JSON —
OpenTelemetry's own wire format, not one of DevFlow's — so a Python backend under
`opentelemetry-instrumentation`, a Go service under `otlptracehttp`, or anything
else that speaks OTLP joins on exactly the two variables below. The *frontend* is
what has to be a page DevFlow can record; the backend only has to export spans. A
span is already language-neutral: its service and operation names are what become
nodes in the graph, and the trace id the browser minted is what joins them to the
recording.

Then point your exporter at this server:

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=http://127.0.0.1:7734/v1/traces
OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json
```

`7734` is the default port; use whatever `mcp.port` is set to below.

**The second line is required and is the one thing to get right.** OTLP's
default encoding is protobuf and this endpoint reads JSON only; a protobuf
delivery is refused with a `415` that names this variable. That is a decision
rather than an omission: a protobuf decoder is a second wire format to get
exactly right, and a subtly wrong one does not throw — it writes a plausible
number into your graph.

**Spans normally arrive before the recording does.** Your backend exports within
seconds of the request; you press **Send** when you are ready. So spans are held
and the join runs when a recording arrives. If your spans turn up late, re-send
the recording and they will join.

**Nothing that has only one end is written to the graph.** A span whose trace id
matches no recording is real and DevFlow has nothing to attach it to, so it is
held until it expires and never becomes a node. `get_backend_trace` keeps the
three cases apart, because they have three different fixes: a call that was
never traced (turn the header on), a traced call whose spans have not arrived
(check the exporter, or the sampling), and a joined trace.

The held spans are capped and expire. A trace id is 128 random bits, so nothing
can attach a fabricated span to one of your recordings without guessing one; the
cap is there for the nuisance that *is* reachable, which is filling the store.

## Settings

Most of what this server decides — the response budget, the `raw` default, how
many screenshots a call returns, how much of a body is quoted — is a property of
the *recording*, so it travels inside the flow: the extension's Settings screen
writes it into `flow.json`, and this server renders that flow under it.

Three settings cannot travel that way, because they are true of this machine
whichever flow is being read: the port, and the two retention ceilings. Those
live in `~/.devflow/config.json`, which is the same flat-dotted-key settings
file the extension exports:

```json
{
  "mcp.port": 7734,
  "mcp.maxFlows": 200,
  "mcp.maxFlowBytes": 2147483648
}
```

The extension writes it for you — changing one of the three in Settings posts it
here — and you can edit it by hand. Keys it does not recognise are left alone,
so a file written by a newer DevFlow still works.

**Precedence: environment variable > `config.json` > the flow's own stamp >
default.** The environment is the last word so a CI or headless run is not
steered by whatever a browser once synced into a flow it happens to be reading.

| Variable | Setting |
| --- | --- |
| `DEVFLOW_PORT` | `mcp.port` |
| `DEVFLOW_MAX_FLOWS` | `mcp.maxFlows` |
| `DEVFLOW_MAX_BYTES` | `mcp.maxFlowBytes` |
| `DEVFLOW_MAX_TOKENS` | `mcp.maxTokens` |
| `DEVFLOW_RAW` | `mcp.raw` |
| `DEVFLOW_MAX_IMAGES` | `mcp.maxImages` |
| `DEVFLOW_BODY_LIMIT` | `mcp.bodyLimit` |
| `DEVFLOW_MAX_RESPONSE_BODY` | `mcp.maxResponseBody` |
| `DEVFLOW_MAX_CONSOLE_ENTRIES` | `mcp.maxConsoleEntries` |

Every value is range-checked by the same rules the Settings screen enforces, and
a value that had to be clamped, ignored or outranked is named on stderr rather
than quietly replaced.

**The port is the one that has to be changed on both sides.** This server binds
it and the extension posts to it, so they have to agree — changing it in
Settings moves the address with it. A running server keeps the port it started
on; the new one applies when it next starts, which for a stdio MCP server is the
next session.

## Running more than one Claude session

The extension POSTs recordings to `127.0.0.1:7734`, and at user scope every
session starts its own copy of this server. Only the first can hold the port;
the rest log a line and serve from the same directory. Flows arrive once and
every session sees them.

If no session is open, nothing is listening and the send fails — the recording
is still in the extension's library, so sending it again later works.

## Privacy

Everything stays on your machine **in the default local mode**: the server binds
to loopback and writes to your home directory. The one exception is
`MCP_MODE=remote` below, which binds `0.0.0.0` and puts everything in this
section on whatever host you deployed it to — that mode is opt-in and nothing
uses it unless you started the server that way.

Captured **request and response bodies are not redacted** — only headers are. A
recorded flow can therefore contain whatever your app sent, including tokens in
payloads. URLs are not redacted either, so an OAuth callback recorded mid-flow
keeps its `?code=` intact. That's why auto-send is off by default in the
extension, and why hosting this server somewhere shared is a decision to make
carefully.

Deleting a flow in the extension deletes it here too. Only the extension may
write, delete or change settings: a request carrying a web page's `Origin` is
refused, because a loopback port is reachable from any page you happen to have
open. The settings endpoint writes one file, at one path this server decides,
and stores three keys — nothing in a request names a file or reaches one.

In remote mode it is not there at all: a deployment's port and disk budget
belong to whoever launched it, so they come from the environment.

## Remote mode

```sh
MCP_MODE=remote PORT=8080 MCP_API_KEY="$(openssl rand -hex 32)" npx devflow-server
```

Serves MCP over SSE at `/mcp` and accepts flows at `/flows`, for use as a custom
connector. Unlike local mode it binds `0.0.0.0`, so the boundary is the key
below rather than the loopback interface.

### `MCP_API_KEY`

Set it to a long random string, and send it on every request to this server:

```sh
curl -H "Authorization: Bearer $MCP_API_KEY" https://your-host/mcp
curl -H "X-DevFlow-Key: $MCP_API_KEY"        https://your-host/mcp   # same thing
```

Both headers are accepted, and the check applies to `GET /mcp` (the SSE
session — every tool, every flow), `POST /mcp/message`, `POST /flows`,
`POST /arkg/ingest-component`, `POST /architecture`, `DELETE /flows/:id` and
`POST /v1/traces`. It is *additional* to the extension-`Origin` rule those write
routes already have, not a replacement: a caller with the key but without an
extension `Origin` still gets a 403.

`GET /health` is deliberately open, so an uptime probe or a container health
check does not need the deployment's secret to ask whether the process is up. It
reports `"auth":"api-key"` or `"auth":"none"` — which is how you check, from
outside, that the deployment you just rolled is the authenticated one.

**If `MCP_API_KEY` is unset the check is off**, the server says so on stderr on
every start, and anything that can reach the port can read every flow and post
its own. That is the weaker default, kept for one release so an existing
`MCP_MODE=remote` command does not turn into a silent hard failure; do not run a
public deployment without the key. Local mode ignores the variable entirely —
the extension has no way to know its value, and the boundary there is loopback
plus `Origin`.

Bodies are not redacted (see **Privacy** above), so a remote deployment is
single-tenant by construction: everyone with the key sees everyone's
recordings. Put it behind TLS — the key is a bearer token and travels in a
header.

### Docker

The image is built from this directory, and `core.js` — the bundle of
`src/core/` that `server.js` imports — is a build artifact rather than a file in
git, so build it first from the repository root:

```sh
npm run build:mcp                       # writes mcp-server/core.js
docker build -t devflow-server mcp-server
docker run -p 8080:8080 \
  -e MCP_API_KEY="$(openssl rand -hex 32)" \
  -v devflow-flows:/data \
  devflow-server
curl -s localhost:8080/health           # {"ok":true,...,"mode":"remote","auth":"api-key"}
```

Skipping the first command fails the build at the `COPY` line rather than
producing an image that crashes on start — which is what the image used to do,
since it copied `server.js` alone and `node server.js` threw
`ERR_MODULE_NOT_FOUND` on `./core.js` before binding a port.

Recordings live on the `/data` volume (`DEVFLOW_DIR`), not in the image. The key
is passed at run time on purpose: one baked into an image is not a key.

`fly.toml` deploys the same image (`fly launch --dockerfile mcp-server/Dockerfile`,
then `fly secrets set MCP_API_KEY=…`).

## Licence

MIT
