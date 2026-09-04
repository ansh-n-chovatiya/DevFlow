/**
 * The `FrameworkAdapter` for Next.js App Router, and the honest half of it.
 *
 * ## Two runtimes wearing one name
 *
 * Every other adapter in this repository answers one question one way. This one
 * has to answer it two ways, because `.ctx/spike-rsc.md` measured the identity
 * living in different places in the two builds — on the fiber in dev, and
 * *nowhere* in prod for a server component. §3, verbatim:
 *
 * ```
 * dev  names: <button> > <div> > ClientCounter > <main> > SegmentViewNode > …
 * prod names: <button> > <div> > anon-fn      > <main> > null            > …
 * prod: any hasDebugStack? false   any hasDebugOwner? false
 * ```
 *
 * So `fromElement` forks on the build, and the build is read off the payload
 * (`flight.ts`) rather than off the tree, because `detect` is contracted never
 * to walk one.
 *
 * ## Why the production arm returns `absent` instead of trying harder
 *
 * There is a version of this file that fetches the served chunks, follows
 * `//# sourceMappingURL=`, and resolves client components to their `.tsx` — the
 * spike measured that working, under `productionBrowserSourceMaps: true`. That
 * is a real capability and it belongs to the *client* half. It does nothing for
 * a server component: the same probe re-run against that build found every
 * debug field still null. And the one artefact that maps a prod wire fact to a
 * file, `page_client-reference-manifest.js`, 404s on all three plausible served
 * paths.
 *
 * Manufacturing a mechanism there would produce an attribution that is wrong in
 * a way nobody can check, which is worse than the silence it replaces. So the
 * production server-component answer is `absent` with `server-rendered`, and the
 * filesystem route that *can* answer it is `mcp-server/rsc.js`, which is a
 * different process with a different capability.
 *
 * ## Why there is a port
 *
 * `src/core/` may not touch the DOM and `src/injected/` may not install,
 * patch or subscribe to anything. Both hold: the adapter is handed readings —
 * plain data already lifted off the fibers and the `<script>` tags — and every
 * decision made on them is here, testable, with no browser. The reader that
 * produces them is a dozen lines in the extension and is on the integrator
 * queue, not in this unit.
 *
 * Pure — no DOM, no Chrome, no network. `Element` appears only as the type the
 * frozen contract already put in `fromElement`'s signature; nothing here calls
 * a method on one.
 */

import type {
  FrameworkAdapter,
  FrameworkPresence,
  ResolvedChain,
  Resolution,
} from '../locate/adapter.js';
import { isServerComponent, readDebugInfo, resolutionFor } from './debug.js';
import {
  buildFromFlight,
  buildFlightModel,
  flightClientModuleFor,
  flightElementFor,
  joinFlightChunks,
  splitFlightRows,
  type ClientModuleRef,
  type ElementDescriptor,
  type FlightModel,
} from './flight.js';

/**
 * One fiber, as much of it as a pure module is willing to be handed.
 *
 * Deliberately not the fiber. A `Fiber` in this repository is `core/react/`'s
 * type, and `core/rsc/` importing it would make the RSC reader depend on the
 * React reader for a shape it uses four fields of — the same import that ADR
 * 0026 moved the locate engine out of `core/react/` to prevent, and the same one
 * that gets a second copy written when somebody later wants Vue to have it too.
 */
export interface RscFiberReading {
  /** The component's name as the runtime has it, or null for a host element. */
  name: string | null;
  /** A DOM host fiber — `div`, `main`. Those are elements, not components. */
  host: boolean;
  /** `fiber._debugInfo`, verbatim and untyped. Empty or absent in production. */
  debugInfo?: unknown;
  /** `Function.prototype.toString()` of the fiber's type, when it is a function. */
  fnSource?: string | null;
}

/**
 * What the impure half must provide.
 *
 * `flightChunks` is a list rather than a string on purpose: §6 measured a row
 * straddling two `self.__next_f.push` fragments, so the join has to happen
 * before the split and the only way to guarantee that from here is to be handed
 * the pieces. It is also why the port is asked for the *`<script>` tags'*
 * contents — `self.__next_f` itself is drained to length 0 by hydration in both
 * builds, so a port that reads the global returns an empty list and this adapter
 * reports, wrongly, that the page is not RSC.
 */
export interface RscPort {
  /** The inline flight payloads, in document order. Never `self.__next_f`. */
  flightChunks(): readonly string[];
  /** Ancestors of an element, nearest first, including the element's own fiber. */
  readingsFor(el: Element): readonly RscFiberReading[] | null;
  /** Tag and the attributes worth matching on, for the production join. */
  describe(el: Element): ElementDescriptor | null;
  /** The Next.js version, when the page says. Never inferred from behaviour. */
  version?(): string | null;
}

/** How far up a tree one pick may look. Long chains are noise, not context. */
const MAX_CHAIN = 40;

