# Changelog

## Unreleased

**`replay_flow` runs a recorded journey again and says whether it still works —
and it is off until you switch it on.** It is the only tool here that executes
code on the machine it runs on: your own Playwright, your own application,
started because a model asked a question. `DEVFLOW_REPLAY=1` in the server's
environment enables it; without that it still appears in the tool list and
answers by saying exactly what it would do and how to allow it. It runs the same
spec the extension's export writes, from `.devflow/replays/` inside your project,
with your project's own copy of Playwright — it will not install one, because
`npx playwright` on a machine without it downloads it and a tool call is not
where that decision belongs.

**It distinguishes a replay that failed from one that never happened.** A runner
that crashed before loading a spec exits non-zero and prints a stack trace; one
that matched no files prints a valid report of nothing. Counting failures rather
than runs reads both as a pass, and a repair loop asking after a change would
conclude its patch worked. So there are four outcomes, not two, a killed run is
unreadable whatever it had printed, and the runner's own error output travels
with the answer. When the recording itself failed, the reply names the steps it
failed at and whether this run reproduced them — weakly, and saying so: the
replay answers with the recorded responses, so a fault in the server is mocked
out of the run by construction.

**`diagnose_failure` assembles what broke in a recording and refuses to name a
cause.** Per failure: the message, the component the step was attributed to and
the file it was written in, and the causal evidence with the basis each link
rests on. What it adds that no single recording can is whether the thing that
failed *has failed before* — an endpoint that failed twice in a hundred and
forty observations and one that fails six times in ten send you to different
places, and only the accumulated graph knows which. That standing is named, not
scored, and `unknown` is the honest default: below ten observations the graph
knows nothing, and "we have never seen this fail" and "we have not seen it
enough to say" are kept as the different answers they are.

**Patch generation is deliberately not built.** DevFlow is not a model and cannot
write a patch; the caller is, and everything it needs is now in place. A patch
generator inside this server could only be a template, which is precisely what
the reverted version of it was.

**An adversarial review of the three work streams above found five defects and
they are fixed.** The mutation observer described every folded group and then
kept twelve of them, which meant up to four hundred selectors built and three
hundred and eighty-eight thrown away — each one a document query, synchronously
inside the user's next click, which is the cost profile the reverted attempt was
reverted for relocated one function along; the budget is now spent before the
work rather than after it. The refusal of `<style>` and `<script>` applied only
to nodes that came and went, so a stylesheet appended once and then written
through — what Vite's HMR and styled-components do in development — was reported
as a text change ranking above every attribute change. `get_value_provenance`
told the reader a recording had never sampled renders when the sender had merely
unchecked React, which is a claim about the recording manufactured from a
checkbox. It also threw rather than answering on a flow whose fields were not
the types they should be, which any page that can reach the loopback port can
send. And describing a mutation ran unguarded ahead of the step being saved, so
a page that made a node undescribable would have lost the step, its screenshot
and its component chain along with the summary.

Two claims that outran the code have been corrected rather than defended: the
mutation window opens when the step is *written*, which for typing is after the
input debounce and not at the first keystroke, and "closed by the next
interaction" holds for element steps rather than for navigations and notes.

**`suggest_actions` says what can be done on a page, out of what has been done
on it.** Every click and every field somebody has recorded there, folded across
recordings so an action three flows performed is one row saying three, with the
selector the recorder chose, the value that was actually typed, and a mark on a
selector the compiler already considers fragile. Nothing in it is invented, and
the reply says so every time: DevFlow has no model of the application, so a
control nobody has ever touched is not in the list. That is the point rather
than the limitation — a selector DevFlow watched resolve is worth more than one
guessed from a component's name. Steps that did not qualify are counted with a
reason, because "this page has no recorded actions" and "you filtered them all
out" read identically as an empty list, and so does "the tool only opened the
twenty-five most recent recordings", which it also says.

**`explain_feature` turns a description into the parts of the app it points at,
and is honest about how it got there.** Ask it for "the cart badge" or "invoice
totals" and it returns the components, endpoints, source files, recorded flows
and stores whose names carry those words — then expands each one hop through the
accumulated graph, which is the half that reaches the endpoint a component calls
and the file it was written in whether or not those ever carried the word. The
match itself is lexical and the tool says so at the top of every answer rather
than in a footnote: it splits names the way code writes them, so "cart" matches
`CartBadge` as a word and `art` matches it only as a fragment and is ranked as
one, and every match carries the reason it matched instead of a score. It says
which of your words it ignored as too common, and it says that an empty answer
means your words did not overlap the code's — never that the feature is absent.

