/**
 * Finding every React root on the page, once.
 *
 * ## Why this is a module now, and was rightly not one before
 *
 * `render.ts` and `state.ts` each carried this, and each said so: *"deliberately
 * a second copy rather than an import — the two modules are the two halves of
 * the page agent that may not depend on each other's lifecycle. If a third
 * caller ever wants this, the three share a module; two is not yet an
 * abstraction."* `architecture.ts` is the third caller, so this is that module,
 * created on the condition its own authors wrote down rather than on a general
 * preference for not repeating code.
 *
 * The lifecycle argument that kept the copies apart survives the merge intact,
 * because there is nothing here to have a lifecycle. This module holds no state,
 * caches nothing between calls and remembers no root: every call is a fresh
 * question to React and to the DOM. `state.ts` can call it while its store cache
 * is warm and `architecture.ts` can call it with nothing recording, and neither
 * can observe the other having done so.
 *
 * ## Two answers, and the second is not the fallback
 *
 * React DevTools' `getFiberRoots` is the authoritative answer — it is how React
 * itself reports what it has mounted, and it covers roots rendered into places
 * a DOM scan will not look. It is also absent on most browsers, because most
 * browsers do not have React DevTools installed. So the container-key scan below
 * runs **whether or not the hook answered**, and both results feed one
 * deduplicating `add`. Treating the scan as a fallback would make DevFlow's
 * answer depend on whether somebody else's extension happened to be installed,
 * which is the kind of difference that is invisible until a bug report cannot be
 * reproduced.
 *
 * ## Nothing here assigns to the hook
 *
 * It is read and never written. Installing a renderer of our own to make
 * `getFiberRoots` appear is precisely what the reverted `v3.2.0` attempt did one
 * global over, to `__REDUX_DEVTOOLS_EXTENSION__`, and it broke every page with
 * Redux on it whether or not anything was recording. A hostile or merely unusual
 * hook object throws inside the `try` and costs the scan nothing.
 *
 * Generic over the fiber type so each caller keeps its own narrowed view of a
 * fiber — `RenderFiber`, `StateFiber`, `TreeFiber` — rather than the three
 * agreeing on a widened one none of them wanted. The constraint is the shape
 * this module actually touches, which is none of it: a root is passed straight
 * back to the caller that asked for it.
 */

/** The part of React DevTools' global hook this module reads. Never writes. */
interface DevToolsHook<F> {
  renderers?: Map<number, unknown>;
  getFiberRoots?: (id: number) => Set<{ current?: F | null }> | undefined;
}

/**
 * The candidate set `hasReactRoot` uses, for the same reason: a React app is
 * nearly always mounted into `<body>` or a direct child of it, and scanning
 * every element on the page to find out would cost more than the walk it feeds.
 */
export function containerCandidates(): Element[] {
  const out: Element[] = [];
  if (document.body) {
    out.push(document.body);
    for (const child of Array.from(document.body.children)) out.push(child);
  }
  for (const id of ['root', 'app', '__next', '__nuxt']) {
    const el = document.getElementById(id);
    if (el) out.push(el);
  }
  return out;
}

/**
 * Every React root on the page, deduplicated, in discovery order.
 *
 * An empty array is a page with no React on it, which is not a failure and must
 * not be reported as one: most of the web is not a React app, and the agent is
 * injected into all of it.
 */
export function reactRoots<F extends object>(): F[] {
  const found: F[] = [];
  const seen = new Set<F>();

  const add = (fiber: F | null | undefined): void => {
    if (fiber && !seen.has(fiber)) {
      seen.add(fiber);
      found.push(fiber);
    }
  };

  try {
    const hook = (window as unknown as Record<string, unknown>)
      .__REACT_DEVTOOLS_GLOBAL_HOOK__ as DevToolsHook<F> | undefined;
    if (hook?.renderers && typeof hook.getFiberRoots === 'function') {
      for (const id of hook.renderers.keys()) {
        for (const root of hook.getFiberRoots(id) ?? []) add(root?.current);
      }
    }
  } catch {
    // A hostile or unusual hook object. The scan below is the answer that does
    // not depend on anyone else's extension being well behaved.
  }

  for (const el of containerCandidates()) {
    for (const key of Object.keys(el)) {
      if (!key.startsWith('__reactContainer$')) continue;
      const container = (el as unknown as Record<string, unknown>)[key];
      add(container as F);
    }
    const legacy = (el as unknown as { _reactRootContainer?: { _internalRoot?: { current?: F } } })
      ._reactRootContainer;
    add(legacy?._internalRoot?.current);
  }

  return found;
}