export function createRscAdapter(port: RscPort): FrameworkAdapter {
  const modelOf = (): FlightModel | null => {
    const chunks = port.flightChunks();
    if (chunks.length === 0) return null;
    const { rows } = splitFlightRows(joinFlightChunks(chunks));
    if (rows.length === 0) return null;
    return buildFlightModel(rows);
  };

  return {
    framework: 'rsc',

    detect(): FrameworkPresence {
      const model = modelOf();
      if (!model) return { framework: 'rsc', detected: false };

      const presence: FrameworkPresence = {
        framework: 'rsc',
        detected: true,
        build: buildFromFlight(model),
      };
      const version = port.version?.() ?? null;
      if (version) presence.version = version;
      return presence;
    },

    fromElement(el: Element): ResolvedChain | null {
      const readings = port.readingsFor(el);
      if (!readings || readings.length === 0) return null;

      const model = modelOf();
      const build = model ? buildFromFlight(model) : 'unknown';
      const descriptor = port.describe(el);

      const chain: Resolution[] = [];
      const capped = readings.slice(0, MAX_CHAIN);

      for (const reading of capped) {
        for (const resolution of resolutionsFrom(reading)) chain.push(resolution);
      }

      /*
       * What the wire says this element's own client module is.
       *
       * Read before the production arm below, because the two answers are
       * mutually exclusive and this one is the stronger evidence: an element
       * whose props sit under an `I` row reference was rendered by that client
       * module, so `server-rendered` would be false about it. The fiber cannot
       * contradict this — in production it has been minified to `anon-fn` — so
       * there is nothing to weigh it against.
       */
      const clientModule = model && descriptor ? flightClientModuleFor(model, descriptor) : null;
      if (clientModule) foldClientModule(chain, clientModule);

      /*
       * The production arm, and its guard used to be `chain.length === 0`.
       *
       * On a real App Router page the chain is *never* empty. Next's own client
       * boundaries — `LayoutRouter`, `RedirectBoundary`, `ErrorBoundary` and
       * friends — are plain functions in the production bundle, so the walk
       * yields a `searchable` for each of them; seven were measured on one
       * page. The arm was therefore unreachable on exactly the page it was
       * written for, and a click on server-rendered markup answered with
       * Next's minified wrapper instead of saying a server component rendered
       * it. Found by running the built extension against a real Next.js app.
       *
       * The original worry was right and is kept: `server-rendered` must never
       * be claimed over a real answer. So the two cases are separated.
       *
       * A `declared` resolution *is* a real answer, and nothing is appended
       * over it. Next's wrappers are not — they are ancestors of the element,
       * not the thing that rendered it — so when the element's own markup is in
       * the flight payload, a server component rendered it, and that stays true
       * however many wrappers sit above. Only the wire decides.
       */
      const hasIdentity = chain.some((resolution) => resolution.kind === 'declared');
      if (!hasIdentity && !clientModule && build === 'production' && model) {
        const onTheWire = flightElementFor(model, descriptor ?? { tag: '', attributes: {} });
        /*
         * When the markup is on the wire, say so whatever the wrappers
         * contributed. When it is not, only answer for a chain that found
         * nothing at all — otherwise `stripped-by-build` would be appended
         * beside real, if unresolved, client components.
         */
        if (onTheWire || chain.length === 0) {
          /*
           * `unshift`, not `push`. The chain is built nearest-first and reversed
           * below, so the element's own position is the *front* of it. This
           * statement is about the element — a server component rendered this
           * markup — while the wrappers above are ancestors, so pushing put the
           * element's own answer at the outermost end, which reads as though
           * something at the root of the page had been server-rendered.
           */
          chain.unshift(productionResolution(model, descriptor));
        }
      }

      if (chain.length === 0) return null;

      // Outermost first, per the contract. The port walks nearest-first because
      // that is the direction a fiber tree is walked; reversing here rather than
      // asking the port to do it keeps the one ordering rule in one place.
      chain.reverse();

      const resolved: ResolvedChain = { framework: 'rsc', chain };
      if (readings.length > MAX_CHAIN) resolved.truncated = true;
      return resolved;
    },
  };
}

/**
 * Folds the wire's client-module reference into the chain, in place.
 *
 * ## Why it edits a resolution rather than adding one
 *
 * The chain is built nearest-first, so its first non-`absent` entry is the
 * component that rendered the picked element — which is the same component the
 * `I` row names. Appending a second entry for it would put one component in the
 * chain twice under two ids, and the flow's component table is keyed by id, so
 * the duplicate is not cosmetic: it is two rows a reader has to notice are the
 * same thing.
 *
 * ## The dev upgrade, and why it is not a special case
 *
 * When the id is a path (`ClientModuleRef.sourceFile`, development), a
 * `searchable` resolution becomes `declared`. That is not politeness — a
 * `searchable` costs a bundle fetch, a source-map decode and a text search, and
 * the answer they arrive at is the file the wire already stated. `at:
 * 'declaration'` because a module id names where the module *is*, unlike the
 * `_debugInfo` stack frame beside it, which names a call site.
 *
 * When the id is an integer (production) nothing about the status changes and
 * only `moduleId` is added: this file cannot open `.next/server`, so claiming a
 * file here would be inventing one. `mcp-server/rsc.js` finishes it.
 */
