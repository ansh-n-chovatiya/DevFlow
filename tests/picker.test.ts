// @vitest-environment jsdom
/**
 * The two things the picker does that the recorder must never do.
 *
 * `src/injected/picker.ts` carries its own `getComponentFn` and its own
 * DOM-node walk, which looks like duplication of `core/react/fiber.ts` until you
 * ask what the difference is. It is D2: the picker resolves a `React.lazy` and
 * the recorder does not, because `_init()` can start a dynamic `import()` — so a
 * passive recorder that forced would change what the page loads and stop
 * describing the session it claims to describe.
 *
 * Getting that backwards produces no error and no failing assertion anywhere
 * else. The page simply fetches a chunk it would not have fetched, the flow
 * records the request as if the user had caused it, and nobody ever knows. So it
 * is asserted here from both ends: behaviourally, that `force: false` does not
 * call `_init`, and structurally, that no call site in `src/injected/` can omit
 * the option.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PAGE_GLOBALS } from '../src/shared/constants.js';
import type { Fiber } from '../src/core/react/fiber.js';
import { getAllDOMNodes, getComponentFn, pickedEntry } from '../src/injected/picker.js';

/*
 * Assembled rather than written out, so that the grep Wave 3 runs over the tree
 * finds nothing at all — including in the test that asserts it finds nothing.
 */
const BANNED_PREFIX = new RegExp(['__', 'RST', '_'].join('') + '|' + ['__', 'rst', '-'].join(''));

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string) => readFileSync(resolve(root, file), 'utf8');

/** A fiber with only the fields the walk reads. */
function fiber(partial: Partial<Fiber>): Fiber {
  return {
    type: null,
    return: null,
    child: null,
    sibling: null,
    stateNode: null,
    ...partial,
  };
}

describe('resolving a lazy component', () => {
  /** A `React.lazy` whose import has not settled, and which counts its `_init`s. */
  function unsettledLazy() {
    const Loaded = () => null;
    let inits = 0;
    const type = {
      _payload: { _status: 0 },
      _init: () => {
        inits++;
        return Loaded;
      },
    };
    return { type, Loaded, initCount: () => inits };
  }

  it('is refused without force, and does not call _init', () => {
    const lazy = unsettledLazy();

    expect(getComponentFn(fiber({ type: lazy.type }), { force: false })).toBeNull();
    // The whole point. `_init` is what starts the import.
    expect(lazy.initCount()).toBe(0);
  });

  it('happens with force, because the user asked for this component', () => {
    const lazy = unsettledLazy();

    expect(getComponentFn(fiber({ type: lazy.type }), { force: true })).toBe(lazy.Loaded);
    expect(lazy.initCount()).toBe(1);
  });

  it('reads a settled payload without forcing anything', () => {
    const Loaded = () => null;
    const type = { _payload: { _status: 1, _result: Loaded } };

    expect(getComponentFn(fiber({ type }), { force: false })).toBe(Loaded);
  });

  it('unwraps a module namespace, which is what a dynamic import resolves to', () => {
    const Loaded = () => null;
    const type = { _payload: { _status: 1, _result: { default: Loaded } } };

    expect(getComponentFn(fiber({ type }), { force: true })).toBe(Loaded);
  });

  it('survives an _init that throws, which is a rejected import', () => {
    const type = {
      _payload: { _status: 0 },
      _init: () => {
        throw new Error('chunk load failed');
      },
    };

    expect(getComponentFn(fiber({ type }), { force: true })).toBeNull();
  });
});

describe('the force option itself', () => {
  const picker = read('src/injected/picker.ts');
  const agent = read('src/injected/agent.ts');

  it('is required at every call site in the injected agent', () => {
    // A bare `getComponentFn(f)` compiles only if the option has a default, and
    // a default is how the recorder ends up forcing by accident.
    const calls = picker
      .split('\n')
      .filter((line) => line.includes('getComponentFn(') && !line.includes('export function'));

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call).toMatch(/\{\s*force:/);
  });

  it('is true only where the user asked for a component', () => {
    // The recorder's path goes through `collectChain`, which does not force.
    expect(agent).not.toContain('force: true');
    // Ancestors and siblings of a pick, and nothing else.
    expect(picker.match(/force: true/g)).toHaveLength(2);
  });
});

