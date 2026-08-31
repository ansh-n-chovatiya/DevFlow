# devflow-mcp-server

Gives Claude Code the browser flow you just recorded — the clicks, the console
errors, the failed requests and their bodies, and a screenshot of every step —
so it can fix the bug in your project instead of being told about it.

Pairs with the DevFlow Chrome extension, which is what records the flows and
posts them here.

**On the name.** The binary, the server's MCP name (`devflow`) and the
`~/.devflow` directory keep the names they were published under, because a
rename there would leave every recording anyone has kept in a directory nothing
reads — and nothing would say so.

The npm package is the one exception, and not by choice: `devflow-mcp` was
already taken on npm by an unrelated package, so this publishes as
`devflow-mcp-server`. If you registered the 2.7.1 server, its registration still
points at the old package and will never see another release — it does not
break, it just stops moving. `npx -y devflow-mcp-server install --force`
replaces it. The extension is DevFlow; this is the server it talks to.

## Install (Global Setup)

Register once globally on your machine — all your projects and workspaces can use it immediately without any per-project setup:

```sh
npx devflow-mcp-server install
```

Once, globally, for every project you open — the Claude Code CLI and the VS Code extension
alike. Nothing to clone, nothing to build, and safe to run again.

It runs `claude mcp add devflow --scope user -- npx -y devflow-mcp-server` for you.
Setting up at user scope (`--scope user`) ensures DevFlow is available globally across all your repositories. You do not need to run this per project or add `.mcp.json` to individual folders.

| | |
| --- | --- |
| `npx devflow-mcp-server install` | Register globally for every project |
| `npx devflow-mcp-server install --force` | Replace a user-scope registration pointing elsewhere |
| `npx devflow-mcp-server uninstall` | Remove the user-scope registration |
| `npx devflow-mcp-server` | Run the server — what Claude Code does |

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
| `get_app_architecture` | What every recording together says about the app |
| `get_component_history` | Everything observed about one component |
| `get_anomalies` | What has started failing or slowing recently |

They are meant to be used in that order rather than all at once:
`get_flow_summary` costs about a fiftieth of `get_flow`, so finding out whether a
recording is the one you want is nearly free.

Screenshots are written to disk and referenced by absolute path. Claude Code
reads them with its own file tools, one at a time, so a 500-step recording costs
nothing until a specific image is opened.

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

Everything stays on your machine. The server binds to loopback and writes to
your home directory.

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
MCP_MODE=remote PORT=8080 npx devflow-mcp-server
```

Serves MCP over SSE at `/mcp` and accepts flows at `/flows`, for use as a custom
connector. There is no authentication — anything that can reach it can read
every flow — so treat it as single-tenant and put it behind something.

## Licence

MIT
