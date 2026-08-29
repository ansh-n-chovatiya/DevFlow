import { describe, expect, it } from 'vitest';
import { pickEnclosing, pickOwner } from '../src/core/react/owner.js';
import {
  classifyComponent,
  isDependencyPath,
  isSharedPrimitivePath,
} from '../src/core/react/classify.js';
import type { ComponentSource } from '../src/shared/types.js';

function resolved(name: string, source: string): ComponentSource {
  return {
    name,
    status: 'resolved',
    via: 'bundle-search',
    source,
    line: 10,
    ...(isDependencyPath(source) ? { dependency: true } : {}),
  };
}

function pending(name: string): ComponentSource {
  return { name, status: 'pending' };
}

describe('pickOwner', () => {
  it('takes the innermost component resolved outside node_modules', () => {
    // Chain is stored outermost first, as it is on the step.
    const table = {
      app: resolved('App', 'src/App.tsx'),
      page: resolved('ProductPage', 'src/routes/ProductPage.tsx'),
      button: resolved('ButtonBase', 'node_modules/@mui/material/ButtonBase.js'),
    };

    expect(pickOwner(['app', 'page', 'button'], table)).toBe('page');
  });

  it('prefers an unresolved component of the user over a resolved dependency', () => {
    // The whole point of the tier order: a path inside node_modules is proof
    // this is not the user's code, and proof beats a resolved-looking answer.
    const table = {
      cart: pending('AddToCartButton'),
      base: resolved('ButtonBase', 'node_modules/@mui/material/ButtonBase.js'),
    };

    expect(pickOwner(['cart', 'base'], table)).toBe('cart');
  });

  it('skips plumbing recognised by name when nothing is resolved', () => {
    const table = {
      router: pending('BrowserRouter'),
      provider: pending('QueryClientProvider'),
      cart: pending('Cart'),
      primitive: pending('Primitive.div'),
    };

    expect(pickOwner(['router', 'provider', 'cart', 'primitive'], table)).toBe('cart');
  });

  it('falls back to the innermost named component rather than nothing', () => {
    const table = {
      router: pending('BrowserRouter'),
      theme: pending('ThemeProvider'),
    };

    // Everything is plumbing, but a step saying "ThemeProvider" still tells the
    // reader more than a step saying nothing at all.
    expect(pickOwner(['router', 'theme'], table)).toBe('theme');
  });

  it('is null when the chain is empty or nothing in it is in the table', () => {
    expect(pickOwner([], {})).toBeNull();
    expect(pickOwner(['gone'], { other: pending('Cart') })).toBeNull();
  });

  it('ignores ids the table no longer has, without losing the rest', () => {
    const table = { cart: resolved('Cart', 'src/Cart.tsx') };
    expect(pickOwner(['pruned', 'cart', 'alsoPruned'], table)).toBe('cart');
  });

  it('does not treat a resolved dependency as plumbing twice over', () => {
    // A dependency that is *not* recognised by name still loses tier 1 on its
    // path, but wins tier 2 — it is the nearest thing to an answer left.
    const table = { widget: resolved('FancyWidget', 'node_modules/fancy/Widget.js') };
    expect(pickOwner(['widget'], table)).toBe('widget');
  });
});

describe('classifyComponent', () => {
  it('lets the name decide before the path', () => {
    // `<Switch>` written in the app's own router file reports the app's file.
    // Trusting that path would exempt every library component an app renders.
    expect(classifyComponent('Switch', 'src/routes/AppRouter.tsx')).toBe('routing');
  });

  it('reads a node_modules path as a dependency when the name says nothing', () => {
    expect(classifyComponent('Widget', 'node_modules/fancy/Widget.js')).toBe('dependency');
  });

  it('never hides an unrecognised component', () => {
    expect(classifyComponent('AddToCartButton', 'src/cart/AddToCartButton.tsx')).toBe('unknown');
    expect(classifyComponent('AddToCartButton')).toBe('unknown');
  });

  it('recognises the wrapper and primitive shapes by pattern', () => {
    expect(classifyComponent('Lazy(Modal)')).toBe('react');
    expect(classifyComponent('Primitive.div')).toBe('styling');
    expect(classifyComponent('CartContext.Provider')).toBe('providers');
  });
});

