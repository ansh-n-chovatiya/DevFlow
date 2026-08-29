/**
 * Which of the viewer's two views is on screen.
 *
 * Structural decision A: choosing a flow and inspecting a flow are different
 * jobs, and conflating them is why the old toolbar had seven buttons. They are
 * two views of one page rather than two pages because they share the flow store,
 * the export dialog and the annotation editor — and because Back has to be
 * instant, not a second document load.
 *
 * The route lives in the hash so a flow is linkable: the popup opens
 * `viewer.html#/current` for the recording in progress and `viewer.html` for the
 * library, and reloading the tab lands where it was rather than at the top.
 *
 * Pure — see tests/viewer-route.test.ts.
 */

export type Route =
  | { view: 'library' }
  /** The unsaved recording. */
  | { view: 'review'; id: null }
  /** A flow from the library. */
  | { view: 'review'; id: string };

export const LIBRARY: Route = { view: 'library' };

/**
 * A flow id, as it may appear in a hash.
 *
 * Ids are minted as `flow_<timestamp>`, but a hash is user-editable and this
 * value is concatenated into a storage key, so anything outside the alphabet a
 * real id uses is rejected rather than looked up.
 */
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export function parseRoute(hash: string): Route {
  const path = hash.replace(/^#/, '');

  if (path === '/current') return { view: 'review', id: null };

  const flow = /^\/flow\/(.+)$/.exec(path);
  if (flow) {
    const id = decodeURIComponent(flow[1]);
    if (ID_PATTERN.test(id)) return { view: 'review', id };
  }

  // Anything else — '', '/', a stale route from an older build, a typo — is the
  // library, which is the one view that always has something to show.
  return LIBRARY;
}

export function routeHash(route: Route): string {
  if (route.view === 'library') return '#/';
  return route.id === null ? '#/current' : `#/flow/${encodeURIComponent(route.id)}`;
}

/** Do two routes name the same view of the same flow? */
export function sameRoute(a: Route, b: Route): boolean {
  if (a.view !== b.view) return false;
  return a.view === 'library' || a.id === (b as { id: string | null }).id;
}
