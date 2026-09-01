/**
 * Finding the named things in the graph whose *words* are the description's
 * words.
 *
 * ## This is lexical matching, and calling it anything else is the bug
 *
 * A description arrives as English — "the checkout flow", "cart badge" — and
 * what this module does with it is: lower-case it, cut it into terms, and look
 * for those terms in the names and paths of entities the graph already holds.
 * That is the whole mechanism. Nothing here reads the description's meaning,
 * knows what checkout is, or has any model of the app. The available data is
 * names, URLs, repo paths and flow labels; names are what can be matched, so
 * names are what is matched.
 *
 * Two consequences a caller has to be handed rather than discover:
 *
 *   - **A name that contains the word wins whether or not it is relevant.** A
 *     component called `Cart` matches "cart" — the shopping cart, a cart in a
 *     logistics dashboard, a `CartesianGrid` truncated by someone in a hurry.
 *     The match says the word is there. It does not say the thing is related.
 *   - **A feature whose code uses different words is not found at all.** If the
 *     checkout is implemented as `PurchaseFlow` and `/api/orders`, "the checkout
 *     flow" returns nothing, and nothing is not evidence that the feature is
 *     absent. Silence here means the vocabulary did not overlap.
 *
 * So this is not understanding, and a caller that presents it as understanding
 * is lying on its behalf. What it *is* worth is real, and it is why the module
 * exists rather than a grep: the answer is a set of **named entities in the
 * graph** — this component, this endpoint, this recorded flow — each of which
 * the caller can then expand through the edges the graph already has, into the
 * things that never carried the word at all. Lexical matching is the entry
 * point; the graph is what makes the entry point worth having. A grep gives
 * line hits and stops there.
 *
 * ## Identifier splitting is the one thing better than a substring scan
 *
 * `CartBadge` is not the string "cart" plus noise — it is two words, and a
 * reader knows that because of the capital B. Splitting names on camelCase and
 * PascalCase boundaries, and on `-`, `_`, `/`, `.` and whitespace, is what lets
 * "cart" match `CartBadge` as a *word* and "invoices" match `/api/v1/invoices`
 * as a *word*, and it is what separates those from "art", which is in
 * `CartBadge` only as a fragment of one. Without the split every match is a
 * substring match and `Chart`, `Cartesian` and `Cart` are indistinguishable.
 *
 * ## Named bases, never scores
 *
 * A match carries the *reason* it matched, not a number. `0.72` cannot be
 * argued with; *the term equals one of the name's words* can — a reader who
 * knows the app can look at `name-part` on `CartBadge` for "art" and say "that
 * is a fragment, ignore it", and no float ever invited that. Ranking is the
 * order of those reasons, weakest claim last:
 *
 *   - `name-exact` — the name, split into words, *is* the description's terms.
 *   - `name-word`  — a term equals one of the name's words.
 *   - `name-part`  — a term appears inside the name but is not one of its
 *                    words. The weakest thing a name can say.
 *   - `text-word`  — a term equals a word of the entity's secondary text (a
 *                    source path, a flow's step actions).
 *   - `text-part`  — a term appears inside that text as a fragment.
 *
 * A match reports the strongest basis any of its terms reached, and the terms
 * it accounted for, so the caller can see *what* of the description this entity
 * answered for and decide whether one fragment of one word is enough.
 *
 * Ties break on how much of the description an entity covered, then on the
 * entity's name, so two runs over one graph agree.
 *
 * ## Dropped terms are reported, never hidden
 *
 * "how does the checkout page work" is, after the stop list, "checkout". If the
 * whole description is common words there are no terms at all, and a caller
 * that cannot tell *your description narrowed nothing* from *nothing in the
 * graph matched* will report the second when the truth is the first. So the
 * dropped terms come back in the answer.
 *
 * Pure — no DOM, no Chrome, no clock, no randomness.
 */

export type EntityKind = 'component' | 'endpoint' | 'file' | 'flow' | 'store' | 'stateKey';

/** One named thing the graph holds, reduced to the text it can be found by. */
export interface NavigatorEntity {
  kind: EntityKind;
  id: string;
  /** What it is called: a display name, a URL, a repo-relative path, a flow name. */
  name: string;
  /** Further text worth matching — a component's source path, a flow's step actions. */
  text?: string;
}

/** Why one entity matched, named rather than scored. */
export type MatchBasis = 'name-exact' | 'name-word' | 'name-part' | 'text-word' | 'text-part';

export interface NavigatorMatch {
  entity: NavigatorEntity;
  /** The description's terms this entity accounted for, in the order they were given. */
  terms: string[];
  /** The strongest basis any of those terms matched on. */
  basis: MatchBasis;
}

export interface NavigatorQuery {
  /** What the description was reduced to. */
  terms: string[];
  /** Terms dropped as too common to narrow anything. Reported, never hidden. */
  dropped: string[];
  matches: NavigatorMatch[];
  /** Matches found beyond `limit`. Absent when none. */
  more?: number;
}

/**
 * Words that appear in a description of anything and so narrow nothing.
 *
 * Deliberately small and written out rather than derived from a corpus: every
 * word here is one a caller can be shown in `dropped` and immediately agree
 * with. A longer list starts eating words that are somebody's component name.
 */
const STOP_WORDS: ReadonlySet<string> = new Set([
  'the', 'a', 'an', 'of', 'for', 'in', 'on', 'to', 'and', 'or', 'is', 'it',
  'that', 'this', 'my', 'our', 'page', 'screen', 'app', 'feature', 'flow',
  'thing', 'stuff', 'does', 'do', 'how', 'what', 'where', 'why', 'when',
  'works', 'work',
]);