/**
 * The enclosing feature component.
 *
 * `pickOwner` says where the click landed and is usually right about it; on an
 * app with a shared UI kit "right" is `Button`, which is true and tells the
 * reader nothing. This adds the component that rendered it rather than replacing
 * the answer, so a wrong guess here costs an extra name and never a correct one.
 */
describe('pickEnclosing', () => {
  it('names the feature component that rendered a shared primitive', () => {
    const table = {
      page: resolved('CheckoutPage', 'src/routes/CheckoutPage.tsx'),
      checkout: resolved('CheckoutButton', 'src/components/checkout/CheckoutButton.tsx'),
      button: resolved('Button', 'src/components/ui/Button.tsx'),
    };
    const chain = ['page', 'checkout', 'button'];

    // The owner is still the primitive: that is where the click actually landed.
    expect(pickOwner(chain, table)).toBe('button');
    expect(pickEnclosing(chain, table, 'button')).toBe('checkout');
  });

  it('says nothing when the owner already names something specific', () => {
    // `· in ProductPage` on every step of every flow is true and worth reading
    // none of the time. The addition is for the case where the owner is a
    // primitive, and silent everywhere else.
    const table = {
      page: resolved('CheckoutPage', 'src/routes/CheckoutPage.tsx'),
      checkout: resolved('CheckoutButton', 'src/components/checkout/CheckoutButton.tsx'),
    };

    expect(pickEnclosing(['page', 'checkout'], table, 'checkout')).toBeNull();
  });

  it('says nothing when the owner has no resolved path to judge', () => {
    const table = { button: pending('Button'), page: resolved('CartPage', 'src/CartPage.tsx') };
    expect(pickEnclosing(['page', 'button'], table, 'button')).toBeNull();
  });

  it('never returns the owner itself', () => {
    const table = { button: resolved('Button', 'src/components/ui/Button.tsx') };
    expect(pickEnclosing(['button'], table, 'button')).toBeNull();
  });

  it('skips dependencies, plumbing and anything still unresolved', () => {
    const table = {
      provider: resolved('QueryClientProvider', 'src/app/providers.tsx'),
      mui: resolved('ButtonBase', 'node_modules/@mui/material/ButtonBase.js'),
      unknown: pending('MaybeSomething'),
      button: resolved('Button', 'src/components/ui/Button.tsx'),
    };

    // Nothing outside the owner qualifies: the provider is plumbing by name, the
    // MUI component is a dependency, and the pending one has no evidence yet.
    expect(pickEnclosing(['provider', 'mui', 'unknown', 'button'], table, 'button')).toBeNull();
  });

  it('changes nothing for an app with no shared kit, which is the safety property', () => {
    // Every candidate demoted equally is every candidate not demoted at all.
    const table = {
      app: resolved('App', 'src/ui/App.tsx'),
      page: resolved('CartPage', 'src/ui/CartPage.tsx'),
    };

    expect(pickOwner(['app', 'page'], table)).toBe('page');
    expect(pickEnclosing(['app', 'page'], table, 'page')).toBeNull();
  });

  it('has nothing to add when there is no owner', () => {
    expect(pickEnclosing(['a'], {}, null)).toBeNull();
  });
});

describe('isSharedPrimitivePath', () => {
  it('recognises the layouts the ecosystem actually settled on', () => {
    for (const path of [
      'src/components/ui/Button.tsx',
      'components/ui/button.tsx',
      'src/ui/Input.tsx',
      'packages/design-system/Card.tsx',
      'app/primitives/Dialog.tsx',
    ]) {
      expect(isSharedPrimitivePath(path)).toBe(true);
    }
  });

  it('leaves ordinary feature paths alone', () => {
    for (const path of [
      'src/components/checkout/CheckoutButton.tsx',
      'src/routes/CartPage.tsx',
      'src/features/cart/Cart.tsx',
      // `ui` as part of a word, not a folder of its own.
      'src/build/Guide.tsx',
    ]) {
      expect(isSharedPrimitivePath(path)).toBe(false);
    }
  });
});
