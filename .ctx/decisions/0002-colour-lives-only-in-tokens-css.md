---
ctx_schema: 1
adr: 2
title: colour lives only in tokens.css
status: accepted
date: 2026-09-02
---

# 0002. colour lives only in tokens.css

## Context
DevFlow's surfaces render in both a light and a dark theme, and a colour literal
written anywhere other than the token file is invisible in one of them and wrong in
the other. The failure is silent: nothing throws, nothing looks broken to whoever
wrote it, and the defect is only ever found by a user in the other theme. A design
system is a system exactly as long as nothing bypasses it, and one literal is
enough to end that.

## Decision
Every colour is declared in `src/ui/styles/tokens.css` and referenced by token
elsewhere; `npm run lint:tokens` reads every stylesheet and HTML file and rejects a
hex, `rgb()`, `hsl()`, `oklch()`, `lab()` or `color-mix()` written outside it.

## Consequences
A one-off shade for a single element cannot be written where it is used — it has to
be named and added to the token file first, which is friction on exactly the small
changes that feel like they do not deserve it, and it means the token file
accumulates names. Inline `style` colour and third-party CSS pasted in verbatim are
both blocked. In exchange, adding or retuning a theme is one file, and no surface
can silently opt out of it.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
