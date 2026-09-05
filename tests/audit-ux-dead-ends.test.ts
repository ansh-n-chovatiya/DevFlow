// @vitest-environment jsdom

/**
 * Two places the product said something a normal user could not act on.
 *
 * Both are the same defect wearing different clothes: an answer that names a
 * cause and then leaves the reader holding it. The card knew a switch was
 * involved and offered no switch; the picker knew a walk had failed and said so
 * in React's own vocabulary. Neither is a crash, neither fails a type, and both
 * read as finished work on the way past — which is why they are pinned here
 * rather than left to the next reviewer's eye.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { pos0 } from '../src/core/locate/positions.js';
import type { ComponentSource } from '../src/shared/types.js';
import { actionFor, resultCard } from '../src/ui/components/result-card.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (file: string): string => readFileSync(resolve(root, file), 'utf8');

/**
 * The record `locate.ts` writes for both causes of `compiled-only`.
 *
 * Byte for byte the same either way — that identity is the finding, and building
 * one fixture for both branches is how this test states it.
 */
function compiledOnly(): ComponentSource {
  return {
    name: 'CartSummary',
    status: 'compiled-only',
    via: 'bundle-search',
    compiled: { url: 'https://shop.example/assets/main-9f2.js', line: pos0(1), column: pos0(4210) },
  };
}

const text = (card: HTMLElement, selector: string): string =>
  card.querySelector(selector)?.textContent ?? '';

describe('a compiled-only answer whose cause is the switch', () => {
  it('offers the switch rather than a sentence naming two causes', () => {
    const action = actionFor(compiledOnly(), true);
    expect(action?.control?.kind).toBe('enable-source-lookup');
  });

  it('renders a working control on a surface that owns the setting', () => {
    const onEnableSourceLookup = vi.fn();
    const card = resultCard({
      source: compiledOnly(),
      sourceLookupOff: true,
      onEnableSourceLookup,
    });

    const button = card.querySelector<HTMLButtonElement>('.result-card__action-btn');
    expect(button?.textContent).toContain('Turn on source lookup');

    button?.click();
    expect(onEnableSourceLookup).toHaveBeenCalledTimes(1);
  });

  it('stops blaming the build once the surface has ruled the build out', () => {
    const advice = text(
      resultCard({ source: compiledOnly(), sourceLookupOff: true }),
      '.result-card__action',
    );
    expect(advice).toContain('switched off');
    expect(advice).not.toContain('.map');
  });
});

describe('a compiled-only answer whose cause is the build', () => {
  it('names the .map files and offers no switch, because none is off', () => {
    const card = resultCard({
      source: compiledOnly(),
      sourceLookupOff: false,
      onEnableSourceLookup: vi.fn(),
    });

    expect(text(card, '.result-card__action')).toContain('.map');
    // The switch is on. A button labelled "Turn on source lookup" beside an
    // already-on setting is the dead end this fix exists to remove, not a
    // second copy of it.
    expect(text(card, '.result-card__action')).not.toContain('switched off');
    expect(card.querySelector('.result-card__action-btn')).toBeNull();
  });
});

describe('a surface that cannot know which cause it was', () => {
  it('keeps the hedged sentence rather than guessing', () => {
    // The flow review holds a stored record and no memory of the setting the
    // resolver ran under. Hedging is the honest answer there, so omitting the
    // flag must not change what it has always shown.
    const card = resultCard({ source: compiledOnly(), onEnableSourceLookup: vi.fn() });
    const advice = text(card, '.result-card__action');

    expect(advice).toContain('switched off in Settings');
    expect(advice).toContain('.map');
    expect(card.querySelector('.result-card__action-btn')).toBeNull();
  });
});

describe('what the picker tells the page’s user', () => {
  const PICKER = 'src/injected/picker.ts';

  /** Every sentence the picker hands to the panel's error banner, verbatim. */
  function pickerErrors(): string[] {
    const source = read(PICKER);
    const literal = /error:\s*((?:'[^'\\\n]*'\s*\+\s*)*'[^'\\\n]*')/g;
    return [...source.matchAll(literal)].map((match) =>
      [...match[1].matchAll(/'([^'\\\n]*)'/g)].map((part) => part[1]).join(''),
    );
  }

  it('finds every error sentence, so the assertions below are over all of them', () => {
    // A regex that silently matched nothing would pass every test under it.
    expect(pickerErrors().length).toBeGreaterThanOrEqual(3);
  });

  it('names no React internal a person cannot see', () => {
    // “fiber” is React's word for a node in its own tree. It is not a thing on
    // screen, so a message built around it describes a failure the reader has no
    // way to confirm and no way to act on.
    const jargon = /\bfibers?\b|\bstateNode\b|\breconcil|\bvirtual DOM\b/i;
    for (const message of pickerErrors()) {
      expect(message, message).not.toMatch(jargon);
    }
  });

  it('says what to do when React owns the element but no component surrounds it', () => {
    const message = pickerErrors().find((line) => line.startsWith('React rendered this element'));
    expect(message).toBeDefined();
    // CONTRACTS §4: you pick an element and you locate a component, and the
    // house standard in `shared/errors.ts` is what happened plus what to do.
    expect(message).toContain('no component around it to locate');
    expect(message).toContain('Pick a different element');
  });
});
