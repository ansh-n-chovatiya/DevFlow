# Changelog

## Unreleased

**What a component is when it is not a fiber.** `src/core/locate/adapter.ts` is
the shape React, Vue, Svelte and React Server Components all agree on, written
after the three runtimes were measured rather than before. A component resolves
to one of three things, not to a function: `declared` (the runtime already knows
the file and line and simply hands it over), `searchable` (a compiled source
string for the existing needle path), or `absent` with a reason.

**`declared` exists because every one of these runtimes already knows the
answer in a development build.** Svelte writes `__svelte_meta` with the file,
line and column onto the element — strictly more than React's own
`_debugSource`. Vue puts `type.__file` on the component. Next.js dev puts
`_debugInfo` on the fiber. A contract insisting on a function would search the
bundle for an answer the page was holding out. `ComponentSource.via` was already
this union in disguise.

**`absent` carries a reason because in production these runtimes stop
cooperating, and one stops entirely.** A Svelte production element has zero own
properties; an RSC production server component leaves no name, no module id and
no file anywhere. Reporting silence there would read as "this element has no
component", which is false; the reason reads as "this build removed the
evidence", which is true and is something the reader can act on. The three
reasons are deliberately not duplicates of `ComponentStatus` — `no-map` and
`not-found` are outcomes of a search that ran, and these are the cases where
there is nothing to search for.

**The source-map engine is framework-neutral, and now lives somewhere that says
so.** Nine modules moved from `src/core/react/` to `src/core/locate/`: needle
building, bundle search, source-map decode, editor URLs, `Pos0`/`Pos1`, component
ids and chain buffering. Nothing about them was React-specific — ten of the
fifteen modules in that directory carried no React reference at all, and
`core/otel`, `core/architecture`, `core/provenance` and `core/source` were
already importing `core/react/positions.js` despite having nothing to do with
React. What stays in `core/react/` is the fiber walk, the owner rule, the
attribution built on them, classification and the build stamp.

**It was measured before it was moved.** Three throwaway applications — Vue 3 and
Nuxt, Svelte 5 and SvelteKit, Next.js App Router — were built, run in development
*and* production, and grepped for needles built with DevFlow's own constants.
Every one hit byte-for-byte: Vue 14/14, Svelte 3/3 decoding through the real
source map to `Counter.svelte:5` exactly, and Next.js client components through
served maps. `Function.prototype.toString()` round-trips through all three
runtimes exactly as it does through React. The findings are in `.ctx/`, and the
argument is ADR 0026.

**`npm run lint:locate` is the gate that keeps it true.** One `../react/` import
inside `core/locate/` would make the directory's whole claim false while
everything still compiled and every test still passed, because React is in the
extension regardless. That is the kind of failure this repository has learned to
gate rather than trust: it is how a second copy of an engine gets written.

**Production crashes, joined to the files you are about to change.** With
`DEVFLOW_WEBHOOKS=1` the MCP server accepts a relayed Sentry delivery, joins the
issue to the source files its stack actually reaches, and shows it in
`get_blast_radius` — so "what does the runtime know about this file" and "what
are users hitting in it" are one answer at the moment you need both.

**Sentry cannot reach a loopback port, and this does not pretend otherwise.**
Their servers can no more POST to `localhost` than to any machine behind a
router. What the endpoint takes is a delivery you relayed (smee.io, an ngrok
tunnel) or replayed (an exported event, curled in), and the docs say that in
those words rather than describing a direct integration.

**Almost nothing from a crash payload is kept.** The exception type but never its
message — that is where an order number or a token ends up. The culprit, the
level, the count, the link, and a stack frame's filename and line and nothing
else. No user, no request, no headers, no cookies, no body, no breadcrumbs, no
contexts, no local variables, no source context lines. The payload is never
handed on as it arrived: every field is read out by name.

**A production count is never added to an observation count.** DevFlow's own
`frequency` counts recordings it made; a provider's `event_count` counts events
your users hit. They are different units, they live in different tables, and
every surface that prints both says which is which.

**A crash joins to a file or to nothing.** The stack is matched by the same rule
the commit join uses — exactly after normalisation, or by a suffix exactly one
known file answers, never by a guess. A minified production stack often matches
nothing, and that is reported as nothing rather than filed against a plausible
neighbour.

