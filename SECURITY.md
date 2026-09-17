# Security Policy

## Reporting a vulnerability

Report it privately through GitHub's own mechanism for this, not a public
issue:

**[Report a vulnerability](https://github.com/ansh-n-chovatiya/DevFlow/security/advisories/new)**
(Security tab → "Report a vulnerability" → "New draft security advisory").

That opens a private advisory only the maintainer (and anyone they add) can
see, with its own thread for follow-up and, once a fix ships, a coordinated
disclosure and a CVE if one is warranted. It requires a GitHub account and
nothing else — no separate registration, no key exchange.

If you cannot use GitHub for some reason, open a regular issue asking to be
contacted through another channel, without describing the vulnerability
itself. Do not put exploit details or affected user data in a public issue,
a public PR, or a public discussion.

## What to include

Whichever path you use, the useful report has:

- The affected file(s) and, if you have it, the commit or version.
- Steps to reproduce, or a proof of concept.
- What an attacker can actually do with it — read, write, or run what, as
  whom, under what preconditions (e.g. "reachable only in `MCP_MODE=remote`",
  "requires the victim to have DevFlow's HTTP receiver running locally").
- Whether it's in `src/` (the extension), `mcp-server/` (the MCP server,
  published separately as `devflow-server` on npm), or `compiler-plugin/`
  (`devflow-compiler-plugin`) — the three things that ship independently and
  may need independent fixes and releases.

## What to expect

This is a solo-maintained project. There is no SLA. A genuine security report
gets priority over everything else in the backlog, and a fix ships as a patch
release through the same `npm run release` path every other release uses —
see `CONTRIBUTING.md`. You will get an acknowledgement, and credit in the
advisory and the changelog if you want it, unless you ask to stay anonymous.

## Scope

In scope: the Chrome extension (`src/`, `public/`), the MCP server
(`mcp-server/`, both local `stdio` mode and remote `MCP_MODE=remote` mode),
and the Babel compiler plugin (`compiler-plugin/`). Findings against
dependencies belong upstream, though a report here that names the dependency
and the exposure is still useful — this repo's own `package-lock.json` /
`mcp-server/package-lock.json` pin versions that can be bumped independently
of upstream's own disclosure timeline.

## Supported versions

Only the latest published release of each package (`devflow` the extension,
`devflow-server`, `devflow-compiler-plugin`) is supported. There is no LTS
branch; a fix lands in the next release, not backported to an older one.
