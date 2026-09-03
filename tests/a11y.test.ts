/**
 * The accessibility rules in `core/a11y`, with no browser anywhere near them.
 *
 * The page-side walk measures and this decides, so what is worth testing here
 * is the deciding — and in particular the three places this refuses to decide,
 * because each of them fails silently in the direction of a confident wrong
 * answer:
 *
 *   - a contrast check run against a backdrop that was never resolved,
 *   - a "no accessible name" finding that does not say the name was
 *     approximated,
 *   - a focus check on the first sample of a recording, where every already-open
 *     dialog would be reported as a dialog that just opened without moving
 *     focus.
 *
 * The two-sample checks get the most cases for the same reason `core/cascade`'s
 * tests are mostly about the edge a render was *not* given: the interesting
 * failure is the finding that should not have been produced.
 */

import { describe, expect, it } from 'vitest';
import type { A11yNode, A11ySample, ContrastReading } from '../src/core/a11y/index.js';
import {
  a11yNote,
  auditA11y,
  contrastRatio,
  flowA11y,
  isLargeText,
  renderA11y,
} from '../src/core/a11y/index.js';

const node = (over: Partial<A11yNode> = {}): A11yNode => ({
  i: 0,
  tag: 'div',
  role: null,
  implicitRole: null,
  name: null,
  nameFrom: null,
  aria: {},
  focusable: false,
  tabIndex: null,
  disabled: false,
  ariaHidden: false,
  contrast: null,
  label: 'div',
  ...over,
});

const sample = (over: Partial<A11ySample> = {}): A11ySample => ({
  nodes: [],
  walked: 10,
  capped: false,
  focus: null,
  dialogs: [],
  ...over,
});

const contrast = (over: Partial<ContrastReading> = {}): ContrastReading => ({
  fg: [255, 255, 255],
  bg: [255, 255, 255],
  fontPx: 16,
  bold: false,
  ...over,
});

const checks = (nodes: A11yNode[]): string[] =>
  auditA11y(null, sample({ nodes })).map((finding) => finding.check);

describe('contrast', () => {
  it('computes the WCAG ratio, whichever way round the colours are', () => {
    const black = contrast({ fg: [0, 0, 0], bg: [255, 255, 255] });
    const white = contrast({ fg: [255, 255, 255], bg: [0, 0, 0] });
    expect(contrastRatio(black)).toBe(21);
    expect(contrastRatio(white)).toBe(21);
  });

  it('takes the specification’s definition of large text, not a rounder one', () => {
    expect(isLargeText(contrast({ fontPx: 24 }))).toBe(true);
    expect(isLargeText(contrast({ fontPx: 18.66, bold: true }))).toBe(true);
    expect(isLargeText(contrast({ fontPx: 18.66, bold: false }))).toBe(false);
    expect(isLargeText(contrast({ fontPx: 23, bold: false }))).toBe(false);
  });

  it('fails body text below 4.5:1 and allows the same ratio at large size', () => {
    // #7f7f7f on white is about 4.0:1 — under the 4.5 body text needs and over
    // the 3.0 large text needs, which is the only band where the size rule is
    // what decides the answer.
    const grey = { fg: [127, 127, 127] as const, bg: [255, 255, 255] as const };
    expect(checks([node({ contrast: contrast({ ...grey, fontPx: 16 }) })])).toEqual(['contrast']);
    expect(checks([node({ contrast: contrast({ ...grey, fontPx: 30 }) })])).toEqual([]);
  });

  it('never judges a node whose backdrop could not be resolved', () => {
    // The failure this guards is the one that matters: assuming white produces
    // a confident wrong ratio on every dark theme ever shipped.
    expect(checks([node({ contrast: null })])).toEqual([]);
  });

  it('says what the ratio was measured against, on every contrast finding', () => {
    const [finding] = auditA11y(
      null,
      sample({ nodes: [node({ contrast: contrast({ fg: [150, 150, 150] }) })] }),
    );
    expect(finding.caveat).toContain('nearest opaque ancestor');
    expect(finding.caveat).toContain('a missing finding is not a passing one');
  });
});