**`get_value_provenance` answers where one value on the screen came from — and
says what kind of answer it is.** Given a price, an order number or the text of
a step's element, it reports the response body that carried it, the store write
that took it, the component that was handed it and the element that showed it,
in the order data flows through an application. The mechanism is a search across
four independent observations of one recording rather than a data-flow trace,
and the reply opens with that rather than closing with it: a distinctive value
found in three layers is overwhelmingly one value travelling, a short one found
in three layers is a coincidence three times over, and the tool says which it is
holding before it says what it found. Layers the recording never captured are
named as unsearched, because "not in a response" and "this flow has no
responses" look identical as an absent section.

**A recording can say what the interaction did to the page, and not only to the
region around the button.** A MutationObserver watches the whole document for
the length of each step and reports what appeared, what went, and what was
rewritten, anywhere in it — a click on a form's submit button that opens an
error banner in the page header produces nothing in the existing text delta and
one line here. It sits beside that delta rather than replacing it: one reads the
text of one region twice, the other reads the structure of the document once,
and neither is derivable from the other. Off with `recording.domMutations`.

**Its budget is two numbers because there are two costs.** The v3.2.0 attempt at
this pushed every mutation record on the document into an array with no cap and
no throttle. `recording.domMutationCap` bounds the *work* — the observer
disconnects itself when it reaches it, so a page running a sixty-frames-a-second
transition costs a step that many records and no more — and
`recording.domMaxChanges` bounds the *recording*, after repeats are folded, so a
hundred rows appended to one list is one line saying a hundred rather than a
hundred lines. What survives the second is structural change first, then text,
then attributes, and `style` last of all: ordering by how *often* something
changed puts the CSS transition above the dialog that opened, and does it worst
on the steps somebody opened because something happened.

**A step whose observer stopped says so, and never that nothing else changed.**
The window opens when the step is written and closes `recording.domDeltaMs`
later or when the next element step is written, whichever comes first, so a
mutation belongs to exactly one step. For a click those two moments are the
same; for typing the recorder commits a whole field as one step after the input
debounce, so a typed step's window starts once the typing has stopped — the same
schedule the existing text delta has always read its region on. DevFlow's own recording indicator is refused by name — it is removed
and re-added around every screenshot, so without that every step of every flow
would open with a div appearing and going in `<body>` — and so are the `<style>`
and `<script>` tags a CSS-in-JS runtime and a code-split route append. Attribute
values are reported as they settled, not as they passed through.

**`get_step_detail`'s `dom` part now carries both observations, priced as one.**
Each folded change is a line naming what changed and the element it changed in —
or *on*, for an attribute, because the two prepositions mean different things —
with its count when it was folded, the number of changes that did not fit the
budget, and, last so it qualifies everything above it, whether the observer was
cut short.

**A flow compiled to a Playwright or Cypress spec now carries what the app's
stores did, beside the step that did it.** As comments, and the file says why:
DevFlow reads a store by walking React's fiber tree from inside the page, a test
runner has no handle on that, and generating the walk into a spec would tie a
suite to React internals — where the failure mode is a red test reporting a bug
in the application that is not there. The observation is what the compiler can
honestly carry, and it is the answer to *what should I assert here*. Both of the
flags that change what a patch means travel with it: a snapshot cut at its caps
is a bounded view of the store, and folded operations are coarser than the ones
the app made.

**A recording can say which components re-rendered across each step, and it
learns it by looking rather than by joining in.** The page agent takes the two
readings of the fiber tree it already takes for state — one inside the click,
one once the app has settled — and reports every component whose `memoizedProps`
object was replaced between them, with the props, `useState`/`useReducer` values
and contexts that stopped being the same reference. Nothing is installed on the
page: no commit hook, no patched React DevTools global, no subscription, no new
window property. The v3.2.0 attempt at this walked the whole tree on every
commit on every page it was loaded into; this walks a bounded breadth-first
slice twice per step, and only when a recording is running.