/** A single character is inside almost every name and narrows nothing. */
const MIN_TERM_LENGTH = 2;

/** Strongest claim first. Index in this list *is* the rank. */
const BASIS_STRENGTH: readonly MatchBasis[] = [
  'name-exact',
  'name-word',
  'name-part',
  'text-word',
  'text-part',
];

function basisRank(basis: MatchBasis): number {
  return BASIS_STRENGTH.indexOf(basis);
}

/**
 * A name cut the way code names are written.
 *
 * The two replacements are the camel/Pascal boundaries: `cartBadge` and
 * `CartBadge` both become `Cart Badge`, and `HTTPServer` becomes `HTTP Server`
 * rather than one word or nine. Everything that is not a letter or a digit is
 * then a separator, which is what turns `/api/v1/invoices` into three words and
 * `use-cart.ts` into two plus an extension.
 *
 * Non-ASCII letters are separators here. That is a real limitation — an
 * accented identifier is cut apart — and it is the same rule `readQuery` uses,
 * so the two sides at least agree about what a word is.
 */
function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

/**
 * The terms a description reduces to, and the ones dropped as too common.
 *
 * Repeats collapse: "cart cart badge" is two terms, not three, because the
 * second `cart` cannot be accounted for separately and counting it would let a
 * caller inflate an entity's coverage by saying a word twice.
 */
export function readQuery(description: string): { terms: string[]; dropped: string[] } {
  const terms: string[] = [];
  const dropped: string[] = [];
  const seen = new Set<string>();

  for (const token of description.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!token || seen.has(token)) continue;
    seen.add(token);
    if (token.length < MIN_TERM_LENGTH || STOP_WORDS.has(token)) dropped.push(token);
    else terms.push(token);
  }

  return { terms, dropped };
}

/**
 * The strongest basis one term reaches against one entity, or nothing.
 *
 * Name before text throughout: what a thing is called is a stronger claim about
 * it than what happens to appear in the path it lives at, and a term that is a
 * fragment of the name is still reported as a name claim rather than promoted
 * to a word claim about the text.
 */
function termBasis(
  term: string,
  lowerName: string,
  nameWords: ReadonlySet<string>,
  lowerText: string,
  textWords: ReadonlySet<string>,
): MatchBasis | undefined {
  // An empty name has no words and contains nothing; `''.includes(term)` is
  // false for every term, and terms are never empty, so a nameless entity
  // matches on nothing rather than on everything.
  if (nameWords.has(term)) return 'name-word';
  if (lowerName.includes(term)) return 'name-part';
  if (textWords.has(term)) return 'text-word';
  if (lowerText.includes(term)) return 'text-part';
  return undefined;
}

function matchEntity(
  entity: NavigatorEntity,
  terms: readonly string[],
): NavigatorMatch | undefined {
  const name = entity.name ?? '';
  const text = entity.text ?? '';
  const nameWordList = words(name);
  const nameWords = new Set(nameWordList);
  const textWords = new Set(words(text));
  const lowerName = name.toLowerCase();
  const lowerText = text.toLowerCase();

  const matched: string[] = [];
  let best: MatchBasis | undefined;

  for (const term of terms) {
    const basis = termBasis(term, lowerName, nameWords, lowerText, textWords);
    if (!basis) continue;
    matched.push(term);
    if (!best || basisRank(basis) < basisRank(best)) best = basis;
  }

  if (!best) return undefined;

  // The name, split into words, is exactly what was asked for. Checked against
  // the split rather than the raw string so `CartBadge` is an exact answer to
  // "cart badge" — which is how a person would name it and how a person would
  // ask for it.
  const exact = nameWordList.length > 0 && nameWordList.join(' ') === terms.join(' ');

  return { entity, terms: matched, basis: exact ? 'name-exact' : best };
}

/**
 * Entities whose names or text carry the description's terms, best basis first.
 *
 * Then by how much of the description the entity accounted for — an entity that
 * answers for two of the three terms is a better lead than one answering for a
 * single term on the same basis — then by name, and finally by id so that two
 * entities sharing a name still land in one fixed order.
 */
export function findFeature(
  description: string,
  entities: readonly NavigatorEntity[],
  limit: number,
): NavigatorQuery {
  const { terms, dropped } = readQuery(description);

  // No surviving terms is an answer, not a failure: the caller reads `dropped`
  // and asks for a description with a word in it that is about this app.
  if (!terms.length) return { terms, dropped, matches: [] };

  const ranked: NavigatorMatch[] = [];
  for (const entity of entities) {
    const match = matchEntity(entity, terms);
    if (match) ranked.push(match);
  }

  ranked.sort((a, b) => {
    const byBasis = basisRank(a.basis) - basisRank(b.basis);
    if (byBasis !== 0) return byBasis;
    if (a.terms.length !== b.terms.length) return b.terms.length - a.terms.length;
    if (a.entity.name !== b.entity.name) return a.entity.name < b.entity.name ? -1 : 1;
    return a.entity.id < b.entity.id ? -1 : a.entity.id > b.entity.id ? 1 : 0;
  });

  const cap = Math.max(0, limit);
  const kept = ranked.slice(0, cap);
  const over = ranked.length - kept.length;

  return { terms, dropped, matches: kept, ...(over > 0 ? { more: over } : {}) };
}
