// @vitest-environment jsdom

/**
 * The setting row is the same object seventy-three times.
 *
 * The whole design rests on it, so this
 * asserts it rather than hoping. Every entry in `fields.ts` is rendered, reduced
 * to a structural signature — tag names, class sets and nesting, with all text,
 * values and attributes stripped — and every signature has to be identical,
 * modulo the control.
 *
 * This is the test that catches the drift the generated Stitch set has, and it
 * catches it in the phase that introduces it rather than three phases later. The
 * failure it exists to prevent looks like this: session four needs a hint under
 * one control, adds a `<p>` for that field only, and ships a screen whose rows
 * are subtly different heights. Nobody reviewing one row can see it.
 *
 * The fix, when this fails, is never to special-case the field. It is to widen
 * the primitive in `components.ts` so *every* row has the slot — which is why
 * every slot the row has is always in the DOM and hidden, rather than being
 * created only when there is something to put in it.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { FIELDS, type Field } from '../src/features/settings/fields.js';
import { settingRow, type RowHandlers } from '../src/ui/settings/components.js';

const handlers: RowHandlers = {
  onCommit: () => undefined,
  onReset: () => undefined,
  onCopyKey: () => undefined,
  onAction: () => undefined,
};

const fields = FIELDS as readonly Field[];

/** The default state every row is in when the page first paints. */
function render(field: Field): HTMLElement {
  return settingRow(
    field,
    {
      value: field.default,
      modified: false,
      disabled: false,
      note: null,
      action: null,
      query: '',
    },
    handlers,
  );
}

/**
 * An element reduced to its shape.
 *
 * Tag name and class set, then children — text, values, ids, `hidden`, `data-`
 * and everything else that varies per field is dropped, because none of it is
 * what "the same object" means here.
 *
 * Consecutive identical siblings collapse to one. A `<select>` has three
 * `<option>`s for the theme and nine for the editor, and "nine of the same node
 * instead of three" is not a different shape — it is the same shape, repeated.
 * Collapsing is what lets the assertion be about structure rather than about how
 * many editors happen to be installed.
 */
function signature(node: Element): string {
  const classes = [...node.classList].sort().join('.');
  const head = classes ? `${node.tagName.toLowerCase()}.${classes}` : node.tagName.toLowerCase();

  const children: string[] = [];
  for (const child of node.children) {
    const shape = signature(child);
    if (children.at(-1) !== shape) children.push(shape);
  }

  return children.length === 0 ? head : `${head}(${children.join(',')})`;
}

/** The row with its control slot replaced by a placeholder. */
function chrome(row: HTMLElement): string {
  const clone = row.cloneNode(true) as HTMLElement;
  const control = clone.querySelector('.setting-row__control');
  if (control) control.replaceChildren();
  return signature(clone);
}

function controlShape(row: HTMLElement): string {
  const control = row.querySelector('.setting-row__control');
  if (!control) return '<missing>';
  return [...control.children].map((child) => signature(child)).join(',');
}

let rows: Map<string, HTMLElement>;

beforeAll(() => {
  rows = new Map(fields.map((field) => [field.key, render(field)]));
});

describe('every setting renders the same row', () => {
  it('covers the whole table', () => {
    // If this ever drops below the table's length the rest of the file is
    // asserting something about a subset, which is the shape of a green suite
    // that proves nothing.
    expect(rows.size).toBe(fields.length);
    expect(rows.size).toBeGreaterThan(60);
  });

  it('has an identical signature outside the control, for every field', () => {
    const first = fields[0];
    const expected = chrome(rows.get(first.key)!);

    for (const field of fields) {
      expect(chrome(rows.get(field.key)!), `${field.key} differs from ${first.key}`).toBe(expected);
    }
  });

  it('has exactly the slots the design names, and no others', () => {
    /*
     * Spelled out rather than snapshotted. A snapshot updates itself the moment
     * somebody runs the suite with `-u`, which makes adding a slot to one row an
     * accident rather than a decision; this list has to be edited by hand, and
     * editing it is the review.
     */
    expect(chrome(rows.get(fields[0].key)!)).toBe(
      'div.setting-row(' +
        'div.setting-row__gutter,' +
        'div.setting-row__body(' +
        'div.setting-row__head(' +
        'div.setting-row__text(' +
        'span.setting-row__title,' +
        'p.setting-row__meta(button.setting-row__key,span.setting-row__default)' +
        '),' +
        'div.setting-row__control' +
        '),' +
        'p.setting-row__description,' +
        'p.setting-row__note,' +
        'div.banner.banner--warn.setting-row__consequence(' +
        'svg.banner__icon.icon(path),div.banner__body(p)' +
        ')' +
        ')' +
        ')',
    );
  });

  it('gives one control shape per field type, and not one more', () => {
    const byType = new Map<string, Set<string>>();
    const byShape = new Map<string, string>();

    for (const field of fields) {
      const shape = controlShape(rows.get(field.key)!);
      const seen = byType.get(field.type) ?? new Set<string>();
      seen.add(shape);
      byType.set(field.type, seen);

      const owner = byShape.get(shape);
      // Two types sharing a shape would be just as wrong as one type having two:
      // it would mean an enum and a string are indistinguishable on screen.
      expect(owner ?? field.type, `${shape} is rendered for two types`).toBe(field.type);
      byShape.set(shape, field.type);
    }

    for (const [type, shapes] of byType) {
      expect([...shapes], `${type} renders more than one control`).toHaveLength(1);
    }

    /*
     * the session prompt says four permitted shapes — boolean, integer, enum
     * and string. `fields.ts` grew a fifth type, `levels`, for the console
     * levels multi-select, so five is the number the table actually has. The
     * count is asserted so a sixth cannot arrive unnoticed, which is the thing
     * the prompt was protecting.
     */
    expect([...byType.keys()].sort()).toEqual(['boolean', 'enum', 'levels', 'number', 'string']);
    expect(byShape.size).toBe(5);
  });
});