describe('single-sample checks', () => {
  it('reports an interactive role with no accessible name, and says the name was approximated', () => {
    const [finding] = auditA11y(null, sample({ nodes: [node({ role: 'button', name: null })] }));
    expect(finding.check).toBe('name-missing');
    expect(finding.wcag).toBe('4.1.2 Name, Role, Value');
    expect(finding.caveat).toContain('not by the full accname algorithm');
  });

  it('does not report a name on something hidden from assistive technology', () => {
    expect(checks([node({ role: 'button', ariaHidden: true })])).toEqual([]);
  });

  it('reports a role the keyboard cannot reach', () => {
    expect(checks([node({ tag: 'div', role: 'button', name: 'Buy', focusable: false })]))
      .toEqual(['keyboard-unreachable']);
    expect(checks([node({ tag: 'div', role: 'button', name: 'Buy', focusable: true })]))
      .toEqual([]);
  });

  it('does not call a disabled control keyboard-unreachable', () => {
    // It is unreachable because it is disabled, which is what disabled means.
    expect(checks([node({ tag: 'button', role: 'button', name: 'Buy', disabled: true })])).toEqual([]);
  });

  it('reports something focusable inside an aria-hidden subtree', () => {
    expect(checks([node({ ariaHidden: true, focusable: true })])).toEqual(['aria-hidden-focusable']);
  });

  it('reports a positive tabindex and leaves 0 and -1 alone', () => {
    expect(checks([node({ tabIndex: 3 })])).toEqual(['positive-tabindex']);
    expect(checks([node({ tabIndex: 0 })])).toEqual([]);
    expect(checks([node({ tabIndex: -1 })])).toEqual([]);
  });

  it('reports a native disabled contradicted by aria-disabled="false"', () => {
    expect(checks([node({ disabled: true, aria: { 'aria-disabled': 'false' } })]))
      .toEqual(['aria-disabled-contradiction']);
    expect(checks([node({ disabled: true, aria: { 'aria-disabled': 'true' } })])).toEqual([]);
  });

  it('reports an ARIA state the role does not take', () => {
    expect(checks([node({ role: 'button', name: 'Go', focusable: true, aria: { 'aria-checked': 'true' } })]))
      .toEqual(['aria-state-unsupported']);
  });

  it('says nothing about a role it does not have a table for', () => {
    // A half-remembered ARIA taxonomy turns every unusual-but-correct widget
    // into a finding, and an audit that cries wolf is one nobody runs twice.
    expect(checks([node({ role: 'treegrid', aria: { 'aria-checked': 'true' } })])).toEqual([]);
  });

  it('allows a state the role does take', () => {
    expect(checks([node({ role: 'checkbox', name: 'Agree', focusable: true, aria: { 'aria-checked': 'true' } })]))
      .toEqual([]);
  });

  it('reads an explicit role over the one the tag implies', () => {
    // <a role="presentation"> is not a link and must not be asked for a name.
    expect(checks([node({ tag: 'a', implicitRole: 'link', role: 'presentation' })])).toEqual([]);
    expect(checks([node({ tag: 'a', implicitRole: 'link', focusable: true })])).toEqual(['name-missing']);
  });
});

