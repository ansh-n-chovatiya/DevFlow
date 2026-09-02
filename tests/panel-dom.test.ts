// @vitest-environment jsdom

/**
 * The panel's decisions, driven without a panel.
 *
 * What is asserted here is the set of things that are wrong *invisibly* on
 * screen. A `Copy path` button that stays live behind the picker still looks
 * pressable and copies the previous answer. A tree whose rail numbers come from
 * the raw chain rather than from the rendered list reads as though rows failed
 * to draw. A preview whose gutter is one line off looks exactly like a preview
 * that is right. None of those produces an error, a warning, or a visibly broken
 * layout, which is precisely why they are functions with a test rather than
 * branches inside a render pass.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULTS } from '../src/features/settings/index.js';
import { pos0, pos1 } from '../src/core/react/positions.js';
import { classifyPicked, type HiddenCategories } from '../src/core/react/classify.js';
import type { ComponentSource, PickedComponent } from '../src/shared/types.js';
import {
  categoryChip,
  chipModels,
  hiddenCategories,
  hiddenKey,
  highlight,
  modifierLabel,
  previewBlock,
  previewLines,
  rowBadge,
  statusBarModel,
  statusHint,
  treeRow,
  visibleRows,
  withoutAmbiguity,
  type StatusBarInput,
} from '../src/ui/locator/dom.js';

// ── Fixtures ─────────────────────────────────────────────────────────────────

const NOTHING_HIDDEN: HiddenCategories = {
  routing: false,
  providers: false,
  react: false,
  styling: false,
  dependency: false,
};

const PLUMBING_HIDDEN: HiddenCategories = {
  routing: true,
  providers: true,
  react: true,
  styling: true,
  dependency: true,
};

function resolved(over: Partial<ComponentSource> = {}): ComponentSource {
  return {
    name: 'CartSummary',
    status: 'resolved',
    via: 'bundle-search',
    source: 'src/checkout/CartSummary.tsx',
    line: pos1(42),
    column: pos1(7),
    compiled: { url: 'https://x.test/main.js', line: pos0(1), column: pos0(9185) },
    ...over,
  };
}

function named(name: string, debugSource?: string): PickedComponent {
  if (!debugSource) return { name };
  return { name, debugSource: { source: debugSource, line: pos1(12), column: pos1(3) } };
}

function bar(over: Partial<StatusBarInput> = {}): StatusBarInput {
  return {
    view: 'result',
    source: resolved(),
    editorUrl: 'vscode://file/Users/me/app/src/checkout/CartSummary.tsx:42:7',
    path: 'src/checkout/CartSummary.tsx:42:7',
    ...over,
  };
}

// ── The status bar ───────────────────────────────────────────────────────────

describe('statusBarModel', () => {
  it('shows the path itself as the hint, because that is the answer', () => {
    expect(statusBarModel(bar()).hint).toBe('src/checkout/CartSummary.tsx:42:7');
  });

  it('drops every action the moment the result is not the view on screen', () => {
    /*
     * The failure this exists for: the picker is armed over a previous answer,
     * the actions are still live, and `Copy path` copies the *old* path with no
     * sign that anything is wrong.
     */
    const model = statusBarModel(bar({ view: 'picking' }));

    expect(model.editor.disabled).toBe(true);
    expect(model.sources.disabled).toBe(true);
    expect(model.copy.disabled).toBe(true);
    expect(model.hint).toBe('Picking — click an element, Esc to cancel');
  });

  it('says why Open in Editor is dark, and the two reasons are different', () => {
    const unconfigured = statusBarModel(bar({ editorUrl: null }));
    expect(unconfigured.editor.disabled).toBe(true);
    expect(unconfigured.editor.title).toContain('project root');

    const noFile = statusBarModel(
      bar({ editorUrl: null, source: resolved({ status: 'compiled-only', source: undefined }) }),
    );
    expect(noFile.editor.title).toContain('no file to open');
  });

  it('offers Open in Sources only when a compiled position was actually found', () => {
    expect(statusBarModel(bar()).sources.disabled).toBe(false);
    expect(
      statusBarModel(bar({ source: resolved({ compiled: undefined }) })).sources.disabled,
    ).toBe(true);
  });

  it('re-labels the one go button per view, in the frozen words', () => {
    expect(statusBarModel(bar({ view: 'idle', source: null, path: null })).go.label).toBe(
      'Pick component',
    );
    expect(statusBarModel(bar({ view: 'result' })).go.label).toBe('Pick another');
    expect(statusBarModel(bar({ view: 'error' })).go.label).toBe('Pick another');
    expect(statusBarModel(bar({ view: 'picking' })).go.label).toBe('Cancel');
  });

  it('will not let a second pick start on top of a locate that is still running', () => {
    const model = statusBarModel(bar({ view: 'locating', locating: 'CartSummary' }));
    expect(model.go.disabled).toBe(true);
    expect(model.hint).toBe('Locating CartSummary…');
  });
});