**It says when it could not see everything, rather than reporting silence.** The
walk stops at `recording.renderNodeCap` fibers and the recording carries the
fact that it was cut, because "nothing re-rendered" and "nothing was looked at"
are the same sentence otherwise. Changed values are snapshotted under the state
caps, secrets are masked by name, and a component's children are reported as
changed without printing the element tree behind them — which is also what stops
a wasted render being claimed over a change that was real and simply not
printable.

**A component that re-rendered while nothing it was handed changed value is
marked wasted, and the mark is withheld the moment the evidence thins.** That is
the actionable finding — a parent re-rendered and passed down a fresh object
holding the values its child already had — and it is also the easiest thing to
assert falsely: a component reported as re-rendering needlessly when in fact its
own state moved sends a reader to delete a `memo()` that was doing its job. So
the claim rests on having looked at all three of props, own hook state and
contexts, and any observation cut at a snapshot cap is reported *without* it.
When more components re-rendered than one step reports, the wasted ones are kept
first: ordering by how much changed is the obvious rule and it drops every
wasted render before anything else, worst on the busiest steps.

**`get_step_detail` gained a `render` part, and it answers four questions rather
than one.** Renders were never sampled, sampling was switched off, the walk hit
its cap, or nothing re-rendered — only the last is about the application, and an
empty list under a hit cap is a statement about the cap. Nothing it prints
counts renders: two readings of a fiber tree can say *which* components
re-rendered and never how many times, so the summary counts components and says
so out loud.

**`get_anomalies` now says how much it actually looked at.** An empty answer was
two different answers wearing one sentence — *nothing is wrong* and *nothing has
enough history to judge yet* — and the tool could not tell them apart, so it
hedged and said both. It now reports how many components and endpoints cleared
the 30-observation bar and were judged, and how many were seen in the window but
fell short of it. An empty graph says it knows nothing yet rather than implying
health; a graph with real history says how much of it was examined. The
failure-rate row still says in words that it is a fixed threshold and not a
baseline, because the graph keeps one rolling rate per entity and no
distribution of rates to take a σ of.

**One recording counts once towards a `caused_by` edge, however many of its
links land on it.** The projection from events to graph nodes is many-to-one by
design — every delta of one store lands on that store's single node — so a
response echoed into two keys of one store was two links describing one fact,
and it was being counted as two observations. `frequency` is how many recordings
showed the thing; a number a reader could not arrive at from the recordings on
disk is worse than no number.

**DevFlow can say what led to a failure, and what each link in that chain is
actually worth.** `get_causal_chain` walks backwards from a console error, a
request or a state change to the interaction it came from; `get_effects_of`
walks the same graph the other way. The roadmap's acceptance case — a click that
triggers a fetch that logs an error — is one chain, readable from either end.

**Every link states its evidence, because a guessed edge presented as a known
one is worse than no edge.** There are four bases and they are named, not
scored: `echoed` means a value the response carried turned up in what the store
was written with; `named` means the log line contains the request's own path;
`attributed` means only that the recorder filed both under the same step —
containment, and a background poll on a timer lands in exactly the same place;
`followed` means only that something came after a call that failed. A number
like `0.8` implies a precision this evidence does not have and cannot be argued
with. "The log line contains the request URL" can.

**The graph is derived from the recording each time it is asked for, and never
stored.** Every fact it uses is already in the flow, so a stored copy would be a
second thing to keep in sync — and it would not exist on the recordings already
on people's disks. Derived, every flow ever made gets the analysis, and a rule
improved in a later release reaches all of them rather than only the ones
recorded afterwards.

**Event refs count from one.** `net:3.1` is the first request of step 3, not the
second. Every other number either a person or a model sees in this project
counts from one — the step numbers, the range a tool takes, the line a component
was written on — and `net:3.0` beside "step 3" is the same one-character
misreading the `Pos0`/`Pos1` types exist to make impossible. A ref is a string
and has no type to catch it, so it has a test instead.

**The knowledge graph gained `caused_by` edges and a real anomaly baseline** —
both written, both green, and both recorded in the roadmap as *unverified*.
They landed without their author's account of the two judgement calls that
decide whether they are honest: which causal links have a node identity stable
across recordings, and what part of the >2σ specification a rolling failure-rate
scalar genuinely cannot support. Working code is not the same as audited code,
and the roadmap says which this is.

