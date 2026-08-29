/**
 * The Settings screen's entire visual vocabulary.
 *
 * Eight primitives — `settingRow`, `groupHeader`, `appBar`, `searchRow`,
 * `banner`, `emptyState`, `changeList`, `jsonPane` — and the frame that
 * arranges them. **Nothing else in the settings page creates a DOM node**, and
 * `npm run lint:settings-ui` fails the build if anything tries.
 *
 * Six of them are Session 1's. Session 3 added the last two, and both were
 * added the way the rule says to add one: `changeList` because the reset-all
 * dialog and the import diff are the same list of *setting · current →
 * incoming* and were about to become two, and `jsonPane` because the `{}` view
 * has two panes on the day it ships — the generated defaults and the user's
 * overrides — which is a primitive with two callers rather than a one-off with
 * one.
 *
 * That rule is the mechanism, not an instruction. Sixty controls arrive across
 * six more sessions, and asking each of them to match the others does not work:
 * session five cannot see session two's judgement calls, and by then there is no
 * single version to match. So the later sessions are given nothing to render
 * with — they append an entry to `fields.ts` and this file draws it. There is no
 * code path that can invent a second kind of group header, because there is one
 * `groupHeader` and it takes a heading.
 *
 * A phase that needs something these cannot express has found a real gap:
 * **widen the primitive, here, for everyone.** Never render around it locally.
 * A one-off is invisible in review, ships fine, and is discovered when somebody
 * opens two groups side by side.
 *
 * ### The row is the same object
 *
 * The design rests on the setting row being the same object every time.
 * It is the same object here in the literal sense: every slot — gutter, title,
 * key line, control, unit, action, reset, description, note, consequence — is
 * always in the DOM, and state hides it. Presence never depends on the value,
 * so the structural signature of all seventy-three rows is identical modulo the
 * control, which is what `tests/settings-row-shape.test.ts` asserts.
 */

import { consequenceApplies, type Field } from '../../features/settings/index.js';
import { EDITORS } from '../../core/react/editor.js';
import { icon, type IconName } from '../icons.js';
import {
  DEFAULTS_PANE,
  OVERRIDES_PANE,
  PANES_NOTE,
  UNKNOWN_LINE_NOTE,
  type ImportView,
} from './file-view.js';
import {
  ADVANCED_NOTE,
  ADVANCED_WARNING,
  clampedNote,
  defaultLabel,
  highlight,
  RECORDING_NOTE,
  rangeNote,
  type ChangeRow,
  type Filter,
  type RowModel,
  type SettingsModel,
} from './view.js';

// ── Element plumbing ─────────────────────────────────────────────────────────

/**
 * The one place an element is made.
 *
 * Every class name in the product's settings page passes through this call,
 * which is what makes "no settings markup outside components.ts" checkable by
 * grep rather than by review.
 */
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

/** Text with the search query marked in it. Always segments, even with no query. */
function marked(text: string, query: string): (HTMLElement | Text)[] {
  return highlight(text, query).map((segment) =>
    segment.match
      ? make('mark', 'hl', segment.text)
      : document.createTextNode(segment.text),
  );
}

function iconButton(
  name: IconName,
  label: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = make('button', className);
  button.type = 'button';
  button.setAttribute('aria-label', label);
  button.title = label;
  button.append(icon(name));
  button.addEventListener('click', onClick);
  return button;
}

function labelledButton(
  name: IconName | null,
  label: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = make('button', className);
  button.type = 'button';
  if (name) button.append(icon(name));
  button.append(make('span', undefined, label));
  button.addEventListener('click', onClick);
  return button;
}

// ── 1. appBar ────────────────────────────────────────────────────────────────

/** One row of the overflow menu, or the hairline between two groups of them. */
export type MenuEntry =
  | 'rule'
  | {
      readonly label: string;
      readonly icon: IconName;
      /** The one destructive entry. The trigger is never the danger colour… */
      readonly danger?: boolean;
      readonly disabled?: boolean;
      /** Why it is disabled, said in twelve words under the row. */
      readonly note?: string;
      readonly onSelect: () => void;
    };

export interface AppBarOptions {
  readonly title: string;
  readonly onBack: () => void;
  /**
   * The one control that belongs in the middle of the bar, if there is one.
   *
   * A slot rather than a search box, because the bar should not know what a
   * search box is — it knows there is a lead, a centre and a set of actions, and
   * `settingsPage` decides that the centre is where the search field lives.
   */
  readonly centre?: HTMLElement;
  /** The `{}` JSON toggle. A toggle, so it says which of the two it is on. */
  readonly json: {
    readonly label: string;
    readonly onToggle: () => void;
  };
  readonly menu: readonly MenuEntry[];
}

export interface AppBarState {
  readonly jsonOpen: boolean;
}

interface AppBar {
  readonly element: HTMLElement;
  readonly update: (state: AppBarState) => void;
}

/**
 * `← Flows`, the mark, the title; on the right the `{}` toggle and the overflow.
 *
 * The bar spans the window — its hairline is the edge of the chrome — but its
 * contents sit in the page's frame, so the mark is directly above the page title
 * rather than out at the window's edge. That is the shared `.appbar`, and this
 * screen wears it unchanged.
 */
export function appBar(options: AppBarOptions): AppBar {
  const bar = make('header', 'appbar');

  /*
   * Three zones, not a row of things.
   *
   * With a centre slot the bar becomes a grid — lead, centre, actions — because
   * the centre has to be centred *in the bar*, and a flex row can only centre it
   * in whatever space the two groups leave. Those groups are not the same width
   * (`← Flows` and the mark against two buttons), so the field would sit visibly
   * off to one side, which is worse than not centring it at all.
   *
   * The lead is wrapped for the same reason: a grid needs three children to have
   * three columns, and the back button and the brand are one thing.
   */
  const inner = make('div', options.centre ? 'appbar__inner appbar__inner--split' : 'appbar__inner');

  const lead = make('div', 'appbar__lead');
  const back = labelledButton('arrow-left', 'Flows', 'btn btn--ghost', options.onBack);
  lead.append(back);

  const brand = make('div', 'brand');
  brand.append(mark(), make('h1', 'brand__name', options.title));
  lead.append(brand);
  inner.append(lead);

  if (options.centre) {
    const centre = make('div', 'appbar__centre');
    centre.append(options.centre);
    inner.append(centre);
  }

  const actions = make('div', 'appbar__actions');

  const json = labelledButton(
    'braces',
    options.json.label,
    'btn btn--secondary appbar__json',
    options.json.onToggle,
  );
  // A toggle, not a link: `aria-pressed` is what tells a screen reader which of
  // the two views is on, and it is also what the pressed styling hangs off, so
  // the two cannot come apart.
  json.setAttribute('aria-pressed', 'false');
  actions.append(json);

  actions.append(overflow(options.menu));
  inner.append(actions);
  bar.append(inner);

  const update = (state: AppBarState): void => {
    json.setAttribute('aria-pressed', String(state.jsonOpen));
    json.title = state.jsonOpen ? 'Back to the settings list' : 'Edit these settings as JSON';
  };

  update({ jsonOpen: false });
  return { element: bar, update };
}

/**
 * The product mark, drawn rather than linked.
 *
 * Filled from CSS: a custom property in an SVG presentation attribute is not
 * resolved by any shipping browser, so `fill="var(--accent)"` renders black.
 */
function mark(): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'brand__mark');
  svg.setAttribute('viewBox', '0 0 20 20');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  svg.innerHTML =
    '<rect class="brand__mark-plate" width="20" height="20" rx="6"/>' +
    '<path class="brand__mark-bolt" d="M11.4 3.4 5.9 11h3.2l-.5 5.6L14.1 9h-3.2z"/>';
  return svg;
}

