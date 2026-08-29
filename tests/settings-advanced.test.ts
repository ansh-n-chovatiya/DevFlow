/**
 * Tier 2, and the claim Phase 6 is the proof of.
 *
 * The plan's bet is that after five phases of building the mechanism, adding
 * twenty-eight settings is adding twenty-eight rows to a table — no new
 * markup, no new control, no new screen state. Two other files hold the
 * visible half of that: `settings-row-shape.test.ts` renders every entry and
 * asserts the row is one object seventy-three times, and
 * `settings-page.test.ts` opens the Advanced disclosure on the real page and
 * counts what appears.
 *
 * This file holds the half that is not visible: that each of the twenty-eight is
 * actually *read* by the process it names, and that each says what a bad value
 * costs. A Tier 2 control that does nothing would be worse here than anywhere
 * else on the screen — these are the settings whose symptom is a recording that
 * looks broken, so a user who changes one and sees no effect has no way at all
 * to tell "it did nothing" from "it worked and my recording is worse".
 */

import { globSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createChainBuffer } from '../src/core/react/chains.js';
import { collectChain } from '../src/core/react/fiber.js';
import {
  DEFAULT_RESOLVE_LIMITS,
  resolvePending,
  type ResolveDeps,
} from '../src/features/react/resolver.js';
import { toAgentConfig } from '../src/features/settings/agent.js';
import { frozen, recordedOverrides } from '../src/features/settings/recording.js';
import { RECORDED } from '../src/features/settings/fields.js';
import {
  DEFAULTS,
  FIELDS,
  WIRED,
  consequenceApplies,
  resolve,
  type Field,
} from '../src/features/settings/index.js';

const tier2 = (FIELDS as readonly Field[]).filter((field) => field.tier === 2);

describe('the table', () => {
  it('wires all twenty-eight, so the disclosure holds no control that does nothing', () => {
    /*
     * the list reads as twenty-two because it pairs four of them off —
     * `BUNDLE_CACHE_ENTRIES / BUNDLE_CACHE_BYTES`, `REACT_BUFFER_SIZE / _TTL_MS`
     * — and names two groups by their shape ("the three send/health/remote
     * TIMEOUT_MS", "thumbnail WIDTH/HEIGHT/QUALITY"). That is twenty-six.
     *
     * The last two are `react.prewarmTtlMs` and `ui.launcherTimeoutMs`, which
     * the tier tables list in no tier at all. Phase 3 ruled both Tier 2 and handed them
     * here by name rather than letting them be inherited by silence a fourth
     * time; this phase tabled them.
     */
    expect(tier2).toHaveLength(28);
    expect(tier2.filter((field) => field.wired !== true)).toEqual([]);
    expect(WIRED).toHaveLength(FIELDS.length);
  });

  it('gives every one of them a consequence, and a range for it to be true in', () => {
    /*
     * The phase's own instruction: these need their consequence lines more than
     * anything in Tier 1 does. A setting whose cost cannot be stated in one
     * sentence probably belongs in Tier 3 — none of the twenty-eight turned out
     * to be one, and the ledger says so.
     *
     * A threshold on every one of them, unlike Tier 1's three bare
     * consequences: a Tier 2 default is a working value by definition, so
     * "modified" is never the honest condition here — what matters is which way
     * it was moved and how far.
     */
    expect(tier2.filter((field) => !field.consequence).map((f) => f.key)).toEqual([]);
    expect(tier2.filter((field) => !field.consequenceWhen).map((f) => f.key)).toEqual([]);
  });

  it('says nothing at the default, and speaks when the value goes the wrong way', () => {
    // The rule, and the one a warning that is always on breaks: a
    // consequence appears when the value enters the range it describes.
    for (const field of tier2) {
      const shipped = DEFAULTS[field.key as keyof typeof DEFAULTS];
      expect(consequenceApplies(field, shipped, false), field.key).toBe(false);
    }

    expect(consequenceApplies(field('screenshots.minIntervalMs'), 100, true)).toBe(true);
    expect(consequenceApplies(field('screenshots.minIntervalMs'), 900, true)).toBe(false);
    expect(consequenceApplies(field('react.bundleCacheBytes'), 400 * 1024 * 1024, true)).toBe(true);
  });

  it('freezes the twelve that shape a recording, and leaves the rest live', () => {
    /*
     * The freeze, applied to Tier 2. A setting the *recorder* reads while a recording
     * runs has to be frozen or the flow describes two rules at once; a setting
     * about work done afterwards — resolving components, drawing a thumbnail,
     * giving up on a silent server — is a question about now and is read live.
     *
     * `console.logArgCap` and `console.stackFrames` were already in the freeze
     * before this phase: Session 0 put them there because they ride to the
     * agent in the same message as the console levels, and noted that when
     * Phase 6 drew them the freeze would already be right. It was.
     */
    const frozenT2 = tier2.filter((f) => f.recorded === true).map((f) => f.key).sort();
    expect(frozenT2).toEqual([
      'console.logArgCap',
      'console.stackFrames',
      'react.bufferSize',
      'react.bufferTtlMs',
      'react.chainTimeoutMs',
      'react.maxComponentChain',
      'react.maxFiberWalk',
      'react.prewarmTtlMs',
      'recording.spaSettleMs',
      'screenshots.minIntervalMs',
      'screenshots.paintTimeoutMs',
      'screenshots.precaptureTtlMs',
    ]);

    // And they are in the stamp, so a recording made with a moved capture
    // interval says so rather than reading as one whose screenshots failed.
    const stamp = recordedOverrides(resolve({ 'screenshots.minIntervalMs': 100 }));
    expect(stamp).toEqual({ 'screenshots.minIntervalMs': 100 });
    expect(RECORDED.map((f) => f.key)).toContain('screenshots.minIntervalMs');
  });
});

