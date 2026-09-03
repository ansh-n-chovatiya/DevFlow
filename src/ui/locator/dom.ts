/**
 * Every decision the panel makes about what to draw, separated from the drawing.
 *
 * The panel is five views, a status bar, two trees, a chip row, a preview and
 * two drawers, and almost all of the bugs in that surface are decisions rather
 * than DOM: which button is live for a result that has no original file, which
 * label the one shared go-button is wearing, which rows survive a filter and
 * what numbers appear beside them once some of their neighbours are hidden. So
 * the decisions are functions here, `tests/panel-dom.test.ts` is their
 * specification, and `main.ts` is left knowing only how to put the answers on
 * screen and how to turn a click into a message — the same split
 * `ui/popup/view.ts` and `ui/viewer/review-view.ts` already use.
 *
 * The row and chip builders live here too rather than in the controller. They
 * are the only markup the panel constructs at all — everything else is in
 * `src/panel.html`, the result card is `ui/components/result-card.ts`, and the
 * settings rows are `ui/settings/components.ts` — and a builder in a file with
 * a jsdom test beside it is a builder whose accessibility attributes and class
 * names are actually checked.
 *
 * No `chrome.*` anywhere in this file: everything it needs arrives as an
 * argument, which is what lets the tests drive it with a plain object where the
 * panel has a live tab.
 */

import {
  CATEGORY_DESCRIPTIONS,
  CATEGORY_LABELS,
  classifyPicked,
  countByCategory,
  filterComponents,
  HIDEABLE_CATEGORIES,
  isHidden,
  type HideableCategory,
  type HiddenCategories,
  type VisibleEntry,
} from '../../core/react/classify.js';
import { toOneBased, type Pos0 } from '../../core/locate/positions.js';
import type { ComponentSource, PickedComponent, TreeGroup } from '../../shared/types.js';

// ── Element access ───────────────────────────────────────────────────────────

/**
 * The panel's markup is ours and is static, so a missing id is a build mistake
 * rather than a runtime condition — the same reasoning, and the same shape, as
 * `ui/viewer/dom.ts`.
 */
export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`DevFlow: missing #${id} in panel.html`);
  return node as T;
}

export function setText(id: string, text: string): void {
  el(id).textContent = text;
}

export function toggle(node: HTMLElement, visible: boolean): void {
  node.hidden = !visible;
}

/** The one place an element is made, so "what does the panel render" is a grep. */
function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// ── Views ────────────────────────────────────────────────────────────────────

export type ViewName = 'idle' | 'picking' | 'locating' | 'result' | 'error';

export const VIEWS: readonly ViewName[] = ['idle', 'picking', 'locating', 'result', 'error'];

/**
 * The locating checklist.
 *
 * The first three rows are already true the moment the view opens — the agent
 * has picked an element, walked the DOM and returned the fiber chain — so they
 * open as done. The last two are reported by the locate itself, and nothing is
 * advanced on a timer: a row still reading *pending* when the result lands means
 * that stage genuinely never ran, which is how the checklist stays evidence
 * rather than decoration.
 */
export type StageKey = 'detected' | 'dom' | 'tree' | 'match' | 'source';
export type StageState = 'done' | 'active' | 'pending';

export const STAGE_SEED: Readonly<Record<StageKey, StageState>> = {
  detected: 'done',
  dom: 'done',
  tree: 'done',
  match: 'active',
  source: 'pending',
};

// ── The status bar ───────────────────────────────────────────────────────────

/**
 * What the footer shows, given what the panel is doing.
 *
 * A model rather than four setters, because every one of these fields is wrong
 * in a way that is invisible on screen: a `Copy path` that stays live behind the
 * picker copies the *previous* result's path and looks like it worked, and an
 * `Open in Editor` that is merely disabled with no tooltip reads as broken
 * rather than as unconfigured. Deciding them together, from one input, is what
 * makes "the actions belong to the result on screen" checkable.
 */
export interface StatusBarModel {
  /** `Open in Editor` — live only when there is a URL to open. */
  editor: { disabled: boolean; title: string };
  /** `Open in Sources` — live only when a compiled position was found. */
  sources: { disabled: boolean; title: string };
  /** `Copy path` — live only when the card is showing a path to copy. */
  copy: { disabled: boolean; title: string };
  /** The one button that changes its word with the view. */
  go: { label: string; title: string; disabled: boolean };
  hint: string;
}