function overflow(entries: readonly MenuEntry[]): HTMLElement {
  const wrap = make('div', 'menu');
  const panel = make('div', 'menu__panel');
  panel.hidden = true;

  const button = iconButton('ellipsis', 'More settings actions', 'btn btn--ghost btn--icon', () => {
    panel.hidden = !panel.hidden;
    button.setAttribute('aria-expanded', String(!panel.hidden));
  });
  button.setAttribute('aria-expanded', 'false');
  button.setAttribute('aria-haspopup', 'menu');

  for (const entry of entries) {
    if (entry === 'rule') {
      panel.append(make('hr', 'menu__rule'));
      continue;
    }

    const item = labelledButton(
      entry.icon,
      entry.label,
      entry.danger ? 'menu__item menu__item--danger' : 'menu__item',
      () => {
        panel.hidden = true;
        button.setAttribute('aria-expanded', 'false');
        entry.onSelect();
      },
    );
    item.disabled = entry.disabled === true;
    panel.append(item);

    // Always present, so a phase that disables an entry has somewhere to say
    // why rather than leaving a grey row with no explanation.
    const note = make('p', 'menu__note', entry.note ?? '');
    note.hidden = !entry.note;
    panel.append(note);
  }

  // Anywhere else closes it. Menus that only close on their own button are how
  // you end up with two of them open at once.
  document.addEventListener('click', (event) => {
    if (panel.hidden) return;
    if (wrap.contains(event.target as Node)) return;
    panel.hidden = true;
    button.setAttribute('aria-expanded', 'false');
  });

  wrap.append(button, panel);
  return wrap;
}

// ── 2. searchRow ─────────────────────────────────────────────────────────────

export interface SearchState {
  readonly text: string;
  readonly filters: readonly Filter[];
  /**
   * `null` hides the results line entirely: the count and the chips appear
   * "only when a query or filter is active".
   */
  readonly results: { readonly count: number; readonly modified: number } | null;
}

export interface SearchHandlers {
  /** The raw field contents, before filter tokens are lifted out of them. */
  readonly onQuery: (raw: string) => void;
  readonly onRemoveFilter: (filter: Filter) => void;
  readonly onResetShown: () => void;
}

interface SearchRow {
  /** The box with the magnifier in it. Lives in the middle of the app bar. */
  readonly field: HTMLElement;
  /** What the query found, and the chips. Its own strip, under the bar. */
  readonly results: HTMLElement;
  readonly input: HTMLInputElement;
  readonly update: (state: SearchState) => void;
}

/**
 * The search. Two pieces, in two places, because they are wanted at different
 * times.
 *
 * It used to be one band under the app bar: a full-width field with the results
 * line under it, sixty-four pixels of chrome on every load whether or not
 * anybody was searching. Two things were wrong with that. The field was as wide
 * as the window for a query like `maxSteps` — a control out of all proportion to
 * what is typed into it, which reads as a band across the page rather than as a
 * box you type in. And it was the *second* row of chrome under a bar that had a
 * few hundred empty pixels down its middle.
 *
 * So the field moves into that empty middle, capped at a width a query actually
 * needs, which is where a settings page is expected to keep it. §4's point
 * survives the move — it is still the widest control on the screen and the first
 * thing under the cursor — and the page gets its sixty-four pixels back.
 *
 * The results line does not go with it. `4 settings`, the filter chips and
 * `Reset all 1 shown` are a sentence, they only exist while a query is on, and
 * a sentence does not fit in a bar. It keeps the full-width strip, which now
 * appears only when there is something to say in it.
 *
 * Built once and updated, rather than rebuilt: the field is where the caret is
 * while the rest of the page is re-rendering under it, and an input element that
 * is replaced between keystrokes loses both the caret and the composition.
 */
export function searchRow(state: SearchState, handlers: SearchHandlers): SearchRow {
  const field = make('div', 'search__field');
  const glass = icon('search', 'icon search__icon');
  const input = make('input', 'search__input');
  input.type = 'search';
  input.placeholder = 'Search settings';
  input.setAttribute('aria-label', 'Search settings');
  input.spellcheck = false;
  input.autocomplete = 'off';
  input.addEventListener('input', () => handlers.onQuery(input.value));
  field.append(glass, input);

  const element = make('div', 'search');
  const frame = make('div', 'search__frame');
  const results = make('div', 'search__results');
  const count = make('span', 'search__count');
  const chips = make('div', 'search__chips');
  const actions = make('div', 'search__actions');
  results.append(count, chips, actions);

  frame.append(results);
  element.append(frame);

  const update = (next: SearchState): void => {
    // Only when it differs: assigning an identical value still collapses the
    // selection in Chrome, which eats a double-click on the field's own text.
    if (input.value !== next.text) input.value = next.text;

    /*
     * The strip, not the line inside it.
     *
     * The two used to be the same element, because the band around it was also
     * the field's. Now the band is the strip's alone: leaving it in the document
     * with an empty line inside would put a hairline and its padding under the
     * app bar on every page load, which is most of what moving the field out was
     * for.
     */
    element.hidden = next.results === null;
    results.hidden = next.results === null;
    if (!next.results) {
      chips.replaceChildren();
      actions.replaceChildren();
      return;
    }

    count.textContent =
      next.results.count === 1 ? '1 setting' : `${next.results.count} settings`;

    chips.replaceChildren(
      ...next.filters.map((filter) => filterChip(filter, () => handlers.onRemoveFilter(filter))),
    );

    // `@modified` is "the what did I change query", and the one action that
    // belongs to a set of changed rows is undoing them.
    actions.replaceChildren();
    if (next.results.modified > 0) {
      actions.append(
        labelledButton(
          'rotate-ccw',
          `Reset all ${next.results.modified} shown`,
          'btn btn--ghost btn--compact',
          handlers.onResetShown,
        ),
      );
    }
  };

  update(state);
  return { field, results: element, input, update };
}

function filterChip(filter: Filter, onRemove: () => void): HTMLElement {
  const chip = make('span', 'filter-chip');
  chip.append(make('span', undefined, filter));
  chip.append(iconButton('x', `Remove the ${filter} filter`, 'filter-chip__remove', onRemove));
  return chip;
}

// ── 3. groupHeader ───────────────────────────────────────────────────────────

export interface Heading {
  readonly title: string;
  readonly description: string;
}

/**
 * There is one of these.
 *
 * Not one per tab, not a variant for search results and another for Advanced.
 * The generated Stitch screens carry that drift — the same section wears a
 * different header from one tab to the next — and a single function is the only
 * thing that actually prevents it, because there is then nowhere for a second
 * treatment to live.
 */
export function groupHeader(heading: Heading, query = ''): HTMLElement {
  const head = make('header', 'group__head');
  const title = make('h2', 'group__title');
  title.append(...marked(heading.title, query));
  const note = make('p', 'group__note');
  note.append(...marked(heading.description, query));
  head.append(title, note);
  return head;
}

// ── 4. settingRow ────────────────────────────────────────────────────────────

export type NoteTone = 'muted' | 'danger' | 'success' | 'busy';

export interface RowNote {
  readonly text: string;
  readonly tone: NoteTone;
}

/** A button beside the control — "Test connection", and whatever Phase 4 needs. */
export interface RowAction {
  readonly label: string;
  readonly icon: IconName;
  readonly busy: boolean;
}

export interface RowState {
  readonly value: unknown;
  readonly modified: boolean;
  readonly disabled: boolean;
  /** The one line under the control: a range, a clamp, a result, a reason. */
  readonly note: RowNote | null;
  readonly action: RowAction | null;
  /** Free text to mark in the title, description and key. */
  readonly query: string;
}

export interface RowHandlers {
  /** A committed value, already the field's own type, plus what a clamp did. */
  readonly onCommit: (field: Field, value: unknown, clamped: RowNote | null) => void;
  readonly onReset: (field: Field) => void;
  readonly onCopyKey: (field: Field) => void;
  readonly onAction: (field: Field) => void;
}

/**
 * One setting. The whole design.
 *
 * ```
 * │  Stop recording after N steps                            [  500  ] ⟲
 * │  recording.maxSteps · default 500
 *    A long QA pass legitimately exceeds it; someone else wants a hard 50.
 * ```
 *
 * Every slot is always here. A row with nothing to say in its note still has the
 * note element, hidden — because the alternative is that the row's shape depends
 * on its state, and then "the same object sixty times" is a thing you can only
 * check by looking.
 */