**A component's edges are finally printed.** The graph has always returned them
and no tool ever showed one, so the endpoints a component calls and the stores
it was observed reading were reachable only by opening the database by hand —
which, from outside, is the same thing as never having written them.

**DevFlow records what the app's own state did, by reading it rather than by
becoming part of it.** Every step now carries the difference between what the
page's stores held when the interaction was dispatched and what they held once
it had settled, as an RFC 6902 JSON Patch, and `get_state_patch` hands that to
Claude Code. Redux, TanStack Query, Zustand behind a provider, and the app's own
React contexts are the four it recognises.

**Nothing is patched, wrapped or defined on the page to do it.** The stores are
*sampled* off the fibers React already keeps — twice per step, and never at all
while nothing is recording. The previous attempt at this feature assigned
`window.__REDUX_DEVTOOLS_EXTENSION__` a non-callable object when the real
extension was absent, so the classic
`__REDUX_DEVTOOLS_EXTENSION__ && __REDUX_DEVTOOLS_EXTENSION__()` enhancer threw
at boot on every page with Redux on it, recording or not. Sampling has no such
failure mode to get wrong: there is no global to restore and no restore path to
miss, which the tests assert directly rather than by inspection.

The cost of sampling is stated where it is read rather than left to be
discovered: a store that changed and changed back between the two samples shows
no change at all, and nothing here says anything about the order things moved in
within one step.

**A patch that would not fit its budget is re-cut, never trimmed.** Cutting
operations out of an RFC 6902 patch produces something that still looks like a
patch and no longer reconstructs the state the app ended the step in — a reader
who applies it gets a state that never existed, with nothing saying so. Over
budget, the patch is re-emitted at a shallower path instead: fewer, coarser
`replace`s that still apply exactly, with the step recording how much detail
that cost.

**Where DevFlow could not see, it says so.** "State capture was off", "capture
ran and recognised no store on that page", and "no store moved on this step" are
three different answers and the tool gives three different ones, because absence
of data and absence of change look identical otherwise and a reader with no way
to tell picks the worst of them. A store held in a module rather than a provider
— a Zustand store created with `create()` outside any context — is not read, and
the recording says that in as many words instead of leaving the gap.

**A store's keys and its readers are now in the knowledge graph.** `state_keys`
nodes count how often each top-level key of each store actually changed, not
merely that it was seen; `subscribes_to` edges join a component to a store it
was *observed* reading — its own fiber carried the context dependency. Being
rendered underneath a provider is not reading it, is true of nearly every
component in an app, and is never counted.

**Secrets in a store are masked where the snapshot is taken**, before the value
is walked, so a masked object never costs the depth budget and its getters are
never called. The mask is stable, so a rotated token diffs as unchanged rather
than as a change whose value is a credential.

Eight settings under `recording.` govern all of it — whether to sample at all,
how long to let the app settle, and the five caps that bound a snapshot and its
patch. Each says what moving it costs.

**Three tools that let Claude look at a recording without reading all of it.**
`get_flow_summary` answers the question you actually have first — is this the
flow, and did it break — in under 400 tokens, which is about a fiftieth of
`get_flow`, so asking it of the wrong recording costs nothing. `get_step_detail`
returns one *part* of one step: its component, its network calls, its console
output, its element, the text that changed around it, or its screenshot. Asked
with no part named it lists what the step has and what each part would cost, so
the next call is the cheap one. And `get_source_snippet` reads the lines the
component was actually written on, off this machine, so a path from
`get_flow_errors` becomes code without a round trip.

**`get_source_snippet` reads source only from underneath one project root.** It
is the first thing in the server that opens a file, and the path it opens came
off a recorded page's own source map — a string that arrives over an
unauthenticated loopback port any page you visit can reach. So the path is
resolved under a single root, checked again after symlinks are followed, and
refused if it lands anywhere else. The root is the directory the server was
started in, which under Claude Code is the project you are in;
`DEVFLOW_PROJECT_ROOT` or a `root` argument move it. In remote mode the tool is
off unless that variable is set, because the machine running the server is not
the machine the caller is working on.

**A recording whose file is not in the checkout says so.** A source map records
the line as it was in the tree the bundle was built from, so a stale build names
line 900 of a file that has 40 lines. Clamping that quietly would print the end
of the file as though it were the component. It prints the end of the file and
says the line was past it, which is what a stale build looks like from here.