describe('statusHint', () => {
  it('names the shortcut on the empty panel', () => {
    expect(statusHint('idle')).toBe('Press P to pick');
  });

  it('falls back to a bare sentence when no component is named yet', () => {
    expect(statusHint('locating')).toBe('Locating…');
  });
});

describe('modifierLabel', () => {
  it('does not promise ⌘ on a machine that has no ⌘ key', () => {
    expect(modifierLabel('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('⌘');
    expect(modifierLabel('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Ctrl');
    expect(modifierLabel('Mozilla/5.0 (X11; Linux x86_64)')).toBe('Ctrl');
  });
});

// ── Settings, as this surface reads them ─────────────────────────────────────

describe('hiddenCategories', () => {
  it('reads the five flat keys the settings table actually defines', () => {
    // The point is that these keys exist in `Settings` at all: the chips are
    // generated from the `HideableCategory` union, and a sixth category with no
    // key behind it would fail to compile here rather than silently never save.
    expect(hiddenKey('routing')).toBe('locator.hidden.routing');
    expect(hiddenCategories(DEFAULTS)).toEqual({
      routing: DEFAULTS['locator.hidden.routing'],
      providers: DEFAULTS['locator.hidden.providers'],
      react: DEFAULTS['locator.hidden.react'],
      styling: DEFAULTS['locator.hidden.styling'],
      dependency: DEFAULTS['locator.hidden.dependency'],
    });
  });
});

// ── Trees ────────────────────────────────────────────────────────────────────

const CHAIN: PickedComponent[] = [
  named('BrowserRouter'),
  named('QueryClientProvider'),
  named('CheckoutPage'),
  named('CartSummary'),
];

describe('visibleRows', () => {
  it('hides plumbing but keeps the component that is selected', () => {
    // Hiding the row the user is looking at would leave the tree with nothing
    // highlighted and no way back to it.
    const rows = visibleRows(CHAIN, PLUMBING_HIDDEN, 0, '');

    expect(rows.map((row) => row.item.name)).toEqual([
      'BrowserRouter',
      'CheckoutPage',
      'CartSummary',
    ]);
  });

  it('reports unfiltered indices, because that is what the page is addressed by', () => {
    const rows = visibleRows(CHAIN, PLUMBING_HIDDEN, -1, '');
    expect(rows.map((row) => row.index)).toEqual([2, 3]);
  });

  it('applies the typed query on top of the chips, case-insensitively', () => {
    expect(visibleRows(CHAIN, NOTHING_HIDDEN, -1, 'cart').map((r) => r.item.name)).toEqual([
      'CartSummary',
    ]);
    expect(visibleRows(CHAIN, NOTHING_HIDDEN, -1, '   ').map((r) => r.item.name)).toHaveLength(4);
  });
});

describe('rowBadge', () => {
  it('labels a row that survived the filter, so it does not read as a filter miss', () => {
    const badge = rowBadge(named('BrowserRouter'), PLUMBING_HIDDEN);
    expect(badge?.text).toBe('routers');
    expect(badge?.title).toContain('selected');
  });

  it('marks a component React recorded a source for', () => {
    expect(rowBadge(named('CartSummary', 'src/CartSummary.tsx'), NOTHING_HIDDEN)?.text).toBe('◆');
  });

  it('says nothing about an ordinary component', () => {
    expect(rowBadge(named('CartSummary'), NOTHING_HIDDEN)).toBeNull();
  });

  /*
   * The mark means "this row's answer needs no bundle search", and a build
   * stamp means that as much as `_debugSource` does. What it does not mean is
   * that React recorded anything, so the sentence behind the mark is a
   * different one.
   */
  it('marks a component the build stamped, and does not credit React for it', () => {
    const stamped: PickedComponent = {
      name: 'CartSummary',
      stamp: { source: 'src/CartSummary.tsx', line: pos1(12) },
    };

    const badge = rowBadge(stamped, NOTHING_HIDDEN);
    expect(badge?.text).toBe('◆');
    expect(badge?.title).toBe('The build recorded where this component was defined.');
  });
});

describe('classifyPicked, through the filters the tree draws', () => {
  /*
   * A stamped path is the only path a `node_modules` component has on a build
   * with no `_debugSource`. Reading only `debugSource` would classify it as the
   * user's own code and leave it in the tree with the `dependencies` chip on.
   */
  it('classifies a stamped node_modules component as a dependency', () => {
    const stamped: PickedComponent = {
      name: 'Box',
      stamp: { source: 'node_modules/@ui/kit/Box.tsx', line: pos1(3) },
    };

    expect(classifyPicked(stamped)).toBe('dependency');
    expect(classifyPicked({ name: 'Box', stamp: { source: 'src/Box.tsx', line: pos1(3) } })).toBe(
      'unknown',
    );
  });
});

describe('highlight', () => {
  it('marks the match without ever parsing a component name as markup', () => {
    const host = document.createElement('span');
    host.append(highlight('<img src=x onerror=1>Cart', 'cart'));

    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('mark')?.textContent).toBe('Cart');
    expect(host.textContent).toBe('<img src=x onerror=1>Cart');
  });

  it('leaves the name alone when nothing is typed', () => {
    const host = document.createElement('span');
    host.append(highlight('CartSummary', ''));
    expect(host.querySelector('mark')).toBeNull();
  });
});

describe('treeRow', () => {
  const handlers = { onEnter: vi.fn(), onLeave: vi.fn(), onPick: vi.fn() };

  it('numbers by rendered position while addressing the page by raw index', () => {
    /*
     * The whole point of the split. Two of four components are hidden, so the
     * rail reads 1, 2 — but a hover has to highlight components 2 and 3, which
     * is what the agent knows them by.
     */
    const rows = visibleRows(CHAIN, PLUMBING_HIDDEN, -1, '');
    const second = treeRow(
      { entry: rows[1], group: 'ancestry', position: 2, active: false, query: '', hidden: PLUMBING_HIDDEN },
      handlers,
    );

    expect(second.querySelector('.tree-rail')?.textContent).toBe('2');

    second.dispatchEvent(new MouseEvent('mouseenter'));
    expect(handlers.onEnter).toHaveBeenCalledWith('ancestry', 3);
  });

  it('gives siblings no rail, because they are a row rather than a chain', () => {
    const rows = visibleRows([named('CartSummary')], NOTHING_HIDDEN, -1, '');
    const row = treeRow(
      { entry: rows[0], group: 'sibling', position: 1, active: true, query: '', hidden: NOTHING_HIDDEN },
      handlers,
    );

    expect(row.querySelector('.tree-rail')).toBeNull();
    expect(row.classList.contains('active')).toBe(true);
    expect(row.getAttribute('role')).toBe('listitem');
  });
});

// ── Chips ────────────────────────────────────────────────────────────────────

describe('chipModels', () => {
  it('omits a category with no members rather than drawing a dead zero', () => {
    const models = chipModels(CHAIN, PLUMBING_HIDDEN);
    expect(models.map((m) => m.category)).toEqual(['routing', 'providers']);
    expect(models.map((m) => m.count)).toEqual([1, 1]);
  });

  it('offers the action, not the state, in the tooltip', () => {
    expect(chipModels(CHAIN, PLUMBING_HIDDEN)[0].title).toContain('click to show');
    expect(chipModels(CHAIN, NOTHING_HIDDEN)[0].title).toContain('click to hide');
  });
});

describe('categoryChip', () => {
  it('says pressed when the category is hidden — the chip is the filter', () => {
    const onToggle = vi.fn();
    const chip = categoryChip(chipModels(CHAIN, PLUMBING_HIDDEN)[0], onToggle);

    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.dataset.category).toBe('routing');
    expect(chip.querySelector('.chip-count')?.textContent).toBe('1');

    chip.dispatchEvent(new MouseEvent('click'));
    expect(onToggle).toHaveBeenCalledWith('routing');
  });
});

// ── Preview ──────────────────────────────────────────────────────────────────

const FILE = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n');

describe('previewLines', () => {
  it('numbers 1-based from a 0-based map line, and marks the target', () => {
    // The map says line 4 (0-based). A person reads line 5. Getting this wrong
    // produces a preview that looks entirely plausible and is off by one.
    const lines = previewLines(FILE, pos0(4));
    const active = lines.find((line) => line.active);

    expect(active).toEqual({ number: 5, text: 'four', active: true });
    expect(lines[0]).toEqual({ number: 1, text: 'zero', active: false });
    expect(lines.at(-1)?.number).toBe(9);
  });

  it('does not run off either end of the file', () => {
    expect(previewLines(FILE, pos0(0))[0].number).toBe(1);
    expect(previewLines(FILE, pos0(8)).at(-1)?.number).toBe(9);
    expect(previewLines('only', pos0(0))).toEqual([{ number: 1, text: 'only', active: true }]);
  });
});

describe('previewBlock', () => {
  it('puts the number in the gutter and the code beside it', () => {
    const host = document.createElement('pre');
    host.append(previewBlock(previewLines(FILE, pos0(4))));

    const active = host.querySelector('.preview-line-active');
    expect(active?.querySelector('.preview-gutter')?.textContent).toBe('5');
    expect(active?.textContent).toBe('5four');
  });
});

// ── The ambiguity warning ────────────────────────────────────────────────────

describe('withoutAmbiguity', () => {
  it('hoists the warning off the card so the panel can draw the dismissible one', () => {
    const ambiguous = resolved({ status: 'ambiguous', matchCount: 3 });
    expect(withoutAmbiguity(ambiguous).matchCount).toBeUndefined();
    // Everything else is the card's and is untouched.
    expect(withoutAmbiguity(ambiguous).status).toBe('ambiguous');
    expect(withoutAmbiguity(ambiguous).source).toBe('src/checkout/CartSummary.tsx');
  });

  it('leaves an unambiguous answer exactly as it was', () => {
    const source = resolved();
    expect(withoutAmbiguity(source)).toBe(source);
  });
});
