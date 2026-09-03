/**
 * Judging a page's accessibility from what was measured, not from what was
 * parsed.
 *
 * ## Why this is worth building when eslint-plugin-jsx-a11y exists
 *
 * A static linter reads the JSX and cannot see the two things that decide most
 * real violations: **what the browser actually computed**, and **what happened
 * between two moments**. A contrast rule in a stylesheet is a claim about a
 * colour; the contrast a user experiences is the resolved foreground against
 * whatever opaque thing is actually behind it, after every cascade, theme
 * toggle and inline style the app applied at runtime. A focus trap is not a
 * property of any file at all — it is a relationship between where focus was
 * before a dialog opened and where it is afterwards.
 *
 * So every check here needs the runtime, and each one says which measurement it
 * rests on. Nothing is re-derived from the markup.
 *
 * ## The three refusals, and each is the difference between an audit and a
 * complaint
 *
 * **1. A check that cannot be measured is not run.** Contrast is the case that
 * matters. `getComputedStyle().backgroundColor` is `rgba(0,0,0,0)` on most
 * elements, so the real backdrop is an ancestor's — and behind a background
 * *image*, a gradient, a canvas or a video there is no colour to compare
 * against at all. The page-side walk resolves an opaque backdrop or reports
 * none, and a node with none is **skipped rather than compared against white**.
 * A guessed backdrop produces a confident ratio that is simply wrong, and a
 * wrong contrast figure is worse than a missing one: somebody changes a colour
 * to satisfy it.
 *
 * **2. The accessible name is an approximation and every finding that reads one
 * says so.** The real accname algorithm is a specification of its own, with
 * traversal rules, recursion limits and a dozen host-language special cases.
 * What is computed here is the common path — `aria-label`, `aria-labelledby`,
 * a native `<label>`, `alt`, `title`, then text content — and `nameFrom` records
 * which of them answered. A finding that says *this button has no accessible
 * name* is therefore a finding that says *no name was found by the paths below*,
 * and the caveat prints.
 *
 * **3. Nothing is simulated, so a focus *trap* is not tested and is named as a
 * gap.** Whether Tab cycles within a dialog can only be learnt by pressing Tab,
 * and pressing Tab would be DevFlow taking part in the application it is
 * recording — the line `injected/state.ts` and `injected/render.ts` both hold.
 * What two samples *can* answer is whether focus moved into a dialog that
 * opened and whether it came back when one closed, which is where the common
 * bug actually lives. The report says the trap itself was not tested rather
 * than letting a passing focus check be read as one.
 *
 * ## No fix is generated
 *
 * The roadmap's §4.6 asks for "a targeted fix" and ADR 0009 already answered
 * that for the whole product: DevFlow is not a model and the caller is. What a
 * finding carries is the criterion it fails, what was measured, and the
 * component and line it was found in — which is everything a model needs to
 * write the fix, and none of it invented.
 */

/** Foreground and the opaque backdrop actually resolved behind it. */
export interface ContrastReading {
  /** sRGB 0–255. */
  fg: readonly [number, number, number];
  bg: readonly [number, number, number];
  fontPx: number;
  bold: boolean;
}

/** The roles this audit knows how to judge, and nothing beyond them. */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'checkbox',
  'radio',
  'switch',
  'tab',
  'textbox',
  'combobox',
  'searchbox',
  'menuitem',
  'option',
  'slider',
]);

/**
 * Tags the browser makes focusable without a `tabindex`.
 *
 * Exported because the page-side walk is what decides `focusable` and this is
 * the fact it decides it from — a fact about HTML, not about a DOM, so it
 * belongs on the side that can be tested without one. `<a>` is here on the
 * condition it carries an `href`, which the walk applies; a bare anchor is not
 * focusable and this table cannot see the attribute.
 */
export const NATIVELY_FOCUSABLE: ReadonlySet<string> = new Set([
  'a',
  'button',
  'input',
  'select',
  'textarea',
  'summary',
]);