**The send dialog says where the flow is going, and checks before you commit.**
It shows the address it will post to, and probes it as it opens rather than
after uploading the whole recording. When that fails it says what actually
failed: nothing listening on the port, something else answering on it, an
address that is not this machine, or a server that did not answer in time —
each with the remedy that fits, instead of one guess that "the server is not
running, open Claude Code". An address that is not loopback is offered no local
remedy at all, because none of them applies.

**A warning about credentials in step URLs that is not gated on a switch.**
Credential-bearing query and fragment parameters are masked as a step is
captured, but the mask is a list and a list is never complete — `state` and
`nonce` are deliberately left alone as CSRF machinery, and a flow recorded
before that masking existed still holds what it held. The dialog warned about
this only when network data was being included, which is unrelated: step URLs
travel whatever the Include switches say. So turning *everything* off used to
make the warning disappear and replace it with "Claude will get the steps and
their URLs, and nothing else." The warning is now ungated and counts what it
found, and that reassurance only appears when the URLs are genuinely clean.

**A component DevFlow could not locate now says what to do about it.** The card
explained the failure and stopped: *most likely a lazy chunk that was never
fetched* did not go on to say "load that route and pick it again", and *source
lookup is turned off* offered no way to turn it back on. Each failure now
carries the next action beneath the explanation, and where the panel can act on
it itself — switching source lookup back on and re-locating what is already on
screen — there is a button rather than an instruction.

**The panel says what to set before you need it.** `Open in Editor` cannot work
without a project root, and nothing ever mentioned that until you pressed the
button and it did nothing. While no project root is set, the idle panel carries
a line pointing at the setting, and opens the drawer that holds it. It removes
itself once set, and can be dismissed.

**`Pick Element` is `Pick component`**, which is what `docs/CONTRACTS.md` §4.4
freezes it as — a component is React's and an element is the DOM's, and the
panel's own button had been saying the wrong one of the two. `npm run
lint:vocab` now checks the frozen labels, so this drifts back only deliberately.

**One component is one node in the knowledge graph.** A component seen in a
recorded flow and the same component picked in the panel were filed under two
different id schemes, so they became two nodes sharing a name, each holding half
the evidence — and because the flow-side id is a hash of the compiled function,
editing a component started a third. Identity is now the component's name and
the file it was written in, which is the one pair both halves can always
produce; older ids are kept as aliases, so every id already written into an edge
or an answer still resolves, and databases that already hold a split merge on
open. The graph now also answers for a component you have only ever picked,
which it previously could not report at all until a flow had been sent, and
`get_component_history` takes a name rather than requiring a 16-character hash.

**The toolbar says whether you are recording.** The badge showed the step count
while recording and then kept showing it after you stopped, so a finished
recording and a live one looked identical, and pausing changed nothing at all.
Recording is red, paused is amber, and a stopped recording waiting to be saved
is grey — and the tooltip names the site being recorded and says, when that is
the case, that the steps are not in the library yet. Pause, discard and archive
all repaint it now, which they did not before.

**Recording has a keyboard shortcut.** `Alt+Shift+R` starts and stops it, and
Chrome lets you rebind it. It will not start over the top of a recording you
have not saved — it opens the popup and asks, the same as the button does.
In Flow review, `Ctrl+Enter` sends the flow, `Ctrl+S` saves it to the library
and `?` shows the list, which now includes all three.

**`Save to library` is in the popup.** It used to be five interactions away
behind a `…` menu in another tab, while Export and Send sat as primary buttons —
so the one action that stops a recording being thrown away was the hardest to
reach. The popup card now says `Unsaved flow` rather than `Current flow`, and
saves in one press, naming the flow after where it was recorded. Rename it in
the library if that is not what you wanted.

**Auto-send now obeys the four switches that say what may leave the browser.**
`Include screenshots`, `network`, `console` and `components` were read by the
Send dialog and by nothing else, so turning `Send flows to Claude Code
automatically` on quietly overrode all four: every recording went over with its
un-redacted request and response bodies, its console output, its screenshots and
its source paths, whatever the settings said. It builds the same payload the
dialog does now, and says in `omitted` what it withheld. If you have had
auto-send on, flows already in `~/.devflow/flows` were sent under the old
behaviour and still hold whatever your app sent.

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
