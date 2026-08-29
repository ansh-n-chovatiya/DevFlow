/**
 * Choosing which component in a chain a click actually belongs to.
 *
 * The nearest component fiber is usually not the one anybody means. Clicking a
 * MUI button lands on `ButtonBase`; clicking a Radix item lands on
 * `Primitive.div`. The useful answer is the nearest component the *user owns*.
 *
 * Two signals say so, and they arrive at different times: the name is known at
 * capture and is a heuristic that says nothing on a minified build, while a
 * resolved path inside `node_modules` is definitive and only exists after the
 * resolver has run. So this is a pure function over the finished table, called
 * at export time — storing an owner on the step would freeze a decision made
 * before the evidence for it existed.
 *
 * Pure — no DOM, no Chrome.
 */

import type { ComponentSource } from '../../shared/types.js';
import { classifyComponent, isSharedPrimitivePath } from './classify.js';
import { isPlaceholderId } from './id.js';

/**
 * The component id a step should be attributed to, or null.
 *
 * `chain` is outermost first, as stored, so this walks it backwards: the
 * innermost component that qualifies wins at every tier.
 *
 * Tiers, in order:
 *
 *   1. Resolved to a file outside `node_modules` — the real answer, and the only
 *      one backed by evidence rather than by a name.
 *   2. Not recognisable as plumbing by name. Weaker, but it is all there is
 *      before the resolver has finished, and all there is on a bundle with no
 *      source maps.
 *   3. Anything named at all, so a chain of nothing but providers still says
 *      *something* about where the click landed.
 *   4. Null. Rendering nothing beats rendering something wrong.
 *
 * A placeholder id — one shared by every component the fiber walk could not
 * name — is barred from the first two tiers however it looks. It cannot be the
 * answer to "which component is this", because it is not one component; and it
 * used to win tier 1 outright whenever some earlier step had handed it a
 * `_debugSource`, beating the real `CheckoutForm` further out in the chain and
 * printing a file the click never went near. It is still allowed the last tier,
 * where a name is all that is being claimed.
 */
export function pickOwner(
  chain: string[],
  components: Record<string, ComponentSource>,
): string | null {
  let notPlumbing: string | null = null;
  let anyNamed: string | null = null;

  for (let i = chain.length - 1; i >= 0; i--) {
    const id = chain[i];
    const component = components[id];
    if (!component) continue;

    // Kept out of the evidence tiers, not out of the chain: an old flow resolved
    // before this rule existed still carries such an entry, and it must lose
    // here rather than be trusted for being already written down.
    const placeholder = isPlaceholderId(id);

    if (!placeholder && component.status === 'resolved' && component.dependency !== true) return id;

    if (!placeholder && notPlumbing === null) {
      const category = classifyComponent(component.name, component.source);
      if (category === 'unknown') notPlumbing = id;
    }

    if (anyNamed === null && component.name) anyNamed = id;
  }

  return notPlumbing ?? anyNamed;
}

/**
 * The feature component the owner sits inside, or null.
 *
 * `pickOwner` answers "where did this click land", and on an app with a shared
 * UI kit the honest answer is often `Button` — the click really did land in
 * `src/components/ui/Button.tsx`. It is just not the answer anybody asked for:
 * what makes the flow useful is that the button was the one in `CheckoutButton`.
 *
 * So this is additive rather than a correction. The owner keeps naming the
 * component the evidence points at, and this names the nearest one further out
 * that is the user's own code and does not live in their primitives folder.
 * Both files reach the reader, and neither judgement has to be right for the
 * other to be useful — which is the property that made changing `pickOwner`
 * itself the wrong move: demoting `Button` in `App` → `Button` would have
 * traded a precise answer for a vaguer one.
 *
 * Only when the owner is itself a shared primitive, which is the whole of the
 * problem being solved. Reporting the nearest enclosing component in general
 * would put `· in App` or `· in ProductPage` on nearly every step of nearly
 * every flow — true each time, worth reading none of them. Silence is the right
 * answer whenever the owner already names something specific.
 */
export function pickEnclosing(
  chain: string[],
  components: Record<string, ComponentSource>,
  owner: string | null,
): string | null {
  if (!owner) return null;

  const source = components[owner]?.source;
  if (!source || !isSharedPrimitivePath(source)) return null;

  const ownerAt = chain.lastIndexOf(owner);
  if (ownerAt < 0) return null;

  // Strictly outside the owner: the same component cannot enclose itself, and a
  // second copy of it further out says nothing new.
  for (let i = ownerAt - 1; i >= 0; i--) {
    const id = chain[i];
    if (id === owner) continue;
    // Same bar as `pickOwner`: a shared id names no particular component, so it
    // cannot be the feature component that rendered this one either.
    if (isPlaceholderId(id)) continue;

    const component = components[id];
    if (!component) continue;
    if (component.status !== 'resolved' || component.dependency === true) continue;
    if (!component.source || isSharedPrimitivePath(component.source)) continue;
    if (classifyComponent(component.name, component.source) !== 'unknown') continue;

    return id;
  }

  return null;
}
