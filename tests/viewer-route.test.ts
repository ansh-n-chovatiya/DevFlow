import { describe, expect, it } from 'vitest';
import { LIBRARY, parseRoute, routeHash, sameRoute } from '../src/ui/viewer/route.js';

describe('parseRoute', () => {
  it('reads the two views', () => {
    expect(parseRoute('#/')).toEqual({ view: 'library' });
    expect(parseRoute('#/current')).toEqual({ view: 'review', id: null });
    expect(parseRoute('#/flow/flow_1723600000000')).toEqual({
      view: 'review',
      id: 'flow_1723600000000',
    });
  });

  it('falls back to the library for anything it does not recognise', () => {
    // A hash is user-editable and survives across versions, so an unknown one
    // has to land somewhere real. The library is the view that always has
    // something to show.
    for (const hash of ['', '#', '#/', '#/nope', '#/flow/', '#library']) {
      expect(parseRoute(hash)).toEqual(LIBRARY);
    }
  });

  it('refuses an id that is not shaped like an id', () => {
    // The value is concatenated into a `savedFlow_<id>` storage key, so a hash
    // carrying a slash or a dot must not become a lookup.
    expect(parseRoute('#/flow/../recordedSteps')).toEqual(LIBRARY);
    expect(parseRoute('#/flow/a b')).toEqual(LIBRARY);
    expect(parseRoute(`#/flow/${'x'.repeat(65)}`)).toEqual(LIBRARY);
  });

  it('accepts an id that arrived percent-encoded', () => {
    expect(parseRoute('#/flow/flow%5F12')).toEqual({ view: 'review', id: 'flow_12' });
  });
});

describe('routeHash', () => {
  it('round-trips every route', () => {
    for (const route of [
      LIBRARY,
      { view: 'review', id: null } as const,
      { view: 'review', id: 'flow_1' } as const,
    ]) {
      expect(parseRoute(routeHash(route))).toEqual(route);
    }
  });
});

describe('sameRoute', () => {
  it('separates the library, the live flow and a saved flow', () => {
    expect(sameRoute(LIBRARY, LIBRARY)).toBe(true);
    expect(sameRoute(LIBRARY, { view: 'review', id: null })).toBe(false);
    // The live recording and a saved flow are different flows even though both
    // are the review view — navigating between them must reload.
    expect(sameRoute({ view: 'review', id: null }, { view: 'review', id: 'flow_1' })).toBe(false);
    expect(sameRoute({ view: 'review', id: 'flow_1' }, { view: 'review', id: 'flow_2' })).toBe(
      false,
    );
    expect(sameRoute({ view: 'review', id: 'flow_1' }, { view: 'review', id: 'flow_1' })).toBe(true);
  });
});