export interface StatusBarInput {
  view: ViewName;
  /**
   * The result on screen, or null. Deliberately not "the last result": a stale
   * result sitting behind the picking view must not leave the actions live.
   */
  source: ComponentSource | null;
  /** From `componentEditorUrl`, so this file needs no settings of its own. */
  editorUrl: string | null;
  /** From `pathText`, for the same reason. */
  path: string | null;
  /** Named in the hint while a locate is running. */
  locating?: string;
}

export function statusBarModel(input: StatusBarInput): StatusBarModel {
  const { view, source, editorUrl, path } = input;
  const shown = view === 'result' ? source : null;

  return {
    editor: {
      // `shown`, not `source`: an editor link built from an answer that is no
      // longer the view on screen would open the previous component's file, and
      // a button that opens the wrong file is worse than one that is dark.
      disabled: shown === null || editorUrl === null,
      title: editorTitle(shown, editorUrl),
    },
    sources: {
      disabled: !shown?.compiled,
      title: shown?.compiled
        ? `Reveal ${shown.compiled.url} in the Sources panel`
        : 'No compiled position was found, so there is nothing to reveal.',
    },
    copy: {
      disabled: path === null || shown === null,
      title: shown && path ? `Copy ${path}` : 'Pick a component first.',
    },
    go: goButton(view, source !== null),
    hint: shown && path ? path : statusHint(view, input.locating),
  };
}

function editorTitle(shown: ComponentSource | null, editorUrl: string | null): string {
  if (!shown) return 'Pick a component first.';
  if (editorUrl) return `Open ${editorUrl}`;
  if (shown.source) return 'Set a project root in Settings to enable editor links.';
  return 'No original source was resolved, so there is no file to open.';
}

/**
 * One button, three words. CONTRACTS §4.4 freezes all three.
 *
 * `Pick component` until something has been picked and `Pick another` after,
 * because the footer is the panel's persistent chrome and re-labelling one
 * button is better than two buttons that must never both be visible. While the
 * picker is armed it is the way out of it — the picking view's own Cancel
 * scrolls away with the view, and this one does not.
 */
function goButton(view: ViewName, hasResult: boolean): StatusBarModel['go'] {
  if (view === 'picking') {
    return { label: 'Cancel', title: 'Stop picking (Esc)', disabled: false };
  }
  if (view === 'locating') {
    return { label: 'Pick another', title: 'Finishing the current locate…', disabled: true };
  }
  return hasResult
    ? { label: 'Pick another', title: 'Pick another component (P)', disabled: false }
    : { label: 'Pick component', title: 'Pick a component on the page (P)', disabled: false };
}

/** The footer's one line of prose, for every view that has no path to show. */
export function statusHint(view: ViewName, locating?: string): string {
  switch (view) {
    case 'picking':
      return 'Picking — click an element, Esc to cancel';
    case 'locating':
      return locating ? `Locating ${locating}…` : 'Locating…';
    case 'result':
      return 'Result ready';
    case 'error':
      return 'Something went wrong';
    case 'idle':
      return 'Press P to pick';
  }
}

/**
 * The filter's keycap hint, which must not promise ⌘ on Windows or Linux.
 *
 * Takes the platform string rather than reading `navigator`, so the branch is
 * testable without pretending to be a different operating system.
 */
export function modifierLabel(platform: string): string {
  return /mac/i.test(platform) ? '⌘' : 'Ctrl';
}

// ── Settings, as this surface reads them ─────────────────────────────────────

/** The storage key behind one chip. Flat and dotted, per CONTRACTS §3.3. */
export function hiddenKey(category: HideableCategory): `locator.hidden.${HideableCategory}` {
  return `locator.hidden.${category}`;
}

/**
 * The five flat keys, gathered into the nested shape `classify.ts` filters with.
 *
 * The flatness is the storage model's (a nested value cannot be partially
 * overridden, which is the whole basis of the sparse settings model) and the
 * nesting is the filter's. This is the one place the two meet.
 *
 * Typed structurally rather than as `Settings`, so this file imports nothing
 * from the settings mechanism at all — and the guarantee is unchanged, because
 * `Settings` is only assignable to this when all five keys exist on it as
 * booleans. A sixth `HideableCategory` with no key behind it fails to compile at
 * the call site rather than silently never saving.
 */
export function hiddenCategories(
  settings: Readonly<Record<`locator.hidden.${HideableCategory}`, boolean>>,
): HiddenCategories {
  return Object.fromEntries(
    HIDEABLE_CATEGORIES.map((category) => [category, settings[hiddenKey(category)]]),
  ) as HiddenCategories;
}