**Replay your recorded flows in CI.** `devflow-mcp regression` takes the flows
committed to a repository, replays each against the current checkout, and reports
what changed — with a composite GitHub Action (`.github/actions/devflow-regression`)
and a copyable workflow beside it.

**Two modes, and the mode decides what the report can claim.** In the default
`mocked` mode each request is answered with the response the recording captured:
a pass proves the journey through the interface completes, and the report
compares no statuses or latencies at all, because they would be the recording's
own played back. In `live` mode nothing is mocked, the run talks to whatever the
branch built, and the statuses and latencies are real and compared. The mode is on
the first line of every report, because every other line means something
different under each.

**A latency change has to clear two bars before it is printed** — 100ms and 30% —
and the numbers it cleared them with are printed with it. A 40ms endpoint that
becomes 60ms is half again as slow and nobody cares.

**Re-render counts and state changes are not compared, and the report says why.**
Those are observed by the DevFlow extension reading React's fibers, and a replay
drives the page with no extension. Loading it was tried rather than assumed: the
service worker registers in a headed Chromium and does not register in
Playwright's headless one, so an observed run needs a display. That is a
different piece of work and is named as one.

**A check that could not decide does not pass.** A flow that was unreadable or
matched no tests makes the whole run inconclusive — which outranks regressed,
because a run it could not read is a run whose failures it cannot trust either.
Finding no flows at all is inconclusive too, never a green tick meaning nothing
happened, and `--strict` makes that fail the build.

**It posts nothing anywhere.** The report goes to stdout and to a file, and the
workflow decides whether to publish it — the credentials that can comment on a
pull request belong to whoever owns the repository. And because it runs your test
runner against your application, it is behind the same `DEVFLOW_REPLAY=1` switch
`replay_flow` is.

**Accessibility, audited against what the browser actually computed.** Turn on
**Audit accessibility while recording** and each interaction is followed by a
bounded read of the page as it settled: contrast measured against the colour
really behind the text, interactive roles with no accessible name, controls the
keyboard cannot reach, focusable things inside `aria-hidden`, positive
`tabindex`, ARIA states a role does not take, and a native `disabled`
contradicted by `aria-disabled="false"`. Every violation carries the numbered
WCAG criterion it fails and the **component and file** it was found in — which is
what a static linter cannot give you, because it is the same fiber walk the rest
of a recording uses.

**Two checks exist only in the difference between two moments.** A modal that
opened and left focus outside it, and one that closed leaving focus nowhere.
Neither is a property of any file, which is why no linter finds them.

**Where it refuses to answer, it says so.** Contrast is measured against the
nearest opaque ancestor background, and an element with none — behind a
gradient, an image or a translucent stack — is skipped rather than compared
against an assumed white. On a real page a third of the elements walked are in
that state, so the step's note counts them: a missing finding is never a passing
one. The accessible name is computed by the common paths rather than the full
accname algorithm, and every finding that reads one says so. And whether focus is
*trapped* in a dialog is not tested at all — that needs pressing Tab, and DevFlow
does not take part in the app it records.

**No fix is generated, and every answer says that too.** The criterion, the
measurement and the component are the deliverable; writing the change is yours.

**It is off by default**, the only recording capture that is, and the default came
from a measurement: the settled walk costs 4.9ms on a 2000-element page. The
reading taken inside your click is a thousand times cheaper than that — it looks
at what has focus and nothing else. A flow recorded with the audit off says so
rather than reading as a page with nothing wrong.

**Which commits changed this, and which of them has never been watched running.**
`get_commit_candidates` takes a component or a source file and answers with the
commits that changed the code it was written in — author, subject, date and SHA
— sorted so that the ones which landed *after the last moment DevFlow saw that
component run* come first. That crossing is the point: git knows your history and
the graph knows what it has actually watched execute, and neither knows the
other's half. A component last observed three commits ago, with two of those
commits touching its file, is a component the graph's knowledge is stale about,
and those two changes are the ones to read first.

**It names no cause, and says so on every answer.** A commit that changed the
file is a commit worth reading first and is not thereby the reason anything
broke. The mechanism compares where commits sit in the history against one
observation date; it cannot tell a coincidence from a culprit, and the closing
paragraph saying that is printed unconditionally rather than only when the tool
is unsure. The roadmap's "determine the exact commit **and PR**" is narrowed in
the roadmap too: nothing DevFlow observes carries a pull-request number, and a
tool that printed one would be printing something it invented.

