/**
 * Regressions for the defects the analysis-module audit found.
 *
 * One `it` per fix, each named after what was wrong rather than after the
 * function, because the failure is the thing worth recognising when one of
 * these goes red again: every one of them was a confident wrong answer or a
 * thrown error rather than a visibly missing one.
 */

import { describe, expect, it } from 'vitest';

import {
  auditA11y,
  contrastRatio,
  type A11yNode,
  type A11ySample,
  type ContrastReading,
} from '../src/core/a11y/index.js';
import { renderDeployDiff, type DeployRecording } from '../src/core/deploy/index.js';
import { rankCandidates, renderForensics, type ForensicSubject } from '../src/core/forensics/index.js';
import { unquotePath } from '../src/core/git/index.js';
import { describeProductionError, parseSentryDelivery } from '../src/core/telemetry/index.js';
import { resolveDeclaredThrough } from '../src/core/rsc/debug.js';
import type { Resolution } from '../src/core/locate/adapter.js';
import { pos1 } from '../src/core/locate/positions.js';
import { parseSourceMap } from '../src/core/locate/sourcemap.js';

// ── a11y ─────────────────────────────────────────────────────────────────────

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

const sample = (nodes: A11yNode[]): A11ySample => ({
  nodes,
  walked: nodes.length,
  capped: false,
  focus: null,
  dialogs: [],
});

const checks = (nodes: A11yNode[]): string[] =>
  auditA11y(null, sample(nodes)).map((finding) => finding.check);

describe('a11y', () => {
  it('does not throw when a page names a role that is an Object.prototype key', () => {
    // `ROLE_STATES['constructor']` is a function, which is truthy and has no
    // `.has`. One attribute anybody can write took the whole audit down.
    expect(() =>
      checks([node({ role: 'constructor', aria: { 'aria-checked': 'true' } })]),
    ).not.toThrow();
    expect(checks([node({ role: 'constructor', aria: { 'aria-checked': 'true' } })])).toEqual([]);
  });

  it('accepts aria-checked on a role="option", which ARIA 1.2 supports', () => {
    // A multi-selectable listbox marks its rows `aria-checked`. Every one of
    // them used to be reported as using a state the role does not take.
    expect(
      checks([
        node({ role: 'option', name: 'Berlin', focusable: true, aria: { 'aria-checked': 'true' } }),
      ]),
    ).toEqual([]);
    // And the states it genuinely does not take are still judged.
    expect(
      checks([
        node({ role: 'option', name: 'Berlin', focusable: true, aria: { 'aria-pressed': 'true' } }),
      ]),
    ).toEqual(['aria-state-unsupported']);
  });

  it('does not call a composite widget’s managed items keyboard-unreachable', () => {
    // Roving tabindex leaves every tab but the active one at -1, and that is
    // the pattern ARIA prescribes. Judging it flagged n-1 items on every
    // correct tablist, listbox and menu on the page.
    const managed = ['option', 'menuitem', 'tab', 'radio'];
    for (const role of managed) {
      expect(checks([node({ tag: 'div', role, name: 'x', focusable: false, tabIndex: -1 })])).toEqual([]);
    }
    // A role nothing else manages is still judged.
    expect(checks([node({ tag: 'div', role: 'button', name: 'Buy', focusable: false })])).toEqual([
      'keyboard-unreachable',
    ]);
  });

  it('judges contrast on the exact ratio, not on the number it prints', () => {
    /*
     * `#7473b6` on white measures 4.4971:1 — a real 1.4.3 failure — and rounds
     * to exactly 4.5. Comparing the rounded number let it pass as though it met
     * the criterion, which is precisely the band a designer lands in while
     * nudging a colour until the checker stops complaining.
     */
    const borderline: ContrastReading = {
      fg: [100, 115, 182],
      bg: [255, 255, 255],
      fontPx: 16,
      bold: false,
    };
    expect(contrastRatio(borderline)).toBe(4.5);
    expect(checks([node({ contrast: borderline })])).toEqual(['contrast']);

    // Above the bar is still above the bar; this is not "report everything".
    const passing: ContrastReading = { ...borderline, fg: [90, 105, 175] };
    expect(contrastRatio(passing)).toBeGreaterThan(4.5);
    expect(checks([node({ contrast: passing })])).toEqual([]);
  });
});

// ── git ──────────────────────────────────────────────────────────────────────