// ── Trees ────────────────────────────────────────────────────────────────────

/**
 * The rows one tree section should show.
 *
 * Two filters, and the order matters: the category chips first, then the typed
 * query. `keepIndex` survives both — the component the user is looking at cannot
 * be filtered out from under them, or the tree would have no highlighted row and
 * no way back to it.
 *
 * The indices in the result are positions in the *unfiltered* list, because that
 * is what the page agent keys its highlights by. Renumbering them here would
 * highlight the wrong element the moment a chip was toggled.
 */
export function visibleRows(
  items: PickedComponent[],
  hidden: HiddenCategories,
  keepIndex: number,
  query: string,
): VisibleEntry[] {
  const needle = query.trim().toLowerCase();
  return filterComponents(items, hidden, keepIndex).filter(
    ({ item }) => !needle || item.name.toLowerCase().includes(needle),
  );
}

/**
 * The badge on the right of a row, or null when the row needs none.
 *
 * Two things are worth saying and they are mutually exclusive. A row shown
 * *despite* its category being hidden is there on purpose — it is the selected
 * component — and saying which category it is stops it reading as a filter that
 * failed. Otherwise, a component React recorded a JSX source for is one whose
 * answer needs no bundle search at all, which is worth a mark.
 */
export function rowBadge(
  item: PickedComponent,
  hidden: HiddenCategories,
): { text: string; title: string } | null {
  const category = classifyPicked(item);

  if (isHidden(category, hidden)) {
    return {
      text: CATEGORY_LABELS[category as HideableCategory].toLowerCase(),
      title: 'A hidden category — shown because this component is selected.',
    };
  }

  if (item.stamp) {
    return { text: '◆', title: 'The build recorded where this component was defined.' };
  }

  if (item.debugSource) {
    return { text: '◆', title: 'React recorded where this component’s JSX was written.' };
  }

  return null;
}

/**
 * Builds a name with the query match marked.
 *
 * `<mark>` elements rather than an innerHTML string, because component names
 * come from page code nobody here controls and must never be parsed as markup.
 */
export function highlight(name: string, query: string): DocumentFragment {
  const frag = document.createDocumentFragment();
  const needle = query.trim().toLowerCase();
  if (!needle) {
    frag.append(name);
    return frag;
  }

  const haystack = name.toLowerCase();
  let from = 0;

  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    if (at > from) frag.append(name.slice(from, at));
    frag.append(make('mark', undefined, name.slice(at, at + needle.length)));
    from = at + needle.length;
  }

  if (from < name.length) frag.append(name.slice(from));
  return frag;
}

/** What a row does, so the builder needs no knowledge of messaging or state. */
export interface RowHandlers {
  /** Draw this component on the page. Fired on hover *and* focus. */
  onEnter: (group: TreeGroup, index: number) => void;
  /** Stop drawing it. */
  onLeave: () => void;
  /** Locate it. */
  onPick: (group: TreeGroup, index: number) => void;
}

export interface TreeRowInput {
  entry: VisibleEntry;
  group: TreeGroup;
  /** Position in the rendered list, 1-based. Only the ancestor rail shows it. */
  position: number;
  active: boolean;
  query: string;
  hidden: HiddenCategories;
}

export function treeRow(input: TreeRowInput, handlers: RowHandlers): HTMLElement {
  const { entry, group, position, active, query, hidden } = input;
  const { item, index } = entry;

  const row = make('button', 'tree-item');
  row.type = 'button';
  row.setAttribute('role', 'listitem');
  if (active) row.classList.add('active');
  row.title = `Locate ${item.name}`;

  if (group === 'ancestry') {
    /*
     * Numbered by position in the rendered list, not by index in the raw chain.
     * The gaps a filtered-out component leaves behind read as rows that failed
     * to render; `index` is still what the page is addressed by, and it stays on
     * the handlers rather than on the label.
     */
    row.append(make('span', 'tree-rail', String(position)));
  }

  const name = make('span', 'tree-name');
  name.append(highlight(item.name, query));
  row.append(name);

  const badge = rowBadge(item, hidden);
  if (badge) {
    const node = make('span', 'tree-badge', badge.text);
    node.title = badge.title;
    row.append(node);
  }

  // Hovering a row draws the component on the page, so its extent is visible
  // before anyone commits to locating it. Focus gets the same treatment, or the
  // feedback would be mouse-only.
  row.addEventListener('mouseenter', () => handlers.onEnter(group, index));
  row.addEventListener('focus', () => handlers.onEnter(group, index));
  row.addEventListener('mouseleave', handlers.onLeave);
  row.addEventListener('blur', handlers.onLeave);
  row.addEventListener('click', () => handlers.onPick(group, index));

  return row;
}