**The answer states its own coverage.** How many commits were walked, whether the
walk stopped at its limit, how many touched the file, how many of those the graph
itself holds — and, when the component has never been observed on a clean working
tree, that there is no sighting to measure against at all rather than an ordering
built on nothing.

**`get_blast_radius`: a query that had been built, tested and reachable from
nothing.** Given a source file, it answers with the components the runtime has
observed in it, how often each was exercised, how often each failed, and what
each was seen calling and reading. It makes its claim at the size it is true at:
these are components observed to have been *written in* that file, not files that
import it — an import is a static fact and nothing in a runtime graph observes
one — and a component your app has never exercised while DevFlow was watching
does not appear at all.

**"Show me everything that renders when I click checkout" — the cascade.** Every
step in Flow review now has a **What this caused** button. It opens a graph of
the interaction and what followed it: the stores that moved, the components that
re-rendered, the requests that went out and the console lines that came back,
laid out left to right in causal order and revealed one column at a time so the
order is something you watch rather than something you reconstruct.

**Every arrow says what it is made of, and the weak ones look weak.** A component
hanging off a state change means one of two things and the picture distinguishes
them: DevFlow *observed* that component reading that store — the dependency was
on its own fiber — or a context it depended on merely shares the store's name.
A component with neither hangs off the **interaction**, not off whatever store
happened to move in the same step. That last rule is the whole point. A component
that re-rendered and a store that changed in the same moment are two things that
happened, and a graph that joined them with a line would be inventing the finding
you came for. Hover any arrow to read the evidence in words.

**Strength is drawn in weight, not in colour.** Observed is thick and solid, a
name match is thin, "these merely happened together" is dashed. Spending green
and amber — which mean success and failure everywhere else in DevFlow — on a
confidence scale would have made the strength of a claim something a
colour-blind reader could not see.

**The reveal is ordered, not timed.** Columns appear in causal order because the
order is the finding; the intervals are fixed and say nothing about how long
anything took. A cascade animated at recorded speed would be a stopwatch. It is
skipped under reduced-motion, and **Replay** puts it under your control.

**It says what it cannot claim, under the picture rather than in the footnotes.**
Re-renders are sampled twice per interaction and not counted, so forty renders
and one look the same here. An absent arrow is not an absent cause. A capped
store snapshot means a change below the cut reads as no change. A graph is the
presentation that most invites a reader to believe it is complete, which is why
those sentences sit in the body at body size.

**Steps where nothing observable happened do not offer the button** rather than
offering a disabled one — a click on a link that navigated is an ordinary step,
and thirty greyed buttons read as something broken.

**The Living Architecture Map: Claude can now see what is mounted on the page in
front of you.** Press **Read architecture** in the DevFlow panel and the
extension takes one reading of the running app's component tree — every component
currently mounted, how many instances of each, where it was written when the page
knows, and which React contexts each one reads. `get_living_architecture` hands
that to Claude. It answers what the screen *is*, where `get_app_architecture`
answers what has been *observed over time*; the tool says so in its own output so
the two are never mistaken for one another.

**It is a reading with an age on it, and the roadmap's word for it does not
survive contact.** Phase 3 asked for a graph that "updates in real-time as the
developer navigates". A model calling a tool asks once and reads one answer, so
"real-time" can only mean *fresh at the moment it was read* — and the honest unit
of that is a reading that says how old it is, never a feed. Every line of the
answer is built around not losing that: the age and the URL come first, before
anything a reader would act on, and past ten minutes the wording changes from
"this is mounted" to "this was the last reading, take another". The alternative —
a socket held open from the server back to your browser, with the service worker
kept awake to hold it — was costed and refused. It buys nothing a model can use,
and charges every page for it.

**It carries structure and never values.** No prop, no hook state, no store
contents: component names, their source paths, and which contexts they read. This
is not a budget that ran out — there is nowhere in the wire shape for a value to
sit. A recording is values, and you pressed Start and chose in the send dialog
what left the browser; a reading is taken while you are reading code, through a
path with no dialog in front of it. The two should not carry the same things.