export function settingRow(field: Field, state: RowState, handlers: RowHandlers): HTMLElement {
  const root = make('div', 'setting-row');
  root.dataset.key = field.key;
  root.dataset.modified = String(state.modified);
  root.dataset.disabled = String(state.disabled);
  root.dataset.invalid = 'false';

  root.append(make('div', 'setting-row__gutter'));

  const body = make('div', 'setting-row__body');
  const head = make('div', 'setting-row__head');

  // ── title and key line
  const text = make('div', 'setting-row__text');
  const title = make('span', 'setting-row__title');
  title.append(...marked(field.title, state.query));

  const meta = make('p', 'setting-row__meta');
  const key = make('button', 'setting-row__key');
  key.type = 'button';
  key.title = `Copy ${field.key}`;
  key.append(...marked(field.key, state.query));
  key.addEventListener('click', () => handlers.onCopyKey(field));
  meta.append(key, make('span', 'setting-row__default', `· ${defaultLabel(field)}`));

  text.append(title, meta);

  // ── control, unit, action, reset
  const control = make('div', 'setting-row__control');
  const note = make('p', 'setting-row__note');
  const built = buildControl(field, state, handlers, root, note);
  control.append(...built.nodes);

  const unit = make('span', 'setting-row__unit', built.unit);
  unit.hidden = built.unit === '';
  // A number wears its unit inside the field, so `500 steps` reads as one
  // control rather than a box with a word floating after it; every other type
  // has no unit and the empty span stays where it always was.
  (built.unitHost ?? control).append(unit);

  const action = labelledButton(
    state.action?.icon ?? 'refresh-cw',
    state.action?.label ?? '',
    'btn btn--secondary btn--compact setting-row__action',
    () => handlers.onAction(field),
  );
  action.hidden = state.action === null;
  action.disabled = state.action?.busy === true || state.disabled;
  control.append(action);

  /*
   * §4's reset — inside the control group, and out of the layout.
   *
   * It was the last item in this flex row, `visibility: hidden` until the row
   * was hovered. That reserved a 28px lane beside all seventy-three controls
   * for a button that can only ever do something on the handful that are
   * modified, and the reserved lane was the page: every value stopped the same
   * distance short of the right edge with a column of nothing beside it.
   *
   * Taking it out of the flow costs nothing on the rows that never show it and
   * moves nothing on the rows that do. It is absolutely positioned under the
   * control it undoes, in the band the description never reaches — so the
   * moment a value is changed the button appears there, and not one pixel of
   * the row it appeared in has moved.
   *
   * Still in the DOM at rest, disabled, like every other slot: the row is the
   * same object whether or not anything in it has been changed.
   */
  const reset = labelledButton('rotate-ccw', 'Reset', 'setting-row__reset', () =>
    handlers.onReset(field),
  );
  reset.setAttribute('aria-label', `Reset ${field.title} to its default`);
  reset.title = `Reset ${field.title} to its default`;
  reset.disabled = !state.modified;
  control.append(reset);

  head.append(text, control);

  // ── description, note, consequence
  const description = make('p', 'setting-row__description');
  description.append(...marked(field.description, state.query));

  note.textContent = state.note?.text ?? '';
  note.dataset.tone = state.note?.tone ?? 'muted';
  note.hidden = state.note === null;

  const consequence = banner('warn', field.consequence ?? '');
  consequence.classList.add('setting-row__consequence');
  consequence.hidden = !consequenceApplies(field, state.value, state.modified);

  body.append(head, description, note, consequence);
  root.append(body);
  return root;
}

interface BuiltControl {
  readonly nodes: readonly HTMLElement[];
  /** Rendered beside the input; `''` for the types that have no unit. */
  readonly unit: string;
  /**
   * Where the unit span is appended, when the control wants it inside itself
   * rather than after it. One caller — the number field, which owns its unit —
   * and it is a slot on the primitive rather than a special case in the row, so
   * the next type that wants the same has it already.
   */
  readonly unitHost?: HTMLElement;
}

/**
 * The control, and the only thing about a row that differs between fields.
 *
 * Five shapes for the five types in `fields.ts` — boolean, number, enum, string,
 * levels. A sixth is a failure, and the row-shape test is what says so.
 */
function buildControl(
  field: Field,
  state: RowState,
  handlers: RowHandlers,
  root: HTMLElement,
  note: HTMLElement,
): BuiltControl {
  switch (field.type) {
    case 'boolean': {
      const wrap = make('label', 'switch');
      const input = make('input', 'switch__input');
      input.type = 'checkbox';
      input.checked = state.value === true;
      input.disabled = state.disabled;
      input.dataset.focus = field.key;
      input.setAttribute('aria-label', field.title);
      input.addEventListener('change', () => handlers.onCommit(field, input.checked, null));
      wrap.append(input);
      return { nodes: [wrap], unit: '' };
    }

    case 'number': {
      /*
       * A field, not a bare `<input type=number>`.
       *
       * The bare input drew the platform's spinner inside the box: two stacked
       * arrows in the OS's own style, which on this page is the one control
       * that did not look like it belonged to the product — and which sat on
       * top of the digits at this width. The shell keeps everything the input
       * was doing, hides the spinner, and takes the border and the focus ring
       * itself, so the unit can live inside the same box as the number.
       *
       * ↑/↓ still step the value: that is the input's behaviour, not the
       * spinner's, and it survives `appearance: none`.
       */
      const wrap = make('div', 'numfield');
      const input = make('input', 'numfield__input');
      input.type = 'number';
      input.value = String(state.value);
      input.min = String(field.min);
      input.max = String(field.max);
      input.step = field.fractional ? 'any' : '1';
      input.disabled = state.disabled;
      input.dataset.focus = field.key;
      input.setAttribute('aria-label', field.title);
      /*
       * The box is as wide as the widest value the field can hold.
       *
       * It was a flat 104px, which fits every number in the table except the
       * ones measured in bytes: the shipped 2 GB retention cap rendered as
       * `214748364` — the last digit outside the box, with nothing to say it
       * had been cut. A number you cannot read in full is worse than an empty
       * one, because it still looks like an answer.
       *
       * A custom property rather than a second class, deliberately. The row is
       * the same object seventy-three times and there is one control per type, so
       * an `.input--number-wide` on some rows would be a sixth shape that
       * `settings-row-shape.test.ts` would be right to fail. Widening the
       * primitive for everyone is the fix that test asks for, and every field
       * whose maximum already fits keeps the width it had — see `min-width`.
       */
      input.style.setProperty('--field-chars', String(String(field.max).length));

      /*
       * Invalid input does not block typing and is not silently corrected.
       *
       * Handled here rather than by re-rendering the page on every keystroke —
       * the row marks itself, keeps the characters the user typed, and only
       * `resolve()` decides what the value actually becomes, at commit.
       */
      input.addEventListener('input', () => {
        const parsed = Number(input.value);
        const bad =
          input.value.trim() !== '' &&
          (!Number.isFinite(parsed) || parsed < field.min || parsed > field.max);
        root.dataset.invalid = String(bad);
        note.hidden = !bad;
        note.dataset.tone = 'danger';
        note.textContent = bad ? rangeNote(field) : '';
      });

      input.addEventListener('change', () => {
        const parsed = Number(input.value);
        const usable = input.value.trim() !== '' && Number.isFinite(parsed);
        const wanted = usable ? (field.fractional ? parsed : Math.round(parsed)) : field.default;
        const value = Math.min(field.max, Math.max(field.min, wanted));

        root.dataset.invalid = 'false';
        input.value = String(value);
        // It clamps on commit, and says what it clamped to.
        handlers.onCommit(field, value, value === wanted ? null : {
          text: clampedNote(field, value),
          tone: 'danger',
        });
      });

      wrap.append(input);
      return { nodes: [wrap], unit: field.unit ?? '', unitHost: wrap };
    }

    case 'enum': {
      return { nodes: [select(field, state, handlers)], unit: '' };
    }

    case 'string': {
      const input = make('input', 'input input--mono input--text');
      input.type = 'text';
      input.value = typeof state.value === 'string' ? state.value : field.default;
      input.disabled = state.disabled;
      input.spellcheck = false;
      input.autocomplete = 'off';
      input.dataset.focus = field.key;
      input.setAttribute('aria-label', field.title);
      if (field.maxLength !== undefined) input.maxLength = field.maxLength;
      input.addEventListener('change', () => {
        const trimmed = input.value.trim();
        input.value = trimmed;
        handlers.onCommit(field, trimmed, null);
      });
      return { nodes: [input], unit: '' };
    }

    case 'levels': {
      const wrap = make('div', 'levels');
      const chosen = Array.isArray(state.value) ? (state.value as string[]) : [...field.default];
      for (const option of field.options) {
        const on = chosen.includes(option);
        const button = make('button', 'levels__option');
        button.type = 'button';
        button.dataset.focus = `${field.key}:${option}`;
        button.setAttribute('aria-pressed', String(on));
        button.disabled = state.disabled;
        button.append(icon('check'), make('span', undefined, option));
        button.addEventListener('click', () => {
          const next = field.options.filter((entry) =>
            entry === option ? !on : chosen.includes(entry),
          );
          handlers.onCommit(field, next, null);
        });
        wrap.append(button);
      }
      return { nodes: [wrap], unit: '' };
    }
  }
}

