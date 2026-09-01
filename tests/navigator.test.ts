/**
 * What the description was reduced to, and what that reduction is allowed to
 * claim.
 *
 * Three things fail silently here and each has tests below.
 *
 * **The identifier split is the whole difference between this and a grep.** If
 * `CartBadge` stops being the words `cart` and `badge`, every match quietly
 * degrades to a substring hit — "cart" still finds it, so nothing looks broken,
 * but it now finds it on the same footing as `Cartesian` and `Chart`, and the
 * one signal the caller uses to tell a real lead from a coincidence is gone.
 *
 * **The bases are the ranking.** They are strongest-claim-first for a reason: a
 * caller reads the top of the list. Invert or flatten them and the answer is
 * still a plausible-looking list of entities with the fragment matches at the
 * top, which no test that only checks membership would catch.
 *
 * **Dropped terms must come back.** A description of nothing but common words
 * and a description that matched nothing produce the same empty `matches`, and
 * only `dropped` separates *your words narrowed nothing* from *this app has
 * none of your words*. A caller that cannot tell them apart reports the wrong
 * one, and it reports it confidently.
 */

import { describe, expect, it } from 'vitest';
import {
  findFeature,
  readQuery,
  type NavigatorEntity,
} from '../src/core/navigator/index.js';

function entity(over: Partial<NavigatorEntity> & { id: string }): NavigatorEntity {
  return { kind: 'component', name: over.id, ...over };
}

/** Bases in the order they came back, which is the assertion most tests make. */
function shape(matches: readonly { entity: NavigatorEntity; basis: string }[]) {
  return matches.map((match) => [match.entity.id, match.basis]);
}

describe('reading a description into terms', () => {
  it('drops the common words and reports every one of them', () => {
    expect(readQuery('how does the checkout page work')).toEqual({
      terms: ['checkout'],
      dropped: ['how', 'does', 'the', 'page', 'work'],
    });
  });

  it('leaves no terms at all when the description is all common words', () => {
    // Not an error and not "no matches" — the caller has to be able to say
    // "that described anything" rather than "this app has none of that".
    const query = findFeature('how does this page work', [entity({ id: 'CartBadge' })], 10);
    expect(query.terms).toEqual([]);
    expect(query.matches).toEqual([]);
    expect(query.dropped).toEqual(['how', 'does', 'this', 'page', 'work']);
  });

  it('drops terms of a single character, which are inside every name', () => {
    expect(readQuery('a v cart')).toEqual({ terms: ['cart'], dropped: ['a', 'v'] });
  });

  it('collapses a repeated term so it cannot inflate coverage', () => {
    expect(readQuery('cart cart badge')).toEqual({ terms: ['cart', 'badge'], dropped: [] });
  });
});

describe('identifier splitting', () => {
  it('finds CartBadge for "cart" as a word, not as a fragment', () => {
    const cartBadge = entity({ id: 'c1', name: 'CartBadge' });
    const query = findFeature('cart', [cartBadge], 10);
    expect(query.matches).toEqual([
      { entity: cartBadge, terms: ['cart'], basis: 'name-word' },
    ]);
  });

  it('splits a URL into its path segments', () => {
    const endpoint = entity({ id: 'e1', kind: 'endpoint', name: '/api/v1/invoices' });
    expect(findFeature('invoices', [endpoint], 10).matches).toEqual([
      { entity: endpoint, terms: ['invoices'], basis: 'name-word' },
    ]);
    expect(findFeature('v1 api', [endpoint], 10).matches[0]?.basis).toBe('name-word');
  });

  it('splits on the separators code names actually use', () => {
    const dashed = entity({ id: 'd1', kind: 'file', name: 'use-cart.ts' });
    const scored = entity({ id: 'd2', name: 'cart_badge_row' });
    expect(findFeature('cart', [dashed], 10).matches[0]?.basis).toBe('name-word');
    expect(findFeature('badge', [scored], 10).matches[0]?.basis).toBe('name-word');
  });

  it('keeps an acronym whole rather than one word or nine', () => {
    const parser = entity({ id: 'h1', name: 'HTTPServer' });
    expect(findFeature('http', [parser], 10).matches[0]?.basis).toBe('name-word');
    expect(findFeature('server', [parser], 10).matches[0]?.basis).toBe('name-word');
  });
});