**Nothing is stored between server restarts, and that is the design.** A saved
map's only possible use is to describe a page that is no longer open. Readings
live in memory, the most recent eight pages, and the map adds no retention
setting, no sweep and no file. It does not write to the knowledge graph either: a
component mounted on a page nobody interacted with would otherwise count as often
"seen" as one somebody exercised, and `get_anomalies` reads those counts.

**A page with no React, a reading nobody took, and a page you have not read are
three different sentences.** Each names the next move, because a reader who
cannot tell them apart assumes the worst of them — the same rule the anomaly
report and the recorder's state note were built to.

**`get_value_provenance` now reaches past the response body to the work that
produced it.** Ask where a value on the screen came from and the answer can now
carry a fifth layer: the handler that answered the request, the calls it made,
and the query at the bottom — joined to the recording by the trace id DevFlow
put on the request and your backend echoed. It is one tool, not a new one. A
`get_full_lineage` beside the two tools that already answer halves of this
question would have been a third renderer of one thing, which is a mistake this
project has made once already.

**The chain is a known attachment; the search over it is a sighting, and the
reply holds both apart.** Which call a span belongs to is *known* — 128 random
bits DevFlow minted, echoed back — and that is a stronger link than anything
else in the tool. But a span carries no response body, so a value found in a
query's text and the same value found in a response body are still two sightings
and not a proof that one became the other. The reply says which of the two it is
showing you, every time.

**Where a value you can see actually appears in a trace was measured, and the
design was wrong before it.** A live capture — express, knex and better-sqlite3
under the official auto-instrumentations, continuing a real `traceparent` — says
a response body appears **nowhere** in a trace, and the value appears in exactly
three places. DevFlow was reading one of them. It now reads the query string as
well (`?amount=1284.00` travels in plain sight, and only the path was being
read), and the stack trace of a failed span. That last one is the surprise: on
the *same* span, the query attribute said `where id = ?` while the stack trace
said `where id = '8814'`, because the driver interpolates when it formats its own
error. The failure path is the richest evidence a trace carries, which is exactly
backwards from the intuition — and it is the path somebody asking why a value is
wrong is already on.

**Do not expect the value itself to be in the query, and the tool no longer
pretends you should.** Real instrumentation parameterises: knex, pg and mysql2
record `= ?` and `= $1`. The same instrumentation records `where id = 8814` the
moment the application builds its SQL by concatenation instead. Neither "the
value is in the query" nor "it never is" is true, so the chain is shown whenever
the value turned up at *either* end of the call rather than only where the text
matched. The query is printed exactly as your tracer recorded it and is never
rewritten.

**"Controller Handler: `invoice_controller.py:45`" is a real answer for a
hand-instrumented service and almost nobody else, which is now said rather than
implied.** Of the 41 official Node instrumentations, exactly one records where
code is written, and it is a Cucumber runner recording a `.feature` path. The
file and line are printed when your instrumentation supplies them; their absence
is reported as a fact about the instrumentation rather than as DevFlow failing to
find something.

**One definition of "which calls in a recording carried a trace id" replaced
two.** The server kept its own copy that numbered steps by position, while every
renderer beside it prefers the step's own number — so `get_backend_trace`
filtered on one number and printed the other. DevFlow's own sender renumbers on
the way out, which is why nobody had seen it; the endpoint accepts a flow from any
local process that reaches the port without an `Origin` header, which is why that
was not a reason to keep two.

**DevFlow can now tag the requests a recorded page makes with a trace id, and
this is the first thing it has ever done that is not observation.** Everything
before it watches. With `network.traceHeader` on, an outbound request carries
`X-DevFlow-Trace-Id` holding the same id the recording shows — so the request in
front of you can be found in your own backend's logs by searching for that id.
`network.traceparent` sends W3C Trace Context instead, or as well, so a backend
running OpenTelemetry files the request under that id without being taught
anything.

**Both are off by default, and only ever active while a flow is recording.** The
patches on `fetch` and `XMLHttpRequest` have always been installed on every page
at `document_start`; what is new is scoped to the window you opened deliberately,
so ordinary browsing is never modified. That turns "DevFlow is installed" into
"DevFlow is recording", which is a state you chose seconds ago.