/**
 * The enum control: a listbox this file draws, not the one the browser draws.
 *
 * A `<select>` is the correct element and it was the wrong control here. Chrome
 * renders its open state as an operating-system menu — the platform's font, the
 * platform's corner radius, the platform's tick — positioned *over* the trigger
 * rather than under it, so choosing a theme covered up the row you were reading
 * and looked like it came from a different application. None of that is
 * styleable, which is why every design system that cares ships its own.
 *
 * So: a button that says what is chosen, and a panel of options under it. The
 * roles are the ones a native select reports (`combobox` over `listbox` over
 * `option`), the keys are the ones a native select answers to, and the panel
 * closes on Escape, on Tab, and on a press anywhere outside it.
 *
 * The listener for that last one is added when the panel opens and removed when
 * it closes, never at build time. The list is rebuilt wholesale on every render
 * — a keystroke in the search box is a new set of rows — and a document-level
 * listener registered per control would accumulate one copy per render, each
 * holding a detached row alive. `close` is the only way out of the open state,
 * and it is what removes it.
 */
function select(
  field: Extract<Field, { readonly type: 'enum' }>,
  state: RowState,
  handlers: RowHandlers,
): HTMLElement {
  const chosen = typeof state.value === 'string' ? state.value : field.default;

  const wrap = make('div', 'select');
  wrap.dataset.open = 'false';
  // Which way the panel opens. Decided when it opens, from the room actually
  // below the trigger — a row near the bottom of a long page has none.
  wrap.dataset.drop = 'down';

  const trigger = make('button', 'select__trigger');
  trigger.type = 'button';
  trigger.disabled = state.disabled;
  trigger.dataset.focus = field.key;
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', field.title);
  trigger.append(
    make('span', 'select__value', optionLabel(chosen)),
    icon('chevron-down', 'icon select__chevron'),
  );

  const panel = make('div', 'select__panel');
  panel.hidden = true;
  panel.setAttribute('role', 'listbox');
  panel.setAttribute('aria-label', field.title);

  /* Anywhere outside closes it — including a press on a row that no longer
   * exists, which is what the `isConnected` arm is for: a render that replaced
   * this control while its panel was open leaves the listener behind, and this
   * is where it takes itself off. */
  const onOutside = (event: Event): void => {
    if (wrap.isConnected && wrap.contains(event.target as Node)) return;
    close(false);
  };

  function open(): void {
    if (!panel.hidden || trigger.disabled) return;
    panel.hidden = false;
    wrap.dataset.open = 'true';
    trigger.setAttribute('aria-expanded', 'true');

    // Measured after it is visible, because the panel's height is the thing
    // being asked about and a hidden element does not have one.
    const box = trigger.getBoundingClientRect();
    const height = panel.offsetHeight;
    const gap = 12;
    const fitsBelow = window.innerHeight - box.bottom >= height + gap;
    wrap.dataset.drop = fitsBelow || box.top < height + gap ? 'down' : 'up';

    document.addEventListener('pointerdown', onOutside, true);
    (options.find((option) => option.dataset.value === chosen) ?? options[0])?.focus();
  }

  function close(refocus = true): void {
    if (panel.hidden) return;
    panel.hidden = true;
    wrap.dataset.open = 'false';
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    if (refocus) trigger.focus();
  }

  const options = field.options.map((option) => {
    const item = make('button', 'select__option');
    item.type = 'button';
    // Reached with the arrow keys, not with Tab: the panel is one stop.
    item.tabIndex = -1;
    item.dataset.value = option;
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(option === chosen));
    item.append(
      icon('check', 'icon select__check'),
      make('span', 'select__label', optionLabel(option)),
    );
    item.addEventListener('click', () => {
      /*
       * Back to the trigger before the commit, not after it.
       *
       * The commit rebuilds the list, and `focusKey` reads `document.activeElement`
       * to decide what to put focus back on. The option that was just pressed is
       * about to stop existing and carries no `data-focus`, so leaving focus on
       * it means a keyboard user picks a theme and lands at the top of the
       * document. Focusing the trigger first makes the row the thing that is
       * restored, which is where they already were.
       */
      close();
      handlers.onCommit(field, option, null);
    });
    panel.append(item);
    return item;
  });

  trigger.addEventListener('click', () => {
    if (panel.hidden) open();
    else close();
  });

  wrap.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (panel.hidden) return;
      // Otherwise the page's own Escape handler reads it as "leave settings".
      event.stopPropagation();
      close();
      return;
    }

    // Focus goes back to the trigger and Tab's own default carries on from
    // there, so the next stop is the control after this one rather than the top
    // of the page — which is where hiding the focused option would leave it.
    if (event.key === 'Tab') {
      close();
      return;
    }

    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 && event.key !== 'Home' && event.key !== 'End') return;

    // Arrows move through the options rather than scrolling the page under them.
    event.preventDefault();
    if (panel.hidden) {
      open();
      return;
    }

    const at = options.indexOf(document.activeElement as HTMLButtonElement);
    const to =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? options.length - 1
          : Math.min(options.length - 1, Math.max(0, at + step));
    options[to]?.focus();
  });

  /*
   * Typeahead, because the control it replaces had it.
   *
   * A `<select>` jumps to the next option starting with the letter you press,
   * and nine editors is exactly the length where somebody types `w` rather than
   * pressing Down five times. One letter, from wherever the highlight is, so
   * pressing the same letter again cycles through the options that share it.
   */
  wrap.addEventListener('keypress', (event) => {
    const letter = event.key.toLowerCase();
    if (letter.length !== 1 || letter === ' ' || event.ctrlKey || event.metaKey) return;

    event.preventDefault();
    if (panel.hidden) open();

    const from = options.indexOf(document.activeElement as HTMLButtonElement) + 1;
    const order = [...options.slice(from), ...options.slice(0, Math.max(0, from))];
    order.find((option) => option.textContent?.trim().toLowerCase().startsWith(letter))?.focus();
  });

  wrap.append(trigger, panel);
  return wrap;
}

/**
 * An enum option's label.
 *
 * `fields.ts` holds the option *values*, because those are what the settings
 * file contains; the words a person reads are made here, once, for every enum
 * there will ever be. Editors come from `EDITORS` rather than a list of their
 * own, so this extension and its sibling cannot drift into offering different
 * ones — the same reason the old page built its `<select>` from that table.
 */
function optionLabel(option: string): string {
  if (option in EDITORS) return EDITORS[option].label;
  return option.charAt(0).toUpperCase() + option.slice(1);
}

// ── 5. banner ────────────────────────────────────────────────────────────────

export type BannerKind = 'info' | 'warn' | 'danger' | 'record';

export interface BannerOptions {
  readonly title?: string;
  /** Overrides the kind's own icon. `dot` replaces it with the recording pulse. */
  readonly icon?: IconName;
  readonly dot?: boolean;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}

const BANNER_ICON: Record<BannerKind, IconName> = {
  info: 'info',
  warn: 'triangle-alert',
  danger: 'triangle-alert',
  record: 'circle-dot',
};

/**
 * An inline explanation of the state a surface is in. Not a toast: it stays
 * until the condition it describes is gone.
 *
 * Four intents, and they are separate because the shipped build used one red for
 * "recording", "delete" and "failed" at once — so nothing about a red thing told
 * you which it was.
 */