function foldClientModule(chain: Resolution[], ref: ClientModuleRef): void {
  const moduleId = String(ref.moduleId);
  const index = chain.findIndex((resolution) => resolution.kind !== 'absent');

  if (index === -1) {
    // Nothing on the fiber survived the build, so the wire is the only witness.
    chain.unshift(
      ref.sourceFile
        ? {
            kind: 'declared',
            name: clientModuleName(ref, chain),
            source: ref.sourceFile,
            at: 'declaration',
            moduleId,
          }
        : {
            kind: 'absent',
            name: clientModuleName(ref, chain),
            reason: 'stripped-by-build',
            detail:
              'A production build left this client component nothing but a module id on the ' +
              `wire (${moduleId}). Its file is in .next/server on the machine that built the ` +
              'app, which the browser cannot read and the MCP server can.',
            moduleId,
          },
    );
    return;
  }

  const held = chain[index];
  if (held.kind === 'searchable' && ref.sourceFile) {
    chain[index] = {
      kind: 'declared',
      name: held.name || clientModuleName(ref, chain),
      source: ref.sourceFile,
      at: 'declaration',
      moduleId,
    };
    return;
  }

  chain[index] = { ...held, moduleId };
}

/**
 * A name for a component the wire identified and the fiber did not.
 *
 * The module path's stem first, because in development it is the author's own
 * file name and `ClientCounter` is what they would call it. A real fiber name
 * next. The export name only when it is not `default`, which is the majority
 * and names nothing. `Anonymous` last, and it is `id.ts`'s placeholder on
 * purpose — a name that identifies nothing must be *marked* as one rather than
 * quietly hashed into an identity.
 */
function clientModuleName(ref: ClientModuleRef, chain: readonly Resolution[]): string {
  if (ref.sourceFile) {
    const stem = (ref.sourceFile.split('/').pop() ?? '').replace(/\.[^.]+$/, '');
    if (stem !== '') return stem;
  }
  for (const resolution of chain) {
    if (resolution.kind !== 'absent' && resolution.name !== '') return resolution.name;
  }
  if (ref.exportName !== '' && ref.exportName !== 'default') return ref.exportName;
  return 'Anonymous';
}

/**
 * What one fiber reading is worth, best evidence first.
 *
 * `_debugInfo` before the function source, which is `preferResolution`'s rule
 * applied one step earlier: the runtime's own record costs no bundle fetch, no
 * map decode and no search, and in dev it is the *only* thing that names a
 * server component at all — the function is not in the browser to be searched
 * for.
 *
 * A host fiber contributes nothing of its own. It can still carry `_debugInfo`,
 * and measured it does: the server component's record sits on the `<div>` it
 * produced, not on a fiber of its own, because a server component has no fiber
 * in the client tree. That is the whole reason this reads debug info off host
 * readings too rather than skipping them.
 */
function resolutionsFrom(reading: RscFiberReading): Resolution[] {
  const out: Resolution[] = [];

  for (const component of readDebugInfo(reading.debugInfo)) {
    if (!isServerComponent(component)) continue;
    out.push(resolutionFor(component));
  }

  if (reading.host) return out;

  const fnSource = reading.fnSource;
  if (typeof fnSource === 'string' && fnSource !== '') {
    out.push({ kind: 'searchable', name: reading.name ?? '', fnSource });
  }

  return out;
}

/**
 * The production answer, and the difference between the two ways of not knowing.
 *
 * A hit in the flight payload is positive evidence: the element's markup is on
 * the wire, so a server component emitted it, so its identity was stripped by
 * this build and no amount of client-side work will recover it. That is
 * `server-rendered`, and the detail names the one thing that *can* answer it.
 *
 * A miss is not the same claim and must not wear the same reason. The element
 * may be a client component whose fiber has been minified past recognition —
 * measured, `anon-fn` and `null` where dev had `ClientCounter` and
 * `SegmentViewNode`. That is `stripped-by-build`, which is a different fix: the
 * client map exists under `productionBrowserSourceMaps`, and the server one
 * never does.
 */
function productionResolution(model: FlightModel, descriptor: ElementDescriptor | null): Resolution {
  const onTheWire = descriptor ? flightElementFor(model, descriptor) : null;

  if (onTheWire) {
    return {
      kind: 'absent',
      reason: 'server-rendered',
      detail:
        'This markup is in the flight payload, so a server component rendered it. A production ' +
        'build leaves a server component no name, no module id and no file anywhere the browser ' +
        'can reach. The mapping exists only in .next/server on the machine that built it, which ' +
        'is what the MCP server reads.',
    };
  }

  return {
    kind: 'absent',
    reason: 'stripped-by-build',
    detail:
      'This production build minified the component away and left no debug info on the fiber. ' +
      'The markup is not in the flight payload either, so it was most likely rendered by a ' +
      'client component; building with productionBrowserSourceMaps is what makes that one ' +
      'answerable from the browser.',
  };
}