**Cross-origin requests are left alone unless you name the origin, and that is
the whole design rather than a caution.** A request that gains a
non-CORS-safelisted header stops being a *simple* request, so the browser sends
an `OPTIONS` preflight it did not send before — and a backend that does not name
the header in `Access-Control-Allow-Headers` **fails the request outright**. That
is a working application broken by DevFlow being installed, and there is no
falling back from it: by the time the browser reports the failure, the page's own
`fetch` has already rejected. Same-origin requests are exempt from CORS entirely
and cannot fail this way, so they are traced freely; everything else waits for
`network.traceOrigins`, because naming an origin is you saying that backend
accepts the header, and there is no way to discover that except by sending the
request that might fail.

**That hazard is now measured against a real browser rather than reasoned from
the specification.** Chromium was pointed at two local origins whose API allowed
the origin and the method on both paths and differed only in whether the
`OPTIONS` response named the header in `Access-Control-Allow-Headers`. With no
custom header, the request went straight out and resolved with no preflight at
all. Against the path that named the header, the browser preflighted and then
sent the real request, which arrived carrying it. Against the path that did not,
the page's `fetch` rejected with `TypeError: Failed to fetch` and the real
request was never sent. `traceparent` failed identically: being a W3C standard
buys no exemption from the mechanism, only a better chance that a backend already
allows it. Two things follow. A failure like that leaves **no server-side
evidence** — the API logged the preflight and never the request — so an
application broken this way shows a failed fetch in the browser and nothing at
all in the backend's logs. And **DevFlow cannot see the preflight either**:
Chromium makes it in the network service, where a patch on `fetch` in the page
never sees it, so the rejection is all a diagnostic could ever work from.

**Three more refusals, each for its own reason.** A request the page has already
put a `traceparent` on is left exactly as it was — overwriting one would reparent
somebody's production spans under an id their backend has never seen. A `Request`
carrying a body is left alone, because adding a header means rebuilding it and
`new Request(req, { headers })` marks the original as `bodyUsed` — measured, not
assumed. And a new id is minted per request, never per flow: a W3C trace names
one distributed operation, so a shared id would tell somebody's tracing system
that forty unrelated operations were one.

**`traceparent` asks a backend to record a trace it would otherwise have sampled
away.** The flags byte is `01`, because an unsampled trace header has no purpose
— but that is a real cost on somebody's observability bill, and it is a second
reason the switch is off by default that has nothing to do with CORS.

**A reused `XMLHttpRequest` no longer reports the previous request's headers.**
`open()` never cleared them, so the second request through one instance — which
is how every long-poll and retry loop is written — was recorded carrying the
first one's. Found because a stale `traceparent` in that list made the second
request refuse itself as already traced.

**A recording now carries the commit it was made at, and the knowledge graph's
`git_sha` columns are no longer always NULL.** They were declared on five tables
and written by nothing — `arkg.js` used them as the example of the defect its
own header complained about. The commit is read by the MCP server from the
project it runs in, at the moment a recording arrives, because that is the only
place the answer exists: the extension has no filesystem and no repository, and
asking the page means asking a browser about a checkout it cannot see.

**What the stamp claims is narrower than "the build that was running", and every
surface that prints one says which.** It is the state of the checkout *the
server* runs in when the recording arrived. That is the same thing as the build
that served the page when you record `localhost`, and an unrelated thing when you
record a deployed environment — so a recording made against a page this machine
did not serve is labelled as such wherever a commit is shown, rather than left
for the reader to remember.

**A dirty working tree records the SHA and stays out of the graph's join keys.**
"HEAD plus my edits" is how people describe where they are, so the recording
keeps it, with `dirty: true` beside it. A `git_sha` column is a join key with no
room to carry that caveat, and a dirty tree names a build that exists on no
machine, so nothing writes one. The column therefore means *the last commit at
which this was observed with a clean tree* — one rule, in one expression, because
the way a rule about a column dies is a sixth write site added by somebody who
had not read the fifth.

**Four surfaces print it, which was counted rather than assumed.** `list_flows`
(whole metas, so it came free), the `get_flow` walkthrough header, the `flow.md`
in a recording's own directory, and `compare_flows_across_deploys`. The caveats
travel with the commit in every one of them, because a stamp read as "the build
that was running" is worse than no stamp. `get_flow_summary` deliberately does
not print it: its whole budget answers *did this break*, and a commit does not
help with that.

