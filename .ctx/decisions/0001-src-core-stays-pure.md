---
ctx_schema: 1
adr: 1
title: src/core stays pure
status: accepted
date: 2026-09-02
---

# 0001. src/core stays pure

## Context
`src/core/` has two consumers, not one. It runs in the extension, where `chrome.*`,
`window` and the DOM all exist, and it is bundled by `src/core/mcp-bundle.ts` into
`mcp-server/core.js`, which is imported by a Node process where none of them do.
An impure import in `core/` is therefore not a style problem: it fails
`npm run build:mcp`, or it survives the build and throws on the MCP server's first
tool call, in a package published separately from the extension. The same pressure
recurs every time a core module wants to fetch a bundle, read a clock, or reach
storage — each of those is a genuinely convenient thing to do from inside the pure
tree.

## Decision
`src/core/` contains no `chrome.*` call, no DOM access, no bare `fetch`, no clock
and no randomness; fetching and caching belong to a `BundleProvider`, and the clock
and storage belong to `src/features/`.

## Consequences
Every impure capability core needs has to be passed in as an argument or hidden
behind an injected provider, which costs an interface and a parameter at each call
site — `core/provenance` takes spans as an argument rather than reading them off a
socket, and `core/otel` decides which spans are admissible without ever receiving
one. It rules out the shortest implementation of nearly every feature that touches
the network. What it buys is that core is testable without a browser, and that the
MCP server can be a second npm package at all.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
