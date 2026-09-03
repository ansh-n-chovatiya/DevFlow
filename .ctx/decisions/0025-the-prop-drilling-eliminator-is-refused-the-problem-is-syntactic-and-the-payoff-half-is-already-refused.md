---
ctx_schema: 1
adr: 25
title: the prop drilling eliminator is refused: the problem is syntactic and the payoff half is already refused
status: accepted
date: 2026-09-04
---

# 0025. the prop drilling eliminator is refused: the problem is syntactic and the payoff half is already refused

## Context
ROADMAP_AND_PHASES.md $5.3 asks DevFlow to identify prop-drilled chains from runtime observation rather than static analysis, propose a concrete refactor, and auto-generate the code change with blast-radius analysis. It splits into two halves and neither survives. Prop drilling is a syntactic property of the source: a prop declared, passed and passed again through components that do not use it. Reading the code finds it, and so do lint rules and codemods that exist today in every editor. What runtime observation adds is that the chain really mounts and how often it does — a useful footnote, not a capability, and DevFlow does not have it cheaply anyway: `memoizedProps` is read today only for reference identity in render blame, never by value, so identifying a named prop travelling down a chain means a new capture surface carrying application values through a path that currently carries none. The second half is the one that would actually save somebody work, and it is refused three times over: ADR 0009 is that DevFlow diagnoses and verifies and does not patch, $2.4 restates it as a tool, and ADR 0020 restates it as a CI workflow.

## Decision
$5.3 is refused and removed from the roadmap. The detection half is better served by static tools that already exist, and the generation half is ADR 0009.

## Consequences
DevFlow does not offer refactoring advice, which keeps it out of the space "What NOT to Build" already reserves for Cursor and Claude Code — generic AI refactoring, where runtime data creates no unique advantage. It also avoids adding prop values to a capture path that deliberately carries none. What would overturn this is a refactor whose case rests on something only runtime can know and static analysis cannot, argued with an example; prop drilling is not that, because the chain is visible in the file.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