describe('git', () => {
  it('decodes every named escape git writes, not the three easy ones', () => {
    // `quote_c_style` writes \a \b \f \n \r \t \v. Four of them used to come
    // back as the literal letter, producing a path that matches no file and
    // does not look mangled enough for anybody to notice.
    expect(unquotePath('"a\\ab"')).toBe('a\u0007b');
    expect(unquotePath('"a\\bb"')).toBe('a\bb');
    expect(unquotePath('"a\\fb"')).toBe('a\fb');
    expect(unquotePath('"a\\vb"')).toBe('a\vb');
    // The three that already worked, and the octal run beside them.
    expect(unquotePath('"a\\nb"')).toBe('a\nb');
    expect(unquotePath('"src/\\303\\251t\\303\\251.ts"')).toBe('src/été.ts');
  });
});

// ── telemetry, deploy, forensics: a finite number Date cannot hold ───────────

describe('dates that are finite and still outside Date’s range', () => {
  it('refuses a timestamp toISOString would throw on, rather than storing it', () => {
    const delivery = JSON.stringify({
      id: 'abc',
      issue_id: '77',
      timestamp: 1e20,
      exception: { values: [{ type: 'TypeError' }] },
    });
    const result = parseSentryDelivery(delivery);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.error.lastSeenMs).toBeNull();
  });

  it('describes an out-of-range lastSeen as unknown instead of throwing', () => {
    expect(() =>
      describeProductionError({
        type: 'TypeError',
        culprit: null,
        count: 1,
        level: null,
        lastSeenMs: 1e20,
      }),
    ).not.toThrow();
    expect(
      describeProductionError({
        type: 'TypeError',
        culprit: null,
        count: 1,
        level: null,
        lastSeenMs: 1e20,
      }),
    ).toContain('unknown');
  });

  it('renders a deploy diff for a flow whose timestamp Date cannot hold', () => {
    const recording = (id: string, timestamp: number, sha: string): DeployRecording => ({
      id,
      name: 'Checkout',
      timestamp,
      startUrl: 'http://localhost:3000/',
      git: {
        sha,
        short: sha.slice(0, 10),
        branch: 'main',
        dirty: false,
        subject: 'a commit',
        committedAt: 1_700_000_000_000,
      },
    });

    expect(() =>
      renderDeployDiff({
        pair: {
          older: recording('a', 1e20, 'a'.repeat(40)),
          newer: recording('b', Date.now(), 'b'.repeat(40)),
        },
        runtimeDiff: 'nothing',
        range: [],
        rangeProblem: null,
        reversed: null,
        suspects: [],
      }),
    ).not.toThrow();
  });

  it('renders forensics for a commit date Date cannot hold', () => {
    const subject: ForensicSubject = {
      kind: 'component',
      name: 'Cart',
      file: 'src/Cart.tsx',
      line: 12,
      observedSha: 'a'.repeat(40),
      frequency: 3,
      failureRate: 0,
      lastObservedAt: 1e20,
    };
    const result = rankCandidates({
      subject,
      commits: [
        {
          sha: 'b'.repeat(40),
          shortSha: 'bbbbbbbbbb',
          subject: 'edit',
          author: 'someone',
          committedAt: 1e20,
          inGraph: false,
          walkIndex: null,
        },
      ],
      anchorIndex: null,
      anchorCommittedAt: 1e20,
      walked: 1,
      capped: false,
    });
    expect(() => renderForensics(result)).not.toThrow();
    expect(renderForensics(result)).toContain('unknown');
  });
});

// ── rsc ──────────────────────────────────────────────────────────────────────

describe('rsc', () => {
  it('keeps `at` and `moduleId` when a compiled frame is mapped back to source', () => {
    /*
     * A source-map lookup moves a position from a chunk to the `.tsx` it came
     * from. It does not turn a call site into a declaration — and dropping `at`
     * did exactly that, so the one resolution with a real file to open was the
     * one that stopped saying it names where the component was *used*.
     */
    const map = parseSourceMap(
      JSON.stringify({
        version: 3,
        sources: ['app/page.tsx'],
        names: [],
        // One segment at generated 0:0 → source 0, line 10 (0-based), column 4.
        mappings: 'AAUI',
      }),
      { keepSourcesContent: false },
    );

    const before: Resolution = {
      kind: 'declared',
      at: 'call-site',
      name: 'SlowServerData',
      source: '/chunks/ssr/[root-of-the-server].js',
      line: pos1(1),
      column: pos1(1),
      moduleId: '56850',
    };

    const after = resolveDeclaredThrough(before, map);
    expect(after.kind).toBe('declared');
    if (after.kind !== 'declared') return;
    expect(after.source).toBe('app/page.tsx');
    expect(after.at).toBe('call-site');
    expect(after.moduleId).toBe('56850');
  });
});