describe('the nodes a component occupies', () => {
  it('is the single host node when the fiber has one', () => {
    const node = document.createElement('div');
    expect(getAllDOMNodes(fiber({ stateNode: node }))).toEqual([node]);
  });

  it('is every sibling when the component returned a fragment', () => {
    const first = document.createElement('span');
    const second = document.createElement('span');

    const second_ = fiber({ stateNode: second });
    const first_ = fiber({ stateNode: first, sibling: second_ });

    expect(getAllDOMNodes(fiber({ child: first_ }))).toEqual([first, second]);
  });

  it('does not descend into a host node it has already found', () => {
    // Everything under a <div> is inside the box that <div> draws, so walking
    // into it would cost a subtree walk to widen the union by nothing.
    const outer = document.createElement('div');
    const inner = document.createElement('em');

    const inner_ = fiber({ stateNode: inner });
    const outer_ = fiber({ stateNode: outer, child: inner_ });

    expect(getAllDOMNodes(fiber({ child: outer_ }))).toEqual([outer]);
  });
});

describe('a question about a pick that is not there', () => {
  /*
   * The question arrives over `window.postMessage`, which any script on the page
   * can post to. A bad `group` used to index `undefined` and throw out of the
   * agent's message listener — which is also the recorder's control channel, so
   * one forged message would have stopped a recording responding to Stop.
   */
  it('is answered null rather than thrown', () => {
    expect(pickedEntry('ancestry', 0)).toBeNull();
    expect(pickedEntry('sibling', 3)).toBeNull();
    expect(pickedEntry('nonsense' as 'ancestry', 0)).toBeNull();
  });

  it('is answered null for an index past the end of a real pick', () => {
    (window as unknown as Record<string, unknown>)[PAGE_GLOBALS.picked] = {
      ancestry: [{ name: 'Cart', fn: () => null, fiber: fiber({}), nodes: [] }],
      sibling: [],
    };

    expect(pickedEntry('ancestry', 0)?.name).toBe('Cart');
    expect(pickedEntry('ancestry', 9)).toBeNull();
    expect(pickedEntry('sibling', 0)).toBeNull();
  });
});

describe('the page globals the agent owns', () => {
  /*
   * Nine became two. Seven of upstream's existed only as a channel across worlds
   * that the panel polled, and there is a real message channel now — so what is
   * left is the state that genuinely cannot cross `postMessage`: the functions
   * and the DOM nodes behind the last pick. Wave 3 greps the tree for the other
   * product's prefix; this fails first, in the package that owns the names.
   */
  it('are the two in PAGE_GLOBALS, under the DevFlow prefix', () => {
    expect(Object.values(PAGE_GLOBALS)).toEqual(['__DEVFLOW_AGENT__', '__DEVFLOW_PICKED__']);
  });

  it('leave no trace of the other product', () => {
    for (const file of ['agent.ts', 'picker.ts', 'overlay.ts', 'highlight.ts']) {
      expect(read(`src/injected/${file}`)).not.toMatch(BANNED_PREFIX);
    }
  });
});

describe('the picker costs an idle page nothing', () => {
  const picker = read('src/injected/picker.ts');

  /*
   * The agent is a manifest content script on `<all_urls>` at `document_start`,
   * so it is present in every document the user opens. If arming were a side
   * effect of loading it, every page on the web would be tracking `mousemove`
   * and walking fibers per frame for a gesture nobody made. That is the whole
   * reason one agent can serve both halves.
   */
  it('attaches nothing at import time', () => {
    const topLevel = picker
      .split('\n')
      .filter((line) => /^(document|window)\.(add|remove)EventListener/.test(line));
    expect(topLevel).toEqual([]);
  });

  it('removes exactly what it added', () => {
    const added = picker.match(/document\.addEventListener/g) ?? [];
    const removed = picker.match(/document\.removeEventListener/g) ?? [];
    // `blockTrailingGesture` adds and removes its own in one loop each, and
    // `arm`/`disarm` mirror one another line for line.
    expect(added.length).toBe(removed.length);
  });
});