function field(key: string): Field {
  return (FIELDS as readonly Field[]).find((entry) => entry.key === key)!;
}

describe('Tier 3, which is the other half of the same decision', () => {
  /*
   * The rule: "Tier 3 stays in `constants.ts` and gets a comment saying it is
   * deliberately not configurable. That comment is the deliverable — the next
   * person to be asked 'why can't I change this' should find the answer in the
   * file."
   *
   * Session 0 wrote them and every phase since has been asked to confirm they
   * are still there. This is that confirmation, made once rather than by
   * looking: the failure it catches is a constant that quietly becomes a
   * setting because nobody re-read the paragraph next to it — and the whole
   * tiering is the substance of the plan, not a formality.
   */
  const TIER_3 = [
    'FLOW_SCHEMA_VERSION',
    'SUPPORTED_SCHEMA',
    'SCREENSHOT_FILE',
    'MAX_BODY_BYTES',
    // Phase 5's, and the rule read forward onto a constant the tiering predates: the
    // second bound on an unauthenticated POST, and the one that writes a file.
    'MAX_CONFIG_BYTES',
    'AGENT_MESSAGE_SOURCE',
    'CONTROL_MESSAGE_SOURCE',
    'INDICATOR_ID',
    'FNV_PRIME',
    'SEED_A',
    'SEED_B',
    'HASH_SOURCE_LEN',
    // The tiering names "VLQ masks" and they are two named constants, so they are
    // checkable here rather than only readable. The source-map line base is the
    // fifth thing the row names and it is an expression, not a constant — it
    // carries its comment at `core/react/sourcemap.ts`, where the `+ 1` is.
    'VLQ_CONTINUATION',
    'VLQ_VALUE_MASK',
    'ORPHAN_GRACE_MS',
    'MAX_MATCHES_TRACKED',
    'MIN_NEEDLE_LEN',
    'NEEDLE_HEAD_LEN',
    'NEEDLE_BODY_LEN',
  ];

  const root = resolvePath(dirname(fileURLToPath(import.meta.url)), '..');
  const sources = [
    ...globSync('src/**/*.ts', { cwd: root }),
    'mcp-server/server.js',
  ].map((file) => readFileSync(resolvePath(root, file), 'utf8'));

  it.each(TIER_3)('%s says why it is not a setting, next to itself', (name) => {
    const declaration = new RegExp(`^(?:export )?const ${name}\\b`, 'm');
    const source = sources.find((text) => declaration.test(text));
    expect(source, `${name} is declared nowhere`).toBeDefined();

    // The marker has to be in the block immediately above the declaration, not
    // somewhere in the file: the point is that it is found by whoever is
    // reading the number.
    const above = source!.slice(0, declaration.exec(source!)!.index);
    expect(above.slice(-1200)).toContain('Tier 3');
  });

  it('is not in the field table, and cannot be', () => {
    // The stronger statement: a Tier 3 constant that grew a `fields.ts` entry
    // would be reachable from the Settings screen whatever its comment says.
    const keys = FIELDS.map((entry) => entry.key.toLowerCase().replace(/[^a-z]/g, ''));
    for (const name of TIER_3) {
      expect(keys, name).not.toContain(name.toLowerCase().replace(/[^a-z]/g, ''));
    }
  });
});