export function banner(kind: BannerKind, text: string, options: BannerOptions = {}): HTMLElement {
  const root = make('div', `banner banner--${kind}`);

  if (options.dot) root.append(make('span', 'rec-dot'));
  else root.append(icon(options.icon ?? BANNER_ICON[kind], 'icon banner__icon'));

  const body = make('div', 'banner__body');
  if (options.title) body.append(make('p', 'banner__title', options.title));
  body.append(make('p', undefined, text));
  root.append(body);

  if (options.action) {
    root.append(
      labelledButton(
        'chevron-right',
        options.action.label,
        'btn btn--ghost btn--compact banner__action',
        options.action.onClick,
      ),
    );
  }

  return root;
}

// ── 6. emptyState ────────────────────────────────────────────────────────────

/**
 * Never a bare sentence: an icon, what this is, why it is empty, and the one
 * thing to do about it.
 */
export function emptyState(
  name: IconName,
  title: string,
  body: string,
  action?: { readonly label: string; readonly onClick: () => void },
): HTMLElement {
  const root = make('div', 'empty');
  root.append(icon(name, 'icon empty__icon'));
  root.append(make('p', 'empty__title', title));
  root.append(make('p', 'empty__body', body));
  if (action) {
    root.append(labelledButton(null, action.label, 'btn btn--secondary', action.onClick));
  }
  return root;
}

// ── 7. changeList ────────────────────────────────────────────────────────────

/**
 * What is about to change, one line each: *setting · current → incoming*.
 *
 * A count with no list cannot be consented to. "Reset 12 settings" and
 * "Apply 12 settings" are both a number the user has to take on trust unless
 * the twelve are on screen, and the one that matters is always the one they had
 * forgotten they set.
 *
 * One function for both because they are one list. The reset-all dialog had a
 * private version of this shape in Session 1; the import diff was the second
 * caller, which is the moment it stops being a detail of one dialog and becomes
 * a primitive.
 *
 * Every slot is always in the DOM and hidden when empty, for the reason the
 * setting row is built that way: presence that depends on content is a shape
 * you can only check by looking.
 */
export function changeList(rows: readonly ChangeRow[]): HTMLElement {
  const list = make('div', 'change-list');

  for (const row of rows) {
    const item = make('div', 'change-list__row');

    const text = make('div', 'change-list__text');
    text.append(make('span', 'change-list__name', row.name));
    const key = make('span', 'change-list__key', row.key ?? '');
    key.hidden = row.key === undefined;
    text.append(key);
    item.append(text);

    const values = make('div', 'change-list__values');
    const from = make('span', 'change-list__from', row.from);
    // An arrow with nothing on its left points at nothing. A key that does not
    // exist here yet has an incoming value and no current one.
    const arrow = make('span', 'change-list__arrow', '→');
    from.hidden = row.from === '';
    arrow.hidden = row.from === '';
    values.append(from, arrow, make('span', 'change-list__to', row.to));
    item.append(values);

    const note = make('span', 'change-list__note', row.note ?? '');
    note.hidden = row.note === undefined;
    item.append(note);

    list.append(item);
  }

  return list;
}

// ── 8. jsonPane ──────────────────────────────────────────────────────────────

export interface JsonPaneOptions {
  readonly title: string;
  /** The defaults pane is read-only: you cannot override what you cannot see. */
  readonly readOnly: boolean;
  /** `data-focus`, so the caret survives a re-render. Absent on the read-only one. */
  readonly focus?: string;
  readonly onInput?: (text: string) => void;
}

export interface JsonPaneState {
  readonly text: string;
  /** 1-based lines naming a key this version does not have — the warning gutter. */
  readonly warned: readonly number[];
  /** Hovered on each marked line: *not a setting in this version*. */
  readonly warnNote: string;
  /** Top-right of the caption. `''` for a pane with nothing to say about itself. */
  readonly meta: string;
  /**
   * Whether that word is a *state* rather than a standing fact — accent, with
   * the dot the rail uses for the same thing. `read-only` is always true of the
   * left pane and never marked; `edited` is true only right now.
   */
  readonly marked: boolean;
}

export interface JsonPane {
  readonly element: HTMLElement;
  readonly update: (state: JsonPaneState) => void;
}

/**
 * One pane of the `{}` view: a caption, a warning gutter, and the document.
 *
 * The caption is inside the frame, the way an editor puts a filename on the tab
 * above the file rather than in a paragraph beside it. It replaced a
 * `groupHeader` and a two-line description per pane — two of those, side by
 * side, came to a hundred and thirty pixels of ragged text above two editors,
 * arguing with each other for the top of the screen, saying something nobody
 * reads twice. What is left is what a person actually needs at a glance: which
 * pane this is, and whether it is one they can type in.
 *
 * Built once and updated rather than rebuilt, like the search field and for the
 * same reason plus one: the right-hand pane is where the caret is, and it is
 * also where the browser's undo stack for this text lives. A textarea replaced
 * between keystrokes loses both, and losing an undo stack in the one surface
 * whose whole job is hand-editing is not a small thing.
 *
 * The gutter is a scan of the *text*, not of a parsed object, so it still marks
 * the unknown keys while the document is mid-edit and does not parse — which is
 * exactly when a person wants to know which line is the problem.
 */
export function jsonPane(options: JsonPaneOptions, state: JsonPaneState): JsonPane {
  const element = make('section', 'json-pane');
  element.dataset.readonly = String(options.readOnly);

  const frame = make('div', 'json-pane__frame');

  const caption = make('div', 'json-pane__caption');
  caption.append(make('span', 'json-pane__title', options.title));
  const meta = make('span', 'json-pane__meta');
  meta.append(make('span', 'json-pane__dot'), make('span', 'json-pane__word'));
  caption.append(meta);
  frame.append(caption);

  /*
   * The gutter is absolutely positioned, so it needs a box of its own to be
   * absolute inside — otherwise it starts at the top of the frame and its first
   * line numbers run underneath the caption.
   */
  const body = make('div', 'json-pane__body');
  const gutter = make('div', 'json-pane__gutter');
  gutter.setAttribute('aria-hidden', 'true');

  const area = make('textarea', 'json-pane__text');
  area.spellcheck = false;
  area.autocomplete = 'off';
  area.readOnly = options.readOnly;
  area.setAttribute('aria-label', options.title);
  if (options.focus) area.dataset.focus = options.focus;
  if (options.onInput) {
    area.addEventListener('input', () => options.onInput?.(area.value));
  }

  // The gutter is a separate scrolling box beside a scrolling textarea; without
  // this the numbers stay put while the text moves and every one of them is
  // wrong from the first wheel event.
  area.addEventListener('scroll', () => {
    gutter.scrollTop = area.scrollTop;
  });

  body.append(gutter, area);
  frame.append(body);
  element.append(frame);

  const word = meta.querySelector('.json-pane__word');

  const update = (next: JsonPaneState): void => {
    // Only when it differs: assigning an identical value moves the caret to the
    // end, which in an editable pane eats the character being typed.
    if (area.value !== next.text) area.value = next.text;

    if (word) word.textContent = next.meta;
    meta.dataset.marked = String(next.marked);
    meta.hidden = next.meta === '';

    const warned = new Set(next.warned);
    const lines = next.text.split('\n').length;
    const cells: HTMLElement[] = [];

    for (let line = 1; line <= lines; line++) {
      const cell = make('div', 'json-pane__line');
      cell.dataset.warn = String(warned.has(line));
      cell.append(make('span', 'json-pane__num', String(line)));
      const flag = icon('triangle-alert', 'icon json-pane__flag');
      cell.append(flag);
      if (warned.has(line)) cell.title = next.warnNote;
      cells.push(cell);
    }

    gutter.replaceChildren(...cells);
    gutter.scrollTop = area.scrollTop;
  };

  update(state);
  return { element, update };
}

// ── The page ─────────────────────────────────────────────────────────────────
//
// Not a ninth primitive: the arrangement of the eight, plus the rail, the
// storage panel and the two-pane `{}` view. It is here because this is the only
// file that may create a node, and it exposes one function to the controller —
// `render`.

