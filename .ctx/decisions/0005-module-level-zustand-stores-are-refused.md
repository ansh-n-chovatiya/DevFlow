---
ctx_schema: 1
adr: 5
title: module-level zustand stores are refused
status: accepted
date: 2026-09-02
---

# 0005. module-level zustand stores are refused

## Context
DevFlow reads Redux, TanStack Query and React Context in full, and Zustand only
when the store is provided through a context. The module-level `create()` store —
the common way Zustand is used — was carried for a while as "deferred on a
condition: it waits for a mechanism with a stable identity", which is not a
decision. The condition was then examined against real React 19.2.8 and Zustand
4.5.7 and 5.0.15, with three consumers of one module-level store, by walking the
consumers' hook lists:

1. `useSyncExternalStore`'s `queue` is `{ value, getSnapshot }`, and `getSnapshot`
   is **not** `api.getState` in either major — it is the closure Zustand builds per
   consumer, so calling it returns that component's *selection*.
2. The next hook is the effect `useSyncExternalStore` mounts, whose `deps` are
   `[api.subscribe]` — identical by reference across all three consumers. So
   consumers of one store *can* be grouped, and the earlier claim that its only
   identity was an opaque function reference was wrong.
3. Zustand 4 leaks `api.getState` through the `use-sync-external-store` shim's
   `useMemo` deps. Zustand 5 does not, and 5 is the current major.

Grouping is not enough, and that is what decides it. Even with every consumer
correctly grouped, what can be read is the union of the *selections* of whichever
components happened to be mounted — a fact about the route the recording visited,
not about the store. A selection disappears when its component unmounts, so the
state differ would emit a `remove` for a key the store never touched: a fabricated
state change, in the one part of the recording whose whole claim is that it
computes nothing. And `labelFor` falls back to a store's sorted top-level keys
precisely because that shape is stable across recordings; a union of selections is
not, so a `state_keys` node keyed on it accumulates one row per recording and
answers nothing. That is the shape the `v3.2.0` audit deleted.

## Decision
The module-level Zustand `create()` store is refused rather than deferred: it is not
read, and the recording says so in as many words via `stateNote`.

## Consequences
The most common Zustand setup is a hole in state capture, and users hit it. What
would overturn this is stated so the next attempt does not rediscover it: **a
mechanism that yields the store object — something with `getState` on it,
recognisable by its methods before anything is called — not a per-consumer
snapshot.** Reading fibers does not produce one on Zustand 5. Subscribing would, and
subscribing is writing to the page, which `src/injected/state.ts` refuses for the
reason its header gives. `tests/state-reader.test.ts` carries the measured hook
shape as a fixture and asserts it yields no store, so reversing this is a deliberate
act with a test to update rather than a drift.

## Status
Accepted. Supersede with a new ADR rather than editing this one.