describe('focus, which needs both samples', () => {
  it('reports a dialog that opened without focus moving into it', () => {
    const findings = auditA11y(
      sample({ dialogs: [], focus: { label: 'button “Open”', inDialog: false } }),
      sample({ dialogs: ['div “Confirm”'], focus: { label: 'button “Open”', inDialog: false } }),
    );
    expect(findings.map((f) => f.check)).toEqual(['focus-not-moved']);
    expect(findings[0].wcag).toBe('2.4.3 Focus Order');
  });

  it('says nothing when focus did move into the dialog that opened', () => {
    const findings = auditA11y(
      sample({ dialogs: [] }),
      sample({ dialogs: ['div “Confirm”'], focus: { label: 'button “Yes”', inDialog: true } }),
    );
    expect(findings).toEqual([]);
  });

  it('does not report a dialog that was already open', () => {
    // Otherwise every interaction inside a modal reports the modal.
    const findings = auditA11y(
      sample({ dialogs: ['div “Confirm”'] }),
      sample({ dialogs: ['div “Confirm”'], focus: { label: 'input', inDialog: false } }),
    );
    expect(findings).toEqual([]);
  });

  it('reports focus going nowhere when a dialog closed', () => {
    const findings = auditA11y(
      sample({ dialogs: ['div “Confirm”'], focus: { label: 'button “Yes”', inDialog: true } }),
      sample({ dialogs: [], focus: null }),
    );
    expect(findings.map((f) => f.check)).toEqual(['focus-lost']);
  });

  it('says nothing when focus returned somewhere after a dialog closed', () => {
    const findings = auditA11y(
      sample({ dialogs: ['div “Confirm”'] }),
      sample({ dialogs: [], focus: { label: 'button “Open”', inDialog: false } }),
    );
    expect(findings).toEqual([]);
  });

  it('runs no focus check at all without an earlier sample', () => {
    // With no `before`, every open dialog looks like one that just opened.
    const findings = auditA11y(null, sample({ dialogs: ['div “Confirm”'], focus: null }));
    expect(findings).toEqual([]);
  });
});

describe('a11yNote', () => {
  it('says the walk was capped, so a clean step is not read as a clean page', () => {
    const note = a11yNote(null, sample({ capped: true, walked: 1500 }));
    expect(note).toContain('stopped at 1500 elements');
    expect(note).toContain('what was checked, not what is wrong');
  });

  it('names the untested focus trap whenever a dialog was seen', () => {
    const note = a11yNote(sample(), sample({ dialogs: ['div “Confirm”'] }));
    expect(note).toContain('trapped');
    expect(note).toContain('does not take part in the app it records');
  });

  it('does not mention a trap on a page with no dialog', () => {
    expect(a11yNote(sample(), sample())).toBeUndefined();
  });

  it('counts the nodes whose contrast could not be judged', () => {
    const note = a11yNote(sample(), sample({ nodes: [node(), node({ i: 1 })] }));
    expect(note).toContain('2 elements had no opaque backdrop');
  });

  it('says when there was no earlier reading to compare focus against', () => {
    expect(a11yNote(null, sample())).toContain('nothing about focus movement was checked');
  });
});

describe('flowA11y', () => {
  it('says the audit was off, and that this is not a clean bill', () => {
    const summary = flowA11y([{ a11y: undefined }], false);
    expect(summary.read).toBe(false);
    expect(summary.note).toContain('Nothing here says the page is clean');
  });

  it('reports a capped walk from the steps rather than from a stored flag', () => {
    const summary = flowA11y(
      [{ a11y: { findings: [], note: 'the walk stopped at 1500 elements, so the rest was not audited' } }],
      true,
    );
    expect(summary).toMatchObject({ read: true, capped: true });
  });

  it('is read and uncapped when the audit ran and nothing limited it', () => {
    expect(flowA11y([{ a11y: { findings: [{}] } }], true)).toEqual({ read: true });
  });
});

describe('renderA11y', () => {
  it('groups by criterion, because a fix is made per criterion and not per element', () => {
    const findings = auditA11y(
      null,
      sample({
        nodes: [
          node({ i: 0, role: 'button', label: 'button one' }),
          node({ i: 1, role: 'button', label: 'button two' }),
          node({ i: 2, tabIndex: 4, label: 'div#skip' }),
        ],
      }),
    );
    const text = renderA11y(findings);
    expect(text).toContain('4.1.2 Name, Role, Value (level A) — 2');
    expect(text).toContain('2.4.3 Focus Order (level A) — 1');
  });

  it('refuses to generate a fix, on every answer', () => {
    expect(renderA11y(auditA11y(null, sample({ nodes: [node({ role: 'button' })] }))))
      .toContain('No fix is generated here');
  });

  it('does not say a page is clean when something limited the audit', () => {
    expect(renderA11y([], 'the walk stopped at 1500 elements'))
      .toContain('the walk stopped at 1500 elements');
  });
});