/** What the storage panel shows. Figures, not settings: nothing here is set. */
export interface StorageView {
  readonly used: string;
  readonly detail: string;
  readonly flows: string;
  readonly deletable: boolean;
}

/**
 * The `{}` view: the generated defaults beside the user's sparse overrides.
 *
 * `text` is user-held rather than derived — it is what is in the editable pane
 * right now, which is not the stored overrides the moment somebody types. The
 * controller owns it; this only draws it.
 */
export interface JsonView {
  readonly open: boolean;
  /** The left pane. Constant for the life of the page. */
  readonly defaults: string;
  readonly text: string;
  readonly warned: readonly number[];
  /** Above the pane: how many lines name a key this version does not have. */
  readonly unknownNote: string | null;
  /** Why what is in the pane cannot be applied — a parse failure, naming its line. */
  readonly problem: string | null;
  /** Whether the pane differs from what is stored. Gates both buttons. */
  readonly dirty: boolean;
}

export interface PageProps {
  readonly model: SettingsModel;
  /** Per-row extras the model cannot know: notes, action buttons, busy flags. */
  readonly extras: ReadonlyMap<string, { note: RowNote | null; action: RowAction | null }>;
  readonly recording: boolean;
  /**
   * An import confirmed during a recording is parked, not applied, and
   * the page says so for as long as it is waiting. A promise the user cannot
   * see is a promise they have to remember on the product's behalf.
   */
  readonly pending: string | null;
  readonly storage: StorageView;
  readonly activeRail: string;
  readonly json: JsonView;
}

export interface PageHandlers extends SearchHandlers, RowHandlers {
  readonly onBack: () => void;
  readonly onJson: () => void;
  readonly onImport: () => void;
  readonly onExport: () => void;
  readonly onResetAll: () => void;
  readonly onRail: (id: string) => void;
  readonly onAdvanced: () => void;
  readonly onClearSearch: () => void;
  readonly onDeleteFlows: () => void;
  readonly onOpenFlow: () => void;
  /** Every keystroke in the editable pane. The controller re-scans and repaints. */
  readonly onJsonInput: (text: string) => void;
  /** Import step one's other half: *or paste into the JSON pane*. Same five steps. */
  readonly onJsonApply: () => void;
  readonly onJsonRevert: () => void;
  readonly onCancelPending: () => void;
}

export interface SettingsPage {
  readonly render: (props: PageProps) => void;
}

/**
 * Build the page into `root` and hand back its one update function.
 *
 * The app bar and the search field are made once and kept: they are where the
 * focus is while everything under them is being replaced. Everything else is
 * rebuilt per render, which is cheap at sixty rows and removes a whole class of
 * bug — there is no incremental update path that can leave a row showing last
 * render's value.
 */
export function settingsPage(root: HTMLElement, handlers: PageHandlers): SettingsPage {
  /*
   * One sticky block, not three.
   *
   * The app bar, the search row and the recording banner all have to stay put
   * while the list scrolls under them. Sticking each one separately means giving
   * each a `top` equal to the sum of the heights above it — and the search row's
   * height is not a constant: the results line appears the moment a query or a
   * filter is on. Every offset below it would then be wrong for exactly the
   * states the offsets were written for. Sticking the container instead makes
   * the heights compose themselves, and leaves one number on the page.
   */
  const chrome = make('div', 'chrome');
  root.append(chrome);

  const search = searchRow({ text: '', filters: [], results: null }, handlers);

  const bar = appBar({
    title: 'Settings',
    onBack: handlers.onBack,
    centre: search.field,
    json: { label: 'JSON', onToggle: handlers.onJson },
    menu: [
      { label: 'Import settings…', icon: 'upload', onSelect: handlers.onImport },
      { label: 'Export settings', icon: 'download', onSelect: handlers.onExport },
      'rule',
      {
        label: 'Reset all to defaults',
        icon: 'rotate-ccw',
        danger: true,
        onSelect: handlers.onResetAll,
      },
    ],
  });
  chrome.append(bar.element);
  chrome.append(search.results);

  const recording = make('div', 'recording');
  const recordingFrame = make('div', 'recording__frame');
  recordingFrame.append(
    banner('record', RECORDING_NOTE, {
      dot: true,
      action: { label: 'Open flow', onClick: handlers.onOpenFlow },
    }),
  );
  recording.append(recordingFrame);
  chrome.append(recording);

  /*
   * The parked import, in the same sticky block as the recording banner.
   *
   * Beside it rather than under it because the two are one situation: the
   * recording that is running is the reason the file is waiting, and a person
   * who scrolled past the first would have no idea what the second was about.
   */
  const pending = make('div', 'recording');
  const pendingFrame = make('div', 'recording__frame');
  const pendingBanner = banner('info', '', {
    action: { label: 'Cancel', onClick: handlers.onCancelPending },
  });
  const pendingText = pendingBanner.querySelector('p');
  pendingFrame.append(pendingBanner);
  pending.append(pendingFrame);
  chrome.append(pending);

  const page = make('main', 'settings');
  const body = make('div', 'settings__body');
  const rail = make('nav', 'rail');
  rail.setAttribute('aria-label', 'Setting groups');
  const list = make('div', 'settings__list');
  body.append(rail, list);
  page.append(body);

  const json = jsonView(handlers);
  page.append(json.element);
  root.append(page);

  const render = (props: PageProps): void => {
    const focus = focusKey();

    bar.update({ jsonOpen: props.json.open });

    // The search is gated on a query being possible at all. It searches the
    // rows, and while the `{}` view is on there are none — a box that filtered
    // nothing visible would be a control that had quietly stopped working. The
    // field is in the app bar now, so it is hidden on its own; `update` decides
    // the strip, which has nothing to show under a view with no rows either.
    search.field.hidden = props.json.open;
    search.update({
      text: props.model.query.text,
      filters: props.model.query.filters,
      results: activeResults(props.model),
    });

    recording.hidden = !props.recording;
    pending.hidden = props.pending === null;
    if (pendingText && props.pending) pendingText.textContent = props.pending;

    body.hidden = props.json.open;
    json.element.hidden = !props.json.open;

    /*
     * The `{}` view is a pane layout, not a document.
     *
     * The list is as tall as seventy-three settings and the page scrolls it, so
     * `.settings` is sized by its content. The two JSON panes are the opposite
     * thing: two editors that should be as tall as the window and scroll their
     * own text. Sized by their content, the defaults pane — eighty-two lines —
     * made the *page* scroll, so reading the bottom of it meant scrolling the
     * headings and the Apply button off screen, and the pane beside it was six
     * lines of empty box the whole way down.
     *
     * The attribute is what lets one stylesheet hold both. CSS cannot ask "is
     * the JSON view open"; it can ask what this element says it is.
     */
    page.dataset.json = String(props.json.open);

    if (props.json.open) {
      json.update(props.json);
    } else {
      rail.replaceChildren(...railRows(props, handlers));
      list.replaceChildren(...listBlocks(props, handlers));
    }

    if (props.json.open) search.results.hidden = true;

    restoreFocus(root, focus);
  };

  return { render };
}

interface JsonViewParts {
  readonly element: HTMLElement;
  readonly update: (state: JsonView) => void;
}

/**
 * The two panes: generated defaults on the left, the user's overrides on the
 * right.
 *
 * > Same layout VS Code uses, same reason — you cannot write a sensible
 * > override without seeing what you are overriding.
 *
 * The left pane is `surface-sunk` and read-only because it is not a thing that
 * can be edited: it is generated from the field table at build time, and an
 * editable copy of it would be a second place a default appeared to live.
 *
 * *Apply* goes through the identical five steps a picked file does — parse,
 * validate, resolve, diff, confirm. "Or paste into the JSON pane" belongs in
 * step 1 for exactly this reason: a pane that wrote straight to storage would
 * be a second way in with no diff on it, and the diff is the point of the
 * feature.
 */