**`git_commits` nodes and `changed_in` edges.** A commit somebody recorded at
becomes a node, and the files it changed become edges — but only onto source
files the graph has already seen code running in, matched exactly or by an
unambiguous suffix and never by a guess. So a deploy touching forty files may
draw three edges, and three is the honest number: the other thirty-seven are
files no recording has run through. A `changed_in` edge has no frequency to
accumulate, because a commit changed a file once and re-recording at it is not a
second time it happened. A merge commit gets a node and no edges, which is what
`git show --name-only` says about a merge and is true.

**`compare_flows_across_deploys` — two recordings of one flow, made at two
commits.** It is a *join* rather than a second comparison: `compare_flows`
already answers what differs between two runs, and building a second one beside
a working one is the mistake this repository made once with its two markdown
renderers. What the tool adds is the commits between the two builds, and then
the part only an accumulated runtime graph can supply — which of the files those
commits changed DevFlow has actually watched code run in. A deploy touching forty
files may produce three, because the other thirty-seven are files no recording
has ever run through, and that gap is the whole point.

**That last list says "a shortlist, not a cause" in those words.** The roadmap
asked for a causal hypothesis constructed automatically. The mechanism is an
intersection of two sets and it cannot tell a coincidence from a culprit, so it
does not get to imply that it can — the same line `diagnose_failure` holds. It also
takes a flow **name** rather than the roadmap's flow id, because a flow id names
one recording made at one commit and no id has two builds to be asked for; with
no commits named it compares the two most recent builds. The pair is ordered by
commit date and not recording date, since reproducing a regression means
checking the old build out and recording it second.

**Reading the repository is on by default, and it is not `replay_flow`.** That
tool is off behind `DEVFLOW_REPLAY=1` because it executes your code; this reads
`rev-parse`, `status`, `log` and `show` in a directory the server already opens
source files out of, with a fixed argument list whose only non-literal is a
commit checked against seven-to-forty lowercase hex before it reaches a process.
Copying the gate reflexively would have made the feature unreachable and left the
columns NULL by a different road. `DEVFLOW_GIT=0` turns it off. A directory that
is not a repository, a repository with no commits, a detached HEAD and a machine
with no `git` are four different answers, and nothing about any of them can fail
a recording.

**`@devflow/compiler-plugin` writes each React component's own file and line
onto the component function at build time, and DevFlow reads it back.** It is a
Babel plugin, it is optional, and nothing needs it: DevFlow finds a component's
source by searching the page's own bundles, and that is still the path it is
built and tested around. What the plugin is for is the builds that path cannot
answer for — a bundle shipping no source map, a map the browser will not fetch,
a compiled body that genuinely appears in more than one place. It is not the fix
for poor attribution generally, and its README says so: the common failure is a
lazy chunk that never loaded, and a chunk that did not load carries no stamp
either.

**It stamps the component function, never the JSX.** A `data-` attribute would
reach the DOM and change your application — your snapshot tests, your attribute
selectors, your accessibility tree — so what is emitted is
`Cart.__devflow = { f, l }`, one property assignment at module scope, invisible
to React and to the page — and wrapped in a `try`, because a module is strict
code and a wrapper of yours that hands back a frozen object would otherwise take
your development build down at import with a stack pointing at code you did not
write. Development builds only unless you ask otherwise:
stamping ships your repository's directory layout in the bundle, and shipping
that to every visitor is a decision to make deliberately.

**Every attribution says which path answered it, to a person and to a model.**
`ComponentSource.via` gained `plugin` beside `debug-source` and `bundle-search`;
the panel spells it `build stamp`, and so does every place a model reads a
component's source — the `## React components` table that `get_flow` returns and
`flow.md` holds on disk, `get_step_detail`, and the heading `get_source_snippet`
prints above the lines it read. So no recording can depend on the plugin without
whoever reads it being able to tell. DevFlow's
own two paths stay unlabelled there — a reader has no decision to make between
them, and a stamp is the one that means the answer came out of a build step in
the application itself. A stamp beats React's `_debugSource` where both exist, and for a
reason that is not about which is newer: `_debugSource` is where a component's
JSX was *written*, a position in its parent's file, and a stamp is where the
component was *defined* — which is what the source of a component has always
meant here. A component first captured without a stamp — a content script
re-injected after a navigation starts its cache empty — is upgraded from
`debug-source` to the stamp when it is seen again, and that is the only upgrade
a component table allows: without it the recording would keep naming the
parent's file while the panel, over the same component, named the component's
own.

