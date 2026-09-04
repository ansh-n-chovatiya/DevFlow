// @vitest-environment jsdom
/**
 * That `vue.maxVNodeWalk` reaches the walk, through the whole channel, on a
 * click.
 *
 * The pieces are each covered elsewhere — `vue-tree.test.ts` for the budget's
 * arithmetic, `vue-adapter.test.ts` for the adapter reading it per call,
 * `settings-agent-push.test.ts` for it crossing into the MAIN world. This file
 * exists because all three can pass while the setting still does nothing.
 *
 * The gap is one line in `agent.ts`. `adapters()` is memoised — built on the
 * first interaction and kept — and `applyConfig` lands whenever the content
 * script gets round to it. So `buildAdapters(window)` and
 * `buildAdapters(window, () => config.vueMaxVNodeWalk)` behave identically for
 * every test that only ever uses the shipped default: the first one quietly
 * pins the compiled-in constant for the life of the page, and the only
 * observable difference is a user who moves the setting and sees nothing
 * change. That is the failure this asserts against, and it is exactly the
 * failure `agent.ts`'s own `config` comment forbids — a setting read once
 * instead of at the point of use.
 *
 * The alternative was to test `buildAdapters` directly. It would not have
 * worked: `registry.ts` takes the getter honestly, so a registry test passes
 * whatever `agent.ts` chooses to hand it.
 *
 * The agent is imported for its side effects — it patches `console` and
 * `fetch` at import time — so the fixture has to be standing first.
 */

import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { CONTROL_MESSAGE_SOURCE, VUE_MAX_VNODE_WALK } from '../src/shared/constants.js';
import type { AgentConfig } from '../src/shared/messages.js';
import { plainVueApp } from './vue-fixtures.test.js';

interface Emitted {
  __devflow_source__?: string;
  kind?: string;
  chains?: { framework: string; chain: { kind: string; reason?: string; name?: string }[] }[];
}

const seen: Emitted[] = [];

function stamp(el: Element, key: string, value: unknown): void {
  (el as unknown as Record<string, unknown>)[key] = value;
}

function need(id: string): Element {
  const el = document.getElementById(id);
  if (!el) throw new Error(`fixture is missing #${id}`);
  return el;
}

/**
 * The production page the spike measured, rebuilt: a mount container that still
 * carries `__vue_app__` and `_vnode`, and elements below it that carry nothing
 * at all. This is the only page shape on which the budget is reachable — where
 * `__vueParentComponent` survives, the walk never runs.
 */
function mountProductionVue(): void {
  document.body.innerHTML = `
    <div id="app">
      <div id="root-app">
        <h1 id="title">t</h1>
        <section id="mid"><button id="leaf-1">Leaf</button></section>
        <p id="options-p">p</p>
        <div id="render-fn-div">d</div>
        <span id="ssr-leftover">left over</span>
      </div>
    </div>`;

  const fixture = plainVueApp(
    {
      container: need('app'),
      rootApp: need('root-app'),
      title: need('title'),
      mid: need('mid'),
      leaf: need('leaf-1'),
      optionsP: need('options-p'),
      renderFnDiv: need('render-fn-div'),
      slotFragment: document.createTextNode(''),
    },
    // Production, and nothing else would do: this is the only build where the
    // walk runs at all. With `__vueParentComponent` on the element the answer
    // costs one property read and no budget is consulted.
    'production',
  );

  stamp(need('app'), '__vue_app__', fixture.app);
  stamp(need('app'), '_vnode', fixture.rootVNode);
}

/** Deliver a control message the way the content script does. */
async function pushControl(recording: boolean, config?: Partial<AgentConfig>): Promise<void> {
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { __devflow_control__: CONTROL_MESSAGE_SOURCE, recording, config },
      origin: window.location.origin,
      source: window,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Click the leaf and return the framework message the agent emitted for it. */
async function clickLeaf(): Promise<Emitted | undefined> {
  seen.length = 0;
  document.getElementById('leaf-1')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  return seen.find((message) => message.kind === 'framework');
}

/** The Vue chain's innermost link, whatever kind it turned out to be. */
function innermost(message: Emitted | undefined): { kind: string; reason?: string; name?: string } {
  const vue = message?.chains?.find((entry) => entry.framework === 'vue');
  expect(vue, 'the agent emitted no Vue chain for this click').toBeDefined();
  return vue!.chain.at(-1)!;
}

beforeAll(async () => {
  window.addEventListener('message', (event: MessageEvent<Emitted>) => {
    if (event.data?.__devflow_source__) seen.push(event.data);
  });
  mountProductionVue();
  await import('../src/injected/agent.js');
});

beforeEach(() => {
  mountProductionVue();
});

describe('vue.maxVNodeWalk, pushed at a live agent', () => {
  // `searchable` and not `declared`: a production build has no `__file` to
  // declare, which is the whole reason the walk exists. What the budget decides
  // is whether the innermost link is the component at all.
  it('reaches the component at the shipped budget', async () => {
    await pushControl(true, { vueMaxVNodeWalk: VUE_MAX_VNODE_WALK });

    expect(innermost(await clickLeaf())).toMatchObject({ kind: 'searchable', name: 'DeepLeaf' });
  });

  /*
   * The one that kills the memoised-default bug. The adapters were already
   * built by the case above, under a budget large enough to finish; this pushes
   * a smaller one afterwards and expects the *next* click to obey it. An agent
   * that handed `buildAdapters` a number instead of a getter passes everything
   * else in this repository and fails here.
   */
  it('obeys a budget pushed after the adapters were already built', async () => {
    await pushControl(true, { vueMaxVNodeWalk: 2 });
    const starved = innermost(await clickLeaf());

    // Exhausted is not "nothing found": it names the build that removed the
    // link and says how far the replacement got.
    expect(starved.kind).toBe('absent');
    expect(starved.reason).toBe('stripped-by-build');

    // And it goes back, on the same adapters, without a reload.
    await pushControl(true, { vueMaxVNodeWalk: VUE_MAX_VNODE_WALK });

    expect(innermost(await clickLeaf())).toMatchObject({ kind: 'searchable', name: 'DeepLeaf' });
  });

  /*
   * The channel is `window.postMessage`, which the page can post to. A zeroed
   * budget would report `search-exhausted` on every click of an application
   * that resolves perfectly well — the floor is what stops a page turning Vue
   * capture off for the session while looking like a page Vue simply failed on.
   */
  it('floors a budget of zero rather than letting the page switch Vue off', async () => {
    await pushControl(true, { vueMaxVNodeWalk: 0 });

    expect(innermost(await clickLeaf()).kind).toBe('absent');

    await pushControl(true, { vueMaxVNodeWalk: VUE_MAX_VNODE_WALK });

    expect(innermost(await clickLeaf())).toMatchObject({ kind: 'searchable', name: 'DeepLeaf' });
  });
});