function jsonView(handlers: PageHandlers): JsonViewParts {
  const element = make('div', 'json-view');

  /*
   * One line for both panes, where there used to be a paragraph over each.
   *
   * It says the only thing about this screen that is not visible on it: the
   * editable pane is not a way to write straight to storage. Everything else
   * the descriptions carried — which pane is which, which one is read-only —
   * is now two words in each pane's own caption, where it is next to the thing
   * it describes instead of above it.
   */
  element.append(make('p', 'json-view__lede', PANES_NOTE));

  const notes = make('div', 'json-view__notes');
  const unknown = banner('warn', '');
  const unknownText = unknown.querySelector('p');
  const problem = banner('danger', '');
  const problemText = problem.querySelector('p');
  notes.append(unknown, problem);
  element.append(notes);

  const panes = make('div', 'json-view__panes');
  const defaults = jsonPane({ title: DEFAULTS_PANE.title, readOnly: true }, EMPTY_PANE);
  const overrides = jsonPane(
    {
      title: OVERRIDES_PANE.title,
      readOnly: false,
      focus: 'json-overrides',
      onInput: handlers.onJsonInput,
    },
    EMPTY_PANE,
  );
  panes.append(defaults.element, overrides.element);
  element.append(panes);

  const actions = make('div', 'json-view__actions');
  const revert = labelledButton('rotate-ccw', 'Revert', 'btn btn--ghost', handlers.onJsonRevert);
  const apply = labelledButton('check', 'Review and apply', 'btn btn--primary', handlers.onJsonApply);
  actions.append(revert, apply);
  element.append(actions);

  let paintedDefaults = '';

  const update = (state: JsonView): void => {
    // Constant for the life of the page, and long: laid out once.
    if (paintedDefaults !== state.defaults) {
      paintedDefaults = state.defaults;
      defaults.update({
        text: state.defaults,
        warned: [],
        warnNote: '',
        meta: DEFAULTS_PANE.meta,
        marked: false,
      });
    }

    overrides.update({
      text: state.text,
      warned: state.warned,
      warnNote: UNKNOWN_LINE_NOTE,
      /*
       * Said on the pane as well as by the buttons under it. `dirty` is what
       * enables Revert and Apply, and those are at the bottom-right of the
       * screen — a long way from the pane whose state they are about, and the
       * one place a person looks while typing is the box they are typing in.
       */
      meta: state.dirty ? OVERRIDES_PANE.meta : '',
      marked: state.dirty,
    });

    unknown.hidden = state.unknownNote === null;
    if (unknownText && state.unknownNote) unknownText.textContent = state.unknownNote;

    problem.hidden = state.problem === null;
    if (problemText && state.problem) problemText.textContent = state.problem;

    revert.disabled = !state.dirty;
    // A document that does not parse has no diff to show, and offering to
    // review one would open a dialog whose only content is the error already on
    // screen.
    apply.disabled = !state.dirty || state.problem !== null;
  };

  return { element, update };
}

const EMPTY_PANE: JsonPaneState = {
  text: '',
  warned: [],
  warnNote: '',
  meta: '',
  marked: false,
};

function activeResults(model: SettingsModel): SearchState['results'] {
  if (model.query.text === '' && model.query.filters.length === 0) return null;
  return { count: model.shown, modified: model.shownModified.length };
}

function railRows(props: PageProps, handlers: PageHandlers): HTMLElement[] {
  const nodes: HTMLElement[] = [];
  let ruled = false;

  for (const item of props.model.rail) {
    // Advanced sits last, separated by a hairline. Storage joins it there —
    // both are places on the page rather than groups of settings.
    if (item.foot && !ruled) {
      nodes.push(make('hr', 'rail__rule'));
      ruled = true;
    }

    const button = make('button', 'rail__item');
    button.type = 'button';
    button.dataset.rail = item.id;
    button.disabled = item.muted;
    button.dataset.muted = String(item.muted);
    button.setAttribute('aria-current', String(props.activeRail === item.id));
    button.addEventListener('click', () => handlers.onRail(item.id));

    button.append(make('span', 'rail__name', item.title));

    /*
     * The mark: a dot, then a number.
     *
     * §4 asks for the count of modified settings to replace the group's total,
     * and it did that as an accent-filled pill — which put a solid accent
     * circle inside a row whose *selected* state is already a soft accent fill
     * and an accent bar. Three weights of one colour in thirty-six pixels, and
     * the loudest of the three was the least important thing in the row: a
     * filled counter is the shape unread mail uses, and this is not mail.
     *
     * So the number stops shouting and the dot does the saying. Accent text
     * carries the same substitution §4 asks for, the dot is what tells you the
     * number changed meaning — without it, an accent `1` beside a faint `3` is
     * two different quantities distinguished only by colour — and neither
     * competes with the row it is sitting in when that row is the current one.
     */
    const markClass =
      item.mark.kind === 'modified' ? 'rail__mark rail__mark--modified' : 'rail__mark';
    const badge = make('span', markClass);

    const dot = make('span', 'rail__dot');
    dot.hidden = item.mark.kind !== 'modified';
    badge.append(dot);

    if (item.mark.kind === 'chevron') badge.append(icon('chevron-right'));
    else if (item.mark.kind !== 'none') {
      badge.append(make('span', 'rail__count', String(item.mark.count)));
      // The words the dot is short for. The rail has room for a number, not for
      // a sentence, and the sentence is what makes the number unambiguous.
      badge.title =
        item.mark.kind === 'modified'
          ? `${item.mark.count} changed in ${item.title}`
          : `${item.mark.count} in ${item.title}`;
    }

    badge.hidden = item.mark.kind === 'none';
    button.append(badge);

    nodes.push(button);
  }

  return nodes;
}

function listBlocks(props: PageProps, handlers: PageHandlers): HTMLElement[] {
  const { model } = props;

  if (model.body === 'no-matches') {
    return [
      emptyState(
        'search-x',
        model.query.text === ''
          ? 'No setting matches that filter'
          : `No setting matches “${model.query.text}”`,
        'Search covers setting names, descriptions and keys.',
        { label: 'Clear search', onClick: handlers.onClearSearch },
      ),
    ];
  }

  const blocks: HTMLElement[] = [];

  for (const group of model.groups) {
    const section = make('section', 'group');
    section.id = `group-${group.info.id}`;
    section.append(groupHeader(group.info, model.query.text));

    const rows = make('div', 'group__rows');
    rows.append(...group.rows.map((entry) => renderRow(entry, props, handlers)));
    section.append(rows);
    blocks.push(section);
  }

  const advanced = renderAdvanced(props, handlers);
  if (advanced) blocks.push(advanced);

  if (model.showStorage) blocks.push(renderStorage(props, handlers));

  return blocks;
}

function renderRow(entry: RowModel, props: PageProps, handlers: PageHandlers): HTMLElement {
  const extra = props.extras.get(entry.field.key);
  return settingRow(
    entry.field,
    {
      value: entry.value,
      modified: entry.modified,
      disabled: entry.disabled,
      // A dependency's reason is the row's note when nothing more urgent has
      // happened to it — a clamp or a connection result comes from `extras`.
      note: extra?.note ?? (entry.disabledReason ? { text: entry.disabledReason, tone: 'muted' } : null),
      action: extra?.action ?? null,
      query: props.model.query.text,
    },
    handlers,
  );
}

/**
 * The two Advanced states, which are one section with a disclosure.
 *
 * Collapsed it is a single row and a sentence; expanded it is the same rows as
 * everywhere else under a persistent warning. The rows are not a different kind
 * of control — that is the entire point, and it is why there is no second row
 * function for them.
 */
function renderAdvanced(props: PageProps, handlers: PageHandlers): HTMLElement | null {
  const entry = props.model.rail.find((item) => item.id === 'advanced');
  if (!entry) return null;

  const section = make('section', 'advanced');
  section.id = 'group-advanced';

  const summary = make('button', 'advanced__summary');
  summary.type = 'button';
  summary.setAttribute('aria-expanded', String(props.model.advanced.expanded));
  summary.addEventListener('click', handlers.onAdvanced);
  summary.append(icon('chevron-right', 'icon advanced__chevron'));
  summary.append(make('h2', 'group__title', 'Advanced'));
  section.append(summary);

  if (!props.model.advanced.expanded) {
    section.append(make('p', 'advanced__note', ADVANCED_NOTE));
    return section;
  }

  section.append(banner('warn', ADVANCED_WARNING));
  const rows = make('div', 'group__rows');
  rows.append(...props.model.advanced.rows.map((row) => renderRow(row, props, handlers)));
  section.append(rows);
  return section;
}

