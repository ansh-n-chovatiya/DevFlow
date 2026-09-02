---
ctx_schema: 1
adr: 3
title: settings have one table and one renderer
status: accepted
date: 2026-09-02
---

# 0003. settings have one table and one renderer

## Context
A setting has at least six representations: the `Settings` type, `DEFAULTS`, the
`resolve()` clamp, the options page input, the reset affordance and
`public/settings.default.json`. There are also two views over one store — the
options page and the panel's settings drawer — so a setting drawn in two places can
diverge in either. Every one of those is a place a setting can be added and then
missed somewhere else, and a setting that exists in five of six places fails
silently: it reads back as its default, or it is never clamped.

## Decision
A setting exists only as a row in `src/features/settings/fields.ts`, from which every
other representation is derived, and settings DOM is constructed only through the
primitives in `src/ui/settings/components.ts`.

## Consequences
Adding a setting means editing a data table and re-running `npm run build:settings`
to regenerate committed JSON, rather than writing the five lines where it is
actually used. It costs more when a setting genuinely does not fit the table's five
field types: Work Stream 3.1 wanted a free-form list of allowed origins, and
`levels` is a multi-select over a *fixed* `options` array whose `resolve()` would
have silently discarded a user's own origins. A sixth field type is guarded on
purpose — `tests/settings-row-shape.test.ts` asserts the five type names and the
shape count so a sixth cannot arrive unnoticed — so the allow-list shipped as a
pattern-validated `string` parsed by a pure function in `core/trace`. The contract
bent the feature rather than the feature bending the contract, and that is the
intended direction. `lint:settings-ui` additionally rejects a settings row built
with ad-hoc DOM or a class `components.css` does not declare, so a bespoke control
is a change to the primitives.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