/**
 * Which ARIA states each role actually takes.
 *
 * Deliberately a small table of roles this audit is confident about rather than
 * the whole ARIA taxonomy: a role missing from here is not judged at all, which
 * is the same rule the contrast check keeps. A half-remembered taxonomy would
 * turn every unusual-but-correct widget into a finding, and an audit that cries
 * wolf on correct code is one nobody runs twice.
 */
const ROLE_STATES: Record<string, ReadonlySet<string>> = {
  button: new Set(['aria-expanded', 'aria-pressed', 'aria-disabled']),
  link: new Set(['aria-expanded', 'aria-disabled']),
  checkbox: new Set(['aria-checked', 'aria-disabled', 'aria-required']),
  radio: new Set(['aria-checked', 'aria-disabled', 'aria-required']),
  switch: new Set(['aria-checked', 'aria-disabled']),
  tab: new Set(['aria-selected', 'aria-expanded', 'aria-disabled']),
  option: new Set(['aria-selected', 'aria-disabled']),
  textbox: new Set(['aria-required', 'aria-invalid', 'aria-disabled', 'aria-readonly']),
  combobox: new Set(['aria-expanded', 'aria-required', 'aria-invalid', 'aria-disabled']),
  heading: new Set([]),
  img: new Set([]),
};

/** The states this audit will comment on at all. */
const JUDGED_STATES = ['aria-checked', 'aria-selected', 'aria-pressed', 'aria-expanded'] as const;

/** How the accessible name was arrived at — see refusal 2 in the header. */
export type NameSource = 'aria-label' | 'aria-labelledby' | 'native-label' | 'alt' | 'title' | 'text';

/** One element, as the page-side walk measured it. Serialisable; holds no DOM. */
export interface A11yNode {
  /** Position in the walk. A finding points back at an element by this. */
  i: number;
  tag: string;
  /** An explicit `role`, lowercased, or null. */
  role: string | null;
  /** The role the tag implies, when this audit knows one. */
  implicitRole: string | null;
  name: string | null;
  nameFrom: NameSource | null;
  /** The `aria-*` attributes present, lowercased keys and raw values. */
  aria: Readonly<Record<string, string>>;
  focusable: boolean;
  tabIndex: number | null;
  /** A native `disabled`, not `aria-disabled`. */
  disabled: boolean;
  /** Inside an `aria-hidden="true"` subtree. */
  ariaHidden: boolean;
  /** Null when no opaque backdrop could be resolved — see refusal 1. */
  contrast: ContrastReading | null;
  /** A short handle for the element, for a reader rather than for a selector. */
  label: string;
}

/** One page-side reading. Two of these are taken per interaction. */
export interface A11ySample {
  nodes: A11yNode[];
  /** How many elements the walk visited. */
  walked: number;
  /** Whether it stopped at its cap, so the page was not audited whole. */
  capped: boolean;
  /** What had focus, by label, and whether it sat inside a modal container. */
  focus: { label: string; inDialog: boolean } | null;
  /** Open modal containers, by label — `role="dialog"` with `aria-modal="true"`, and `<dialog open>`. */
  dialogs: string[];
}

export type A11yCheck =
  | 'contrast'
  | 'name-missing'
  | 'keyboard-unreachable'
  | 'aria-hidden-focusable'
  | 'positive-tabindex'
  | 'aria-state-unsupported'
  | 'aria-disabled-contradiction'
  | 'focus-not-moved'
  | 'focus-lost';

export interface A11yFinding {
  check: A11yCheck;
  /** The success criterion, numbered and named, because "an a11y issue" is not actionable. */
  wcag: string;
  level: 'A' | 'AA';
  /** The node this was found on, by `A11yNode.i`, or null for a page-level finding. */
  node: number | null;
  /** A human handle for the element, carried so a report reads without the node table. */
  label: string;
  /** What was actually measured. */
  detail: string;
  /** What this finding does not know about itself. Printed whenever present. */
  caveat: string | null;
}

// ── Contrast ─────────────────────────────────────────────────────────────────