function renderStorage(props: PageProps, handlers: PageHandlers): HTMLElement {
  const section = make('section', 'storage');
  section.id = 'group-storage';
  section.append(
    groupHeader({
      title: 'Storage',
      description:
        'FlowSnap keeps flows on this machine and nowhere else. There is no size limit — the only ceiling is your disk.',
    }),
  );

  const figures = make('div', 'storage__figures');
  figures.append(make('span', 'storage__used', props.storage.used));
  figures.append(make('span', 'meta', 'held by FlowSnap'));
  section.append(figures);

  const detail = make('p', 'label', props.storage.detail);
  detail.hidden = props.storage.detail === '';
  section.append(detail);

  const row = make('div', 'storage__row');
  const text = make('div', 'storage__text');
  text.append(make('span', 'storage__name', 'Saved flows'));
  text.append(make('span', 'storage__note', props.storage.flows));
  row.append(text);

  const remove = labelledButton(
    'trash-2',
    'Delete all flows',
    'btn btn--ghost',
    handlers.onDeleteFlows,
  );
  remove.disabled = !props.storage.deletable;
  row.append(remove);
  section.append(row);

  return section;
}

// ── Focus across a re-render ─────────────────────────────────────────────────

/**
 * The list is rebuilt wholesale on every change, so the control that caused the
 * change is a different element by the time the render finishes.
 *
 * Every control carries `data-focus`; the value and the caret are read before
 * the replace and put back after it. Without this, committing a value with Tab
 * drops focus to the top of the document, which for a keyboard user is the
 * screen scrolling away from the thing they just changed.
 */
interface FocusMemo {
  readonly key: string;
  readonly start: number | null;
  readonly end: number | null;
}

function focusKey(): FocusMemo | null {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return null;
  const key = active.dataset.focus;
  if (!key) return null;

  // A number input's selection API throws in some browsers and means nothing in
  // any of them; a textarea's is the caret in the JSON pane, which is the one
  // place on this screen somebody is typing a document rather than a value.
  const text =
    active instanceof HTMLTextAreaElement ||
    (active instanceof HTMLInputElement && active.type !== 'number');
  return {
    key,
    start: text ? active.selectionStart : null,
    end: text ? active.selectionEnd : null,
  };
}

function restoreFocus(root: HTMLElement, memo: FocusMemo | null): void {
  if (!memo) return;
  const next = root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(memo.key)}"]`);
  if (!next) return;

  next.focus();
  const selectable = next instanceof HTMLInputElement || next instanceof HTMLTextAreaElement;
  if (selectable && memo.start !== null) next.setSelectionRange(memo.start, memo.end);
}

// ── Dialogs ──────────────────────────────────────────────────────────────────
//
// The shared `.dialog` component, built here because this is the only file that
// may create a node. Escape, focus trapping and the top layer are `<dialog>`'s
// job rather than ours.

export interface ConfirmOptions {
  readonly title: string;
  readonly body: string;
  /** The button names the count and the noun. Never "Confirm" or "OK". */
  readonly confirmLabel: string;
  readonly cancelLabel: string;
  /** What will change, one line each — a count with no list cannot be consented to. */
  readonly changes?: readonly ChangeRow[];
}

export function confirmDialog(
  options: ConfirmOptions,
  onConfirm: () => void,
): HTMLDialogElement {
  const dialog = make('dialog', 'dialog');
  const form = make('form');
  form.method = 'dialog';

  const header = make('div', 'dialog__header');
  header.append(make('h2', 'dialog__title', options.title));

  const body = make('div', 'dialog__body');
  body.append(make('p', undefined, options.body));

  if (options.changes && options.changes.length > 0) body.append(changeList(options.changes));

  const footer = make('div', 'dialog__footer');
  const cancel = make('button', 'btn btn--secondary', options.cancelLabel);
  cancel.type = 'submit';
  cancel.value = 'cancel';
  const confirm = make('button', 'btn btn--danger', options.confirmLabel);
  confirm.type = 'submit';
  confirm.value = 'confirm';
  footer.append(cancel, confirm);

  form.append(header, body, footer);
  dialog.append(form);

  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'confirm') onConfirm();
    dialog.remove();
  });

  return dialog;
}

// ── The import dialog ────────────────────────────────────────────────────────

export interface ImportHandlers {
  /** Confirmed. Applies now, or parks the file when a recording is running. */
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * Import step four, which is the point of the feature.
 *
 * > "Send me your settings file" is how a team gets the same capture
 * > configuration, and a teammate's file quietly halving your screenshot quality
 * > is exactly the *unanswerable question about how a recording was made* that
 * > the freeze exists to prevent.
 *
 * So: every value that would move, named, current beside incoming, clamped ones
 * marked, unknown keys in a list of their own with the reason they are being
 * kept — and no way to reach the apply without having been shown it.
 *
 * Composed entirely from the primitives, which is the whole of this phase's
 * brief: `banner` for the version note, the clamp report and the refusal,
 * `groupHeader` for the two section headings, `changeList` for both lists, and
 * `emptyState` for the empty diff. Nothing here draws anything the settings
 * list does not already draw somewhere else.
 */
export function importDialog(view: ImportView, handlers: ImportHandlers): HTMLDialogElement {
  const dialog = make('dialog', 'dialog dialog--wide');
  const form = make('form');
  form.method = 'dialog';

  const header = make('div', 'dialog__header');
  header.append(make('h2', 'dialog__title', view.title));

  const body = make('div', 'dialog__body');
  if (view.body) body.append(make('p', undefined, view.body));

  /*
   * the refusal first, above everything it applies to.
   *
   * A reason given underneath a list of changes is a reason read after the
   * decision it was meant to inform. This is also why the dialog still shows
   * the diff rather than refusing outright: what the file would do is exactly
   * what somebody deciding whether to defer it needs to know.
   */
  if (view.recordingNote) body.append(banner('warn', view.recordingNote));
  if (view.schemaNote) body.append(banner('info', view.schemaNote));
  if (view.clampNote) body.append(banner('warn', view.clampNote));

  if (view.empty) {
    body.append(emptyState('circle-check', view.empty.title, view.empty.body));
  }

  if (view.changesHeading) {
    const section = make('section', 'dialog__section');
    section.append(groupHeader(view.changesHeading));
    section.append(changeList(view.changes));
    body.append(section);
  }

  if (view.unknownHeading) {
    const section = make('section', 'dialog__section');
    section.append(groupHeader(view.unknownHeading));
    section.append(changeList(view.unknown));
    body.append(section);
  }

  const footer = make('div', 'dialog__footer');
  const cancel = make('button', 'btn btn--secondary', view.cancelLabel);
  cancel.type = 'submit';
  cancel.value = 'cancel';
  footer.append(cancel);

  if (view.confirmLabel) {
    // Not the danger colour. This is an affirmative action with an Undo behind
    // it; the reset-all dialog beside it has neither, and if both wore red the
    // colour would have stopped telling anybody anything.
    const confirm = make('button', 'btn btn--primary', view.confirmLabel);
    confirm.type = 'submit';
    confirm.value = 'confirm';
    footer.append(confirm);
  }

  form.append(header, body, footer);
  dialog.append(form);

  dialog.addEventListener('close', () => {
    if (dialog.returnValue === 'confirm') handlers.onConfirm();
    else handlers.onCancel();
    dialog.remove();
  });

  return dialog;
}

// ── Picking a file ───────────────────────────────────────────────────────────

/**
 * The OS file picker, which is an `<input type="file">` and therefore lives
 * here like every other element on this page.
 *
 * Created per use and discarded: an input kept between picks remembers the last
 * file, so choosing the same file twice in a row fires no `change` event at all
 * and the second import silently does nothing.
 */
export function pickJsonFile(onPicked: (file: File) => void): void {
  const input = make('input', 'sr-only');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.addEventListener('change', () => {
    const file = input.files?.[0];
    input.remove();
    if (file) onPicked(file);
  });
  document.body.append(input);
  input.click();
}