describe('the bases, and the order they rank in', () => {
  it('calls "art" in CartBadge a fragment and ranks it under a word match', () => {
    const cartBadge = entity({ id: 'c1', name: 'CartBadge' });
    const artBoard = entity({ id: 'c2', name: 'ArtBoard' });
    // Fragment first in the input, so an unsorted answer fails here.
    expect(shape(findFeature('art', [cartBadge, artBoard], 10).matches)).toEqual([
      ['c2', 'name-word'],
      ['c1', 'name-part'],
    ]);
  });

  it('ranks exact name, word, fragment, text word, text fragment in that order', () => {
    const entities = [
      entity({ id: 'text-part', name: 'Gadget', text: 'src/checkoutish.ts' }),
      entity({ id: 'name-part', name: 'Precheckout' }),
      entity({ id: 'text-word', name: 'Widget', text: 'src/checkout/Total.tsx' }),
      entity({ id: 'name-exact', name: 'Checkout' }),
      entity({ id: 'name-word', name: 'CheckoutPanel' }),
    ];
    expect(shape(findFeature('checkout', entities, 10).matches)).toEqual([
      ['name-exact', 'name-exact'],
      ['name-word', 'name-word'],
      ['name-part', 'name-part'],
      ['text-word', 'text-word'],
      ['text-part', 'text-part'],
    ]);
  });

  it('reports the strongest basis any one term reached, and the terms it answered for', () => {
    // `badge` is a word of the name; `total` only appears in the path. The
    // match is a name-word match that accounted for both.
    const badge = entity({ id: 'b1', name: 'CartBadge', text: 'src/cart/total.tsx' });
    expect(findFeature('badge total', [badge], 10).matches).toEqual([
      { entity: badge, terms: ['badge', 'total'], basis: 'name-word' },
    ]);
  });

  it('prefers a fragment of the name over a word of the text', () => {
    // What a thing is called is a stronger claim about it than what happens to
    // be in the path it lives at, so the weakest name basis still outranks the
    // strongest text one. Checking the text first would report `text-word`.
    const both = entity({ id: 'p1', name: 'Precheckout', text: 'src/checkout/Total.tsx' });
    expect(findFeature('checkout', [both], 10).matches).toEqual([
      { entity: both, terms: ['checkout'], basis: 'name-part' },
    ]);
  });

  it('gives the terms in the order the description gave them', () => {
    const badge = entity({ id: 'b1', name: 'CartBadge' });
    expect(findFeature('badge cart', [badge], 10).matches[0]?.terms).toEqual([
      'badge',
      'cart',
    ]);
  });
});

describe('ranking below the basis', () => {
  it('prefers the entity that accounted for more of the description', () => {
    // BadgeRow sorts first alphabetically, so only coverage can put CartBadge
    // above it.
    const entities = [
      entity({ id: 'row', name: 'BadgeRow' }),
      entity({ id: 'badge', name: 'CartBadge' }),
    ];
    const matches = findFeature('cart badge count', entities, 10).matches;
    expect(shape(matches)).toEqual([
      ['badge', 'name-word'],
      ['row', 'name-word'],
    ]);
    expect(matches[0]?.terms).toEqual(['cart', 'badge']);
    expect(matches[1]?.terms).toEqual(['badge']);
  });

  it('breaks a remaining tie on the name, so two runs agree', () => {
    // The ids run the other way from the names on purpose: ordering by id, or
    // by the order they were handed over, both put ZCart first.
    const entities = [entity({ id: 'e1', name: 'ZCart' }), entity({ id: 'e2', name: 'ACart' })];
    const first = findFeature('cart', entities, 10);
    const second = findFeature('cart', entities, 10);
    expect(shape(first.matches)).toEqual([
      ['e2', 'name-word'],
      ['e1', 'name-word'],
    ]);
    expect(second).toEqual(first);
  });
});

describe('the budget', () => {
  const entities = [
    entity({ id: 'a', name: 'ACart' }),
    entity({ id: 'b', name: 'BCart' }),
    entity({ id: 'c', name: 'CCart' }),
  ];

  it('counts what it could not return rather than dropping it silently', () => {
    const query = findFeature('cart', entities, 2);
    expect(shape(query.matches)).toEqual([
      ['a', 'name-word'],
      ['b', 'name-word'],
    ]);
    expect(query.more).toBe(1);
  });

  it('omits `more` when everything fit', () => {
    const query = findFeature('cart', entities, 10);
    expect(query.matches).toHaveLength(3);
    expect(query).not.toHaveProperty('more');
  });

  it('returns nothing but the count when the limit is zero or less', () => {
    expect(findFeature('cart', entities, 0)).toMatchObject({ matches: [], more: 3 });
    expect(findFeature('cart', entities, -5)).toMatchObject({ matches: [], more: 3 });
  });
});

describe('what must never match', () => {
  it('does not let a nameless entity match everything', () => {
    const nameless = entity({ id: 'n1', name: '' });
    expect(findFeature('cart', [nameless], 10).matches).toEqual([]);
    expect(findFeature('anything at all here', [nameless], 10).matches).toEqual([]);
  });

  it('still matches a nameless entity on its text', () => {
    // The empty-name guard must refuse the name, not the whole entity.
    const nameless = entity({ id: 'n1', name: '', text: 'src/cart/badge.tsx' });
    expect(findFeature('cart', [nameless], 10).matches[0]?.basis).toBe('text-word');
  });

  it('returns no matches when there are no entities', () => {
    const query = findFeature('cart', [], 10);
    expect(query).toEqual({ terms: ['cart'], dropped: [], matches: [] });
  });

  it('does not match an entity that shares none of the terms', () => {
    expect(findFeature('cart', [entity({ id: 'x', name: 'InvoiceTable' })], 10).matches).toEqual(
      [],
    );
  });
});