// ── Category chips ───────────────────────────────────────────────────────────

/** One chip. Pressed means hidden — the chip is the filter, not the contents. */
export interface ChipModel {
  category: HideableCategory;
  label: string;
  title: string;
  count: number;
  hidden: boolean;
}

/**
 * A chip per category *present in this pick*.
 *
 * A category with no members is omitted rather than drawn as a dead `0`: five
 * chips above a two-component tree is a row of controls that mostly do nothing,
 * and the ones that do are harder to find among them.
 */
export function chipModels(items: PickedComponent[], hidden: HiddenCategories): ChipModel[] {
  const counts = countByCategory(items);

  return HIDEABLE_CATEGORIES.filter((category) => counts[category] > 0).map((category) => ({
    category,
    label: CATEGORY_LABELS[category],
    title: `${CATEGORY_DESCRIPTIONS[category]} — click to ${hidden[category] ? 'show' : 'hide'}`,
    count: counts[category],
    hidden: hidden[category],
  }));
}

export function categoryChip(model: ChipModel, onToggle: (c: HideableCategory) => void): HTMLElement {
  const chip = make('button', 'chip');
  chip.type = 'button';
  // Selects the per-category tint in result.css, and is how a test finds one.
  chip.dataset.category = model.category;
  chip.setAttribute('aria-pressed', String(model.hidden));
  chip.title = model.title;

  chip.append(make('span', undefined, model.label), make('span', 'chip-count', String(model.count)));
  chip.addEventListener('click', () => onToggle(model.category));
  return chip;
}

// ── Source preview ───────────────────────────────────────────────────────────

/** One line of the preview. `number` is 1-based, because a person reads it. */
export interface PreviewLine {
  number: number;
  text: string;
  active: boolean;
}

/** Lines either side of the target that the preview shows. */
export const PREVIEW_RADIUS = 4;

/**
 * The window of original source to show around a resolved position.
 *
 * The map's line is `Pos0` and every number this returns is `Pos1`, converted
 * through the one bridge (CONTRACTS §1). Nothing here does arithmetic on a
 * position it did not first put across that bridge — the gutter numbers being
 * one off is exactly the silent, plausible-looking wrongness the brands exist to
 * prevent, and it is the kind a screenshot would never settle.
 */
export function previewLines(content: string, line: Pos0): PreviewLine[] {
  const lines = content.split('\n');
  const target = toOneBased(line);

  const from = Math.max(1, target - PREVIEW_RADIUS);
  const to = Math.min(lines.length, target + PREVIEW_RADIUS);

  const window: PreviewLine[] = [];
  for (let number = from; number <= to; number++) {
    window.push({ number, text: lines[number - 1] ?? '', active: number === target });
  }
  return window;
}

export function previewBlock(lines: PreviewLine[]): DocumentFragment {
  const frag = document.createDocumentFragment();

  for (const line of lines) {
    const row = make('span', line.active ? 'preview-line preview-line-active' : 'preview-line');
    row.append(make('span', 'preview-gutter', String(line.number)), line.text);
    frag.append(row);
  }

  return frag;
}

// ── The ambiguity warning ────────────────────────────────────────────────────

/**
 * The card's copy of a source, with the ambiguity warning taken off it.
 *
 * `resultCard` draws its own warning whenever `matchCount > 1`, which is right
 * on the popup and in the flow review, where the card is the whole surface. In
 * the panel the card is followed by a filter row, a preview and two trees, and
 * the caveat has to sit at the top of that column where it is read *before* the
 * file is opened — which is where `#ambiguity-warning` is, and why it is the
 * dismissible one. Two identical banners four inches apart is the alternative.
 *
 * `matchCount` is data and it is not being discarded: the panel composes the
 * same sentence from the same exported `ambiguityText`, so there is still one
 * wording of it in the product.
 */
export function withoutAmbiguity(source: ComponentSource): ComponentSource {
  if ((source.matchCount ?? 0) <= 1) return source;
  const rest = { ...source };
  delete rest.matchCount;
  return rest;
}
