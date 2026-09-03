---
ctx_schema: 1
adr: 19
title: the ide half of the live link is deferred and its query shipped without it
status: accepted
date: 2026-09-03
---

# 0019. the ide half of the live link is deferred and its query shipped without it

## Context
Work Stream 4.2 is two things wearing one heading. The Source to Browser Live Link wants a VS Code extension that sends a cursor position to the local MCP server, which maps it to a component, which makes the Chrome extension highlight the live DOM element. The Live Blast-Radius Preview wants to answer, before a commit, which components and API calls a change to one file currently affects. Costing them separately found that the second was already built and the first needs two things this product has never had. getBlastRadius has existed in mcp-server/arkg.js since Phase 0, with tests in tests/arkg.test.ts, reachable from nothing at all — no MCP tool, no UI, no caller in src/. A query no surface prints does not exist from outside the process. The IDE half needs a fourth npm package, published, plus the one direction the MCP server still cannot address: a channel from the server to an open tab. The compiler plugin is the standing precedent for what a fourth package costs — it is private true and unpublished precisely because it has never been run against a real application's build, and a VS Code extension is a larger version of that same bet.

## Decision
The VS Code extension and any persistent server-to-tab channel are deferred. The blast-radius query gains a reader instead: get_blast_radius, shipped in Phase 4.3, which makes its claim at the size maps_to supports — components observed to have been written in a file, plus one hop of what each was seen calling and reading, and explicitly not the files that import it, because an import is a static fact and nothing in a runtime graph observes one.

## Consequences
A developer does not get the IDE-to-browser highlight, and the roadmap says so rather than leaving 4.2 unticked with no argument beside it. What they do get is the question that half of 4.2 was really for, answerable by the model already in the loop: what has the runtime actually put through this file. The roadmap's own example for 4.2 — this change to useCartStore.ts:42 currently affects 7 rendered components — is recorded as wider than a runtime graph can answer, because a store's own file usually has no components written in it and the subscribers are reached through an edge, not through the file. Building the editor half later starts from a query that now has a caller and a stated boundary, which is a better starting point than it had.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