/** WCAG relative luminance, on sRGB 0–255. */
function luminance([r, g, b]: readonly [number, number, number]): number {
  const channel = (value: number): number => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** The WCAG ratio, always ≥ 1, rounded to two places for reporting. */
export function contrastRatio(reading: ContrastReading): number {
  const a = luminance(reading.fg);
  const b = luminance(reading.bg);
  const [light, dark] = a > b ? [a, b] : [b, a];
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100;
}

/**
 * Large text takes the lower threshold, and the definition is the specification's
 * rather than a rounder number: 18pt, or 14pt bold, which at the CSS reference
 * of 96dpi is 24px and 18.66px.
 */
export function isLargeText({ fontPx, bold }: ContrastReading): boolean {
  return fontPx >= 24 || (bold && fontPx >= 18.66);
}

const contrastThreshold = (reading: ContrastReading): number => (isLargeText(reading) ? 3 : 4.5);

// ── The audit ────────────────────────────────────────────────────────────────

/** The role that governs an element: an explicit one wins over the implied one. */
const effectiveRole = (node: A11yNode): string | null => node.role ?? node.implicitRole;

/**
 * Every finding in one settled reading, plus the two that need the pair.
 *
 * `before` is null when there was no earlier sample — a reading taken outside an
 * interaction — and the two focus checks are then simply not run rather than run
 * against an assumed previous state. A dialog check with nothing to compare
 * against would report every open dialog as a failure on the first sample.
 */
export function auditA11y(before: A11ySample | null, after: A11ySample): A11yFinding[] {
  const findings: A11yFinding[] = [];

  for (const node of after.nodes) {
    const role = effectiveRole(node);

    if (node.contrast) {
      const ratio = contrastRatio(node.contrast);
      const needed = contrastThreshold(node.contrast);
      if (ratio < needed) {
        findings.push({
          check: 'contrast',
          wcag: '1.4.3 Contrast (Minimum)',
          level: 'AA',
          node: node.i,
          label: node.label,
          detail:
            `${ratio}:1 against the resolved backdrop, below the ${needed}:1 this text needs at ` +
            `${Math.round(node.contrast.fontPx)}px${node.contrast.bold ? ' bold' : ''}`,
          caveat:
            'measured against the nearest opaque ancestor background — a backdrop this reading could ' +
            'not resolve is skipped rather than assumed, so a missing finding is not a passing one',
        });
      }
    }

    if (role && INTERACTIVE_ROLES.has(role) && !node.name && !node.ariaHidden) {
      findings.push({
        check: 'name-missing',
        wcag: '4.1.2 Name, Role, Value',
        level: 'A',
        node: node.i,
        label: node.label,
        detail: `a ${role} with no accessible name — a screen reader announces its role and nothing else`,
        caveat:
          'the name is computed by the common paths only (aria-label, aria-labelledby, a native label, ' +
          'alt, title, then text), not by the full accname algorithm',
      });
    }

    if (role && INTERACTIVE_ROLES.has(role) && !node.focusable && !node.ariaHidden && !node.disabled) {
      findings.push({
        check: 'keyboard-unreachable',
        wcag: '2.1.1 Keyboard',
        level: 'A',
        node: node.i,
        label: node.label,
        detail:
          `role="${role}" on a <${node.tag}>, which the browser does not make focusable and which ` +
          'carries no tabindex — reachable with a mouse and not with a keyboard',
        caveat: null,
      });
    }

    if (node.ariaHidden && node.focusable) {
      findings.push({
        check: 'aria-hidden-focusable',
        wcag: '4.1.2 Name, Role, Value',
        level: 'A',
        node: node.i,
        label: node.label,
        detail:
          'focusable but inside an aria-hidden="true" subtree — the keyboard reaches it and the ' +
          'screen reader has been told it is not there',
        caveat: null,
      });
    }

    if (node.tabIndex !== null && node.tabIndex > 0) {
      findings.push({
        check: 'positive-tabindex',
        wcag: '2.4.3 Focus Order',
        level: 'A',
        node: node.i,
        label: node.label,
        detail: `tabindex="${node.tabIndex}" pulls this element out of document order for every user`,
        caveat: null,
      });
    }

    /*
     * An `aria-disabled="false"` beside a native `disabled` is a contradiction
     * rather than a redundancy: the browser will not focus the element and the
     * attribute says it is available. Judged separately from the state table
     * because it is about two sources disagreeing, not about a role.
     */
    if (node.disabled && node.aria['aria-disabled'] === 'false') {
      findings.push({
        check: 'aria-disabled-contradiction',
        wcag: '4.1.2 Name, Role, Value',
        level: 'A',
        node: node.i,
        label: node.label,
        detail: 'natively disabled but marked aria-disabled="false" — the two say opposite things',
        caveat: null,
      });
    }

    const supported = role ? ROLE_STATES[role] : undefined;
    if (supported) {
      for (const state of JUDGED_STATES) {
        if (state in node.aria && !supported.has(state)) {
          findings.push({
            check: 'aria-state-unsupported',
            wcag: '4.1.2 Name, Role, Value',
            level: 'A',
            node: node.i,
            label: node.label,
            detail: `${state}="${node.aria[state]}" on role="${role}", which does not take that state`,
            caveat: null,
          });
        }
      }
    }
  }

  findings.push(...focusFindings(before, after));
  return findings;
}

/**
 * The two findings that exist only in the difference between the samples.
 *
 * This is the half a static tool cannot reach and the half a single reading
 * cannot either: a dialog that is open in both samples is not a dialog that just
 * opened, and reporting focus against it would flag every already-open modal on
 * every interaction inside it.
 */
function focusFindings(before: A11ySample | null, after: A11ySample): A11yFinding[] {
  if (!before) return [];
  const findings: A11yFinding[] = [];

  const was = new Set(before.dialogs);
  const now = new Set(after.dialogs);

  for (const dialog of after.dialogs) {
    if (was.has(dialog)) continue;
    if (after.focus?.inDialog) continue;
    findings.push({
      check: 'focus-not-moved',
      wcag: '2.4.3 Focus Order',
      level: 'A',
      node: null,
      label: dialog,
      detail:
        `this modal opened during the interaction and focus stayed on ${
          after.focus ? after.focus.label : 'nothing'
        } outside it — a keyboard user is still in the page behind the dialog`,
      caveat: null,
    });
  }

  for (const dialog of before.dialogs) {
    if (now.has(dialog)) continue;
    if (after.focus) continue;
    findings.push({
      check: 'focus-lost',
      wcag: '2.4.3 Focus Order',
      level: 'A',
      node: null,
      label: dialog,
      detail:
        'this modal closed during the interaction and focus went nowhere — it should return to what ' +
        'opened the dialog, and a keyboard user now starts again from the top of the document',
      caveat: null,
    });
  }

  return findings;
}

/**
 * What the audit did not look at, said once per step.
 *
 * Returns undefined when there is nothing to say, so a step carries the note
 * only when a limit actually bit. The trap sentence is the exception and is
 * carried whenever a dialog was seen at all, because a focus check that passed
 * is exactly what somebody would otherwise read as "the trap works".
 */
export function a11yNote(before: A11ySample | null, after: A11ySample): string | undefined {
  const parts: string[] = [];

  if (after.capped) {
    parts.push(
      `the walk stopped at ${after.walked} elements, so the rest of the page was not audited — this ` +
        'is what was checked, not what is wrong',
    );
  }
  if (!before) {
    parts.push('there was no earlier reading, so nothing about focus movement was checked');
  }
  if (after.dialogs.length || before?.dialogs.length) {
    parts.push(
      'whether focus is *trapped* inside the dialog was not tested: that can only be learnt by pressing ' +
        'Tab, and DevFlow does not take part in the app it records',
    );
  }

  const skipped = after.nodes.filter((node) => node.contrast === null).length;
  if (skipped) {
    parts.push(
      `${skipped} element${skipped === 1 ? '' : 's'} had no opaque backdrop this reading could resolve ` +
        '— behind an image, a gradient or a transparent stack — so contrast was not judged on ' +
        `${skipped === 1 ? 'it' : 'them'}`,
    );
  }

  return parts.length ? parts.join('; ') : undefined;
}

/**
 * One finding as a *reader* meets it: the judgement, plus where it lives.
 *
 * `where` is filled in by whoever holds the recording, because this module has
 * no flow and cannot turn a component id into a name and a file. It is the one
 * field the renderer takes and the audit does not produce.
 */
export interface RenderableFinding extends A11yFinding {
  /** "in CartButton src/Cart.tsx:12", or absent when nothing resolved it. */
  where?: string;
}

/**
 * The findings as a reader sees them, grouped by criterion.
 *
 * Grouped by WCAG criterion rather than by element because that is the unit a
 * fix is made in: eight buttons missing a name are one decision, and eight rows
 * saying "4.1.2" are eight readings of the same sentence.
 *
 * **This is the only place a finding is rendered.** The MCP server's `a11y`
 * step part had its own copy of this grouping for one commit, which is the
 * two-markdown-renderers mistake `src/core/mcp-bundle.ts` exists because of —
 * two renderers over one shape drift, and the one a *model* reads is always the
 * weaker of them. The server builds `where` and calls this.
 */
export function renderA11y(
  findings: readonly RenderableFinding[],
  note?: string,
  limit = 10,
): string {
  if (!findings.length) {
    return note
      ? `No accessibility violations were found in what was checked. ${note}.`
      : 'No accessibility violations were found in what was checked.';
  }

  const groups = new Map<string, RenderableFinding[]>();
  for (const finding of findings) {
    const list = groups.get(finding.wcag) ?? [];
    list.push(finding);
    groups.set(finding.wcag, list);
  }

  const lines: string[] = [
    `${findings.length} accessibility violation${findings.length === 1 ? '' : 's'}, by success criterion:`,
  ];

  for (const [wcag, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
    lines.push('', `${wcag} (level ${list[0].level}) — ${list.length}`);
    for (const finding of list.slice(0, limit)) {
      lines.push(`  ${finding.label}  ${finding.detail}${finding.where ? `  ${finding.where}` : ''}`);
      if (finding.caveat) lines.push(`      ${finding.caveat}`);
    }
    if (list.length > limit) lines.push(`  … and ${list.length - limit} more`);
  }

  if (note) lines.push('', `What was not checked: ${note}.`);
  lines.push(
    '',
    'No fix is generated here. The criterion, the measurement and the component each violation was ' +
      'found in are what this reports; writing the change is the caller’s.',
  );

  return lines.join('\n');
}

/**
 * What a whole flow's accessibility audit amounts to — derived, not stored.
 *
 * `FlowRenders` is accumulated in storage as a recording runs; this is not, and
 * the difference is deliberate. Everything the summary needs is already on the
 * steps and in the recording's frozen settings, so computing it here means a
 * recording already on somebody's disk gets a sharpened summary from a later
 * release — ADR 0007's rule, applied to a second thing. It also removes the way
 * this could go wrong: a stored summary that disagrees with the steps it claims
 * to describe.
 *
 * `read: false` is the common case, because the audit is off by default. That is
 * exactly why this exists: an absent finding then means "nothing looked", and a
 * reader who is not told so will read it as a page with nothing wrong.
 */
export function flowA11y(
  steps: readonly { a11y?: { findings: readonly unknown[]; note?: string } }[],
  enabled: boolean,
): { read: boolean; capped?: boolean; note?: string } {
  if (!enabled) {
    return {
      read: false,
      note:
        'Accessibility was not audited during this recording — “Audit accessibility while recording” ' +
        'was off, which is its default. Nothing here says the page is clean.',
    };
  }

  const notes = steps.map((step) => step.a11y?.note).filter((note): note is string => Boolean(note));
  const capped = notes.some((note) => note.includes('stopped at'));

  return {
    read: true,
    ...(capped ? { capped: true } : {}),
    // The first note rather than all of them: they repeat almost exactly across
    // steps of one recording, and a summary that prints forty near-identical
    // sentences is one nobody finishes.
    ...(notes.length ? { note: notes[0] } : {}),
  };
}
