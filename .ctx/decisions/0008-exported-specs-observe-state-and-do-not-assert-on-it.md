---
ctx_schema: 1
adr: 8
title: exported specs observe state and do not assert on it
status: accepted
date: 2026-09-02
---

# 0008. exported specs observe state and do not assert on it

## Context
The flow-to-test compiler writes Playwright and Cypress specs from a recording, and
Work Stream 2.1 asks for state assertions generated from the before/after store
diffs DevFlow already captures. The obstacle is how DevFlow reads a store at all: it
walks React's fiber tree from inside the page. A test runner has no handle on that.
Playwright *could* run the same walk through `page.evaluate`, and that is precisely
what must not be generated — a few hundred lines of React-internals code pasted into
a file the developer owns, frozen at the React version current the day the flow was
exported, whose failure mode is a red suite reporting an application bug that is not
there. An assertion that can be wrong about the thing it asserts is worse than no
assertion, because the response to a red test is to go and look at the app.

## Decision
An exported spec carries the store operations as commented observations beside the
step that caused them — with the `bounded` and `collapsed` flags that change what a
patch means — and generates no state assertion.

## Consequences
The exported suite proves the journey through the interface and never proves the
store ended up right; a user who wants that has to write the assertion themselves
against whatever handle they choose to expose, which is an app change and therefore
Invariant 1's whole point. A second open question is narrowed rather than answered:
which of a patch's operations are worth asserting on still cannot be decided from a
fixture, so nothing ranks them — operations print in the differ's path order,
because a reader scanning for a path they recognise is best served by an order they
can predict, capped at six per store with the count of what was not printed and the
name of the tool that has the rest.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
