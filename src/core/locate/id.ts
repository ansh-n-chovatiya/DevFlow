/**
 * Stable identity for a component, so the same one clicked forty times is
 * resolved once.
 *
 * The id is a hash of the display name and the head of the component's compiled
 * source. Both matter: source alone collides across components a bundler
 * emitted identically, and the name alone is worthless on a minified build
 * where every component is called `e`.
 *
 * Pure — no DOM, no Chrome.
 */

/** How much of the function source feeds the hash. Matches the head needle. */
/*
 * Tier 3 — deliberately not configurable.
 *
 * These four are component *identity*. Every id stored in every saved flow was
 * minted with these exact values, so changing one does not re-key anything — it
 * silently stops the new ids matching the old ones, and a flow recorded
 * yesterday quietly loses its component table. No error, no version bump, just
 * a table that no longer joins.
 */
const HASH_SOURCE_LEN = 200;

const FNV_PRIME = 0x01000193;
const SEED_A = 0x811c9dc5;
/** A second, unrelated seed. Two 32-bit passes give 40 usable bits (see below). */
const SEED_B = 0x7f4a7c15;

/** FNV-1a, 32-bit, seeded. */
export function fnv1a(text: string, seed: number): number {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A 40-bit id, as 10 hex characters.
 *
 * 32 bits would be the obvious choice and is *probably* fine, but a collision
 * here is not a cosmetic bug — two different components would share one
 * resolution and the flow would name the wrong file, which is worse than naming
 * none. A second seeded pass costs one more sweep of 200 characters and drops
 * the odds across a whole flow from roughly one in a million to one in a
 * hundred million.
 */
export function componentId(name: string, fnSource: string): string {
  const material = `${name}|${fnSource.slice(0, HASH_SOURCE_LEN)}`;
  const a = fnv1a(material, SEED_A);
  const b = fnv1a(material, SEED_B);
  return a.toString(16).padStart(8, '0') + (b & 0xff).toString(16).padStart(2, '0');
}

/**
 * The names the fiber walker invents when a fiber names nothing of its own.
 *
 * Kept here, next to the hashing, because they are the two strings that must
 * never be treated as an identity: `getDisplayName` hands the same one back for
 * every unnamed fiber on the page, so hashing it produces one id shared by
 * components that have nothing to do with each other. `fiber.ts` imports these
 * rather than repeating the literals, so the two cannot drift apart.
 */
export const ANONYMOUS_NAME = 'Anonymous';
export const UNSETTLED_LAZY_NAME = 'Lazy(loading…)';

/** Prefix for an id that stands for *some* component rather than a particular one. */
const PLACEHOLDER_PREFIX = 'n_';

/** True for a name that identifies nothing — see `ANONYMOUS_NAME`. */
export function isPlaceholderName(name: string): boolean {
  return name === ANONYMOUS_NAME || name === UNSETTLED_LAZY_NAME;
}

/**
 * Id for a component whose source could not be read at all — an unsettled lazy
 * component, or a native function. Name-only, and marked so it is never mistaken
 * for something the resolver could have found and failed to.
 *
 * A fallback name gets a *second* mark, `n_`, because a name-only id is only an
 * identity while the name is one. Two unnamed components hash to the same
 * `n_…`, so whatever the first of them happened to know — a `_debugSource`
 * pointing at the file its JSX was written in — would be handed to every later
 * one as fact. Minting a fresh id per sighting instead would be worse: the table
 * is keyed by id, so a flow that clicked one lazy modal forty times would file
 * forty rows and blow the per-flow cap. So the id stays shared and is instead
 * flagged as one that must never carry a path: `table.ts` refuses to give it
 * one, and `owner.ts` refuses to attribute a step to it.
 */
export function nameOnlyId(name: string): string {
  const digest = fnv1a(name, SEED_A).toString(16).padStart(8, '0');
  return `${isPlaceholderName(name) ? PLACEHOLDER_PREFIX : 'n'}${digest}`;
}

/** True for an id produced by `nameOnlyId` — there is no needle to resolve. */
export function isNameOnly(id: string): boolean {
  return id.startsWith('n');
}

/**
 * True for a name-only id built from a fallback name, which several unrelated
 * components share. `_` is safe as a marker because the rest of the id is hex.
 */
export function isPlaceholderId(id: string): boolean {
  return id.startsWith(PLACEHOLDER_PREFIX);
}