describe('the row is the same object in every state, not only at rest', () => {
  /*
   * The signature has to be state-independent as well as field-independent, or
   * the invariant is "identical until somebody changes something". Every slot is
   * in the DOM at all times and state only hides it — these cases are what say
   * so, and they are why a field with no consequence still carries the banner.
   */
  const cases: { name: string; state: Parameters<typeof settingRow>[1] }[] = [
    {
      name: 'modified, with a clamp report',
      state: {
        value: 1,
        modified: true,
        disabled: false,
        note: { text: 'Outside the accepted range, so it was set to 10.', tone: 'danger' },
        action: null,
        query: '',
      },
    },
    {
      name: 'disabled by a dependency',
      state: {
        value: 1,
        modified: false,
        disabled: true,
        note: { text: 'Applies while something else is on.', tone: 'muted' },
        action: null,
        query: '',
      },
    },
    {
      name: 'with an action beside the control',
      state: {
        value: 1,
        modified: false,
        disabled: false,
        note: null,
        action: { label: 'Test connection', icon: 'refresh-cw', busy: false },
        query: '',
      },
    },
  ];

  for (const { name, state } of cases) {
    it(`keeps its shape when ${name}`, () => {
      const field = fields.find((entry) => entry.type === 'number')!;
      expect(chrome(settingRow(field, state, handlers))).toBe(chrome(rows.get(field.key)!));
    });
  }

  it('adds marks inside the existing slots when searching, not new slots', () => {
    // The one state that legitimately changes the DOM: a query wraps matched
    // runs in <mark>. It must land *inside* the title, key and description that
    // are already there, never beside them.
    const field = fields.find((entry) => entry.key === 'recording.maxSteps')!;
    const row = settingRow(
      field,
      { value: 500, modified: false, disabled: false, note: null, action: null, query: 'record' },
      handlers,
    );

    expect(row.querySelectorAll('mark.hl').length).toBeGreaterThan(0);
    for (const hl of row.querySelectorAll('mark.hl')) {
      expect(
        hl.closest('.setting-row__title, .setting-row__key, .setting-row__description'),
      ).not.toBeNull();
    }
  });
});

describe('the parts of the row named by hand', () => {
  it('shows the key and the shipped default on one line, for every field', () => {
    for (const field of fields) {
      const meta = rows.get(field.key)!.querySelector('.setting-row__meta');
      expect(meta?.textContent, field.key).toContain(field.key);
      expect(meta?.textContent, field.key).toContain('default');
    }
  });

  it('makes the key a button, because clicking it copies it', () => {
    for (const field of fields) {
      const key = rows.get(field.key)!.querySelector('.setting-row__key');
      expect(key?.tagName, field.key).toBe('BUTTON');
      expect(key?.textContent, field.key).toBe(field.key);
    }
  });

  it('never truncates a description and never makes it a tooltip', () => {
    for (const field of fields) {
      const row = rows.get(field.key)!;
      const description = row.querySelector('.setting-row__description');
      expect(description?.textContent, field.key).toBe(field.description);
      // A `title` on the row or its text would be the tooltip the design forbids.
      expect(row.getAttribute('title'), field.key).toBeNull();
      expect(description?.getAttribute('title'), field.key).toBeNull();
    }
  });

  it('carries the gutter marker only when the row is modified', () => {
    const field = fields[1];
    const at = render(field);
    expect(at.dataset.modified).toBe('false');

    const moved = settingRow(
      field,
      { value: 1, modified: true, disabled: false, note: null, action: null, query: '' },
      handlers,
    );
    expect(moved.dataset.modified).toBe('true');
    expect(moved.querySelector('.setting-row__gutter')).not.toBeNull();
  });

  it('shows the consequence only where the value is in the range it describes', () => {
    // `mcpAutoSend` says what it costs when it is on, and says nothing when off.
    const field = fields.find((entry) => entry.key === 'mcpAutoSend')!;

    const off = settingRow(
      field,
      { value: false, modified: false, disabled: false, note: null, action: null, query: '' },
      handlers,
    );
    const on = settingRow(
      field,
      { value: true, modified: true, disabled: false, note: null, action: null, query: '' },
      handlers,
    );

    expect(off.querySelector<HTMLElement>('.setting-row__consequence')!.hidden).toBe(true);
    expect(on.querySelector<HTMLElement>('.setting-row__consequence')!.hidden).toBe(false);
    expect(on.querySelector('.setting-row__consequence')!.textContent).toContain(
      field.consequence,
    );
  });

  it('keeps the reset button present but inert until the row is modified', () => {
    const field = fields[1];
    const at = render(field);
    const reset = at.querySelector<HTMLButtonElement>('.setting-row__reset')!;

    // Present in the DOM at rest — CSS reveals it on hover — and disabled,
    // because resetting a row that is already at its default does nothing.
    expect(reset.hidden).toBe(false);
    expect(reset.disabled).toBe(true);

    const moved = settingRow(
      field,
      { value: 1, modified: true, disabled: false, note: null, action: null, query: '' },
      handlers,
    );
    expect(moved.querySelector<HTMLButtonElement>('.setting-row__reset')!.disabled).toBe(false);
  });
});