**Babel only, and said rather than implied.** `@vitejs/plugin-react-swc` and
Next.js compile with SWC, which takes no Babel plugin, so this serves a real but
partial audience. Components defined below module scope and anonymous default
exports are not stamped either. All of it is listed in
`compiler-plugin/README.md` as gaps rather than left to be discovered.

**A Zustand store created outside a provider is still not read, and that is now
a decision rather than a deferral.** It was carried as waiting for "a mechanism
with a stable identity"; the mechanism has been looked for, against React 19 and
Zustand 4 and 5, and reading fibers does not produce one. A consumer's
`useSyncExternalStore` hook yields that component's *selection*, not the store —
so the union of what can be read is a fact about which components happened to be
mounted, a key leaves it when its component unmounts (a state change the store
never made), and the shape it presents differs between two recordings of one
store. The recording continues to say the gap exists rather than reading the
page as stateless, the same store provided through a context is read in full as
before, and the argument is written out in `ROADMAP_AND_PHASES.md` §1.2 with a
test pinning it.

**Class components are stamped too.** `class Cart extends React.Component` is a
real shape and was left out of the first cut for no better reason than that it
was not on the list. A class component's fiber `type` is the class itself, and a
class is a function object, so it reads back through the same property and the
same reader — no second mechanism.

**A stamped component under `node_modules` is flagged as one.** The component
table set `dependency` on an attribution that came from a bundle search and not
on one that came from a stamp or from `_debugSource`, so a recording could name
somebody else's component as a step's owner and render no `node_modules` tag for
it, while the panel — which has always set the flag for all three — tagged the
same component correctly.

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


**DevFlow can now ingest the spans your backend exported under that trace id, so
a recorded request joins to the work it caused on the far side.** Point your
OTLP exporter at `POST /v1/traces` on the MCP server and `get_backend_trace`
prints the span tree for a recording's traced calls: which service answered,
what it called, how long each step took, which one failed, and the SQL your own
tracer chose to record. This is the FE → BE → DB chain, and it is the other end
of the header — the id DevFlow put on the request is the id the spans arrive
under.

**It is off unless you start the server with `DEVFLOW_OTEL=1`, and that is the
opposite default from the commit stamp on purpose.** The stamp reads a
repository this machine already owns; this accepts a document written by a
process DevFlow has never met and turns it into rows in the accumulated graph.
Every other write the server takes is checked to have come from the extension
and this one cannot be, because the sender is your backend, which has no
extension origin.

**OTLP/JSON only.** A protobuf delivery is refused with a `415` naming the one
line that fixes it, `OTEL_EXPORTER_OTLP_TRACES_PROTOCOL=http/json`. A protobuf
decoder is a second wire format to get exactly right and a subtly wrong one does
not throw — it writes a plausible number into your graph.

**Spans arrive before the recording does, so they are held rather than dropped.**
Your backend exports within seconds of the request and you press Send when you
are ready; the join therefore runs when a recording arrives, and re-sending a
recording is how spans that turned up late get joined. Nothing with only one end
is written to the graph: a span whose trace id matches no recording is real, and
DevFlow has nothing to attach it to, so it waits and expires and never becomes a
node. `get_backend_trace` keeps three cases apart that have three different
fixes — a call that was never traced, a traced call whose spans have not
arrived, and a joined trace.

**The graph gained two node kinds, and neither of them is a span.** A span has a
random id, happens once and is never seen again, so a node per span would make
the graph a log. What accumulates is the **service** and the **operation** — that
service plus the span's name — with the timing and failure rates every other node
here carries. Operation names collapse opaque path segments the same way endpoint
names already did, so a handler is one node rather than one per invoice id.

**Backend nodes age out on the same retention sweep as everything else**, and
they are the ones that most need to: every other node in the graph is created by
you recording, while these are created by a span arriving on an endpoint nothing
on your machine paces. A graph holding only services now also counts as a graph
that holds something — spans normally arrive before the recording does, so
"services and no recordings yet" is the ordinary intermediate state and it used
to read as an empty install.
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