describe('what actually reads them', () => {
  it('pushes the two fiber limits into the MAIN world, frozen', () => {
    // The fiber walk is the page's own React, so the isolated world cannot do
    // it — these two have to cross `postMessage` like the body cap does.
    const config = toAgentConfig(frozen({ 'react.maxComponentChain': 3, 'react.maxFiberWalk': 700 }));
    expect(config.maxComponentChain).toBe(3);
    expect(config.maxFiberWalk).toBe(700);
  });

  it('collects a chain no deeper than it was told to', () => {
    // A DOM-free stand-in for a fiber tree: `collectChain` walks `return`
    // pointers and reads `type` for the component function, and neither needs a
    // renderer to exist.
    const el = fiberElement(6);

    expect(collectChain(el, 2).entries).toHaveLength(2);
    expect(collectChain(el, 2).truncated).toBe(true);
    expect(collectChain(el, 12).entries).toHaveLength(6);
    // The walk ceiling is the other half, and it is a cycle guard rather than a
    // budget: too low and a deep tree records nothing at all.
    expect(collectChain(el, 12, 1).entries.length).toBeLessThan(6);
  });

  it('reconfigures the chain buffer instead of rebuilding it', async () => {
    vi.useFakeTimers();
    try {
      // Built at `document_start` with the compiled-in defaults, because a
      // click can land before storage answers; told the recording's frozen
      // values when one starts.
      const buffer = createChainBuffer<string>({ size: 4, ttlMs: 5000, timeoutMs: 50 });
      buffer.deliver({ eventTime: 100, value: 'Cart', at: 0 });

      buffer.configure({ size: 4, ttlMs: 5000, timeoutMs: 400 });

      // The chain held before the change is still there — reconfiguring must
      // not throw away an attribution the walk has already paid for.
      expect(buffer.pending()).toBe(1);

      const waiting = buffer.take(999, 0);
      await vi.advanceTimersByTimeAsync(100);
      buffer.deliver({ eventTime: 999, value: 'Header', at: 0 });
      // Under the old 50ms timeout this step would already have been written
      // without its component.
      expect(await waiting).toBe('Header');
    } finally {
      vi.useRealTimers();
    }
  });

  it('fetches a bundle under the configured ceiling, not the compiled-in one', async () => {
    const caps: number[] = [];
    const deps: ResolveDeps = {
      fetchText: (url, maxBytes) => {
        caps.push(maxBytes);
        return Promise.resolve(url.endsWith('.js') ? { ok: true as const, value: 'function Cart(){}' } : { ok: false as const });
      },
      now: () => 0,
    };

    await resolvePending(
      {
        components: { a: { name: 'Cart', status: 'pending' } },
        needles: { a: { head: 'function Cart(){}', pageUrl: 'https://shop.test/' } },
        scripts: { 'https://shop.test': ['https://shop.test/app.js'] },
        final: true,
        limits: { ...DEFAULT_RESOLVE_LIMITS, resourceBytes: 4096 },
      },
      deps,
    );

    expect(caps).toContain(4096);
    expect(caps).not.toContain(DEFAULT_RESOLVE_LIMITS.resourceBytes);
  });

  it('runs no more resolutions at once than it was allowed', async () => {
    let inFlight = 0;
    let peak = 0;
    const deps: ResolveDeps = {
      fetchText: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        inFlight -= 1;
        return { ok: false as const };
      },
      now: () => 0,
    };

    const components: Record<string, { name: string; status: 'pending' }> = {};
    const needles: Record<string, { head: string; pageUrl: string }> = {};
    for (let i = 0; i < 8; i += 1) {
      components[`c${i}`] = { name: `C${i}`, status: 'pending' };
      needles[`c${i}`] = { head: `function C${i}(){}`, pageUrl: 'https://shop.test/' };
    }

    await resolvePending(
      {
        components,
        needles,
        scripts: { 'https://shop.test': ['https://shop.test/app.js'] },
        final: true,
        limits: { ...DEFAULT_RESOLVE_LIMITS, concurrency: 2 },
      },
      deps,
    );

    expect(peak).toBeLessThanOrEqual(2);
  });
});

/**
 * A chain of `n` component fibers hanging off one element.
 *
 * `getFiber` looks for a `__reactFiber$…` key on the node, and the walk reads
 * `type` and `return` — so a plain object tree is enough to drive it, and much
 * clearer than mounting React to assert a counting rule.
 */
function fiberElement(depth: number): Element {
  let fiber: Record<string, unknown> | null = null;
  for (let i = depth - 1; i >= 0; i -= 1) {
    const fn = { [`C${i}`]: () => null }[`C${i}`];
    fiber = { type: fn, return: fiber, elementType: fn, memoizedProps: {} };
  }

  const node = {
    [`__reactFiber$test`]: fiber,
    ownerDocument: { documentElement: {} },
    parentElement: null,
  };
  return node as unknown as Element;
}
