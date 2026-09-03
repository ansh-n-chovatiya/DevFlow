/**
 * Accessibility findings on the way from a stored step to what a model reads.
 *
 * Two things this proves that no other test can. The first is the part index's
 * three states, which is the whole of the honesty here: "audited and clean" and
 * "never looked at" are different answers, and only the recording's own settings
 * can tell them apart — a blank row would let the second read as the first.
 *
 * The second is that there is **one renderer**. The a11y part had its own copy
 * of the grouping for a single commit, which is the two-markdown-renderers
 * mistake `src/core/mcp-bundle.ts` exists because of. The server now builds
 * `where` — the component name and file, which `core/` has no flow to resolve —
 * and calls `renderA11y` for everything else, and the assertions below hold
 * both halves of that split.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

let home = '';
let session: McpSession;

const finding = (over: Record<string, unknown> = {}) => ({
  check: 'name-missing',
  wcag: '4.1.2 Name, Role, Value',
  level: 'A',
  label: 'button#buy',
  detail: 'a button with no accessible name',
  caveat: 'the name is computed by the common paths only',
  component: 'cmp_cart',
  ...over,
});

function flow(id: string, enabled: boolean, a11y?: Record<string, unknown>) {
  return {
    id,
    name: `Recording ${id}`,
    timestamp: 1_700_000_000_000,
    startUrl: 'http://localhost:5173/cart',
    schemaVersion: 1,
    settings: { 'recording.a11y': enabled },
    react: {
      components: {
        cmp_cart: { name: 'CartButton', status: 'resolved', source: 'src/Cart.tsx', line: 12 },
      },
    },
    steps: [
      {
        type: 'click',
        url: 'http://localhost:5173/cart',
        timestamp: 1_700_000_000_000,
        action: 'Clicked "Buy"',
        stepNumber: 1,
        element: { tag: 'button', cssSelector: '#buy', react: { owner: 'cmp_cart', chain: ['cmp_cart'] } },
        networkCalls: [],
        consoleLogs: [],
        ...(a11y ? { a11y } : {}),
      },
    ],
  };
}

beforeAll(async () => {
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-a11y-')));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });

  writeFlow(home, flow('off', false));
  writeFlow(home, flow('clean', true, { findings: [] }));
  writeFlow(home, flow('found', true, {
    findings: [finding(), finding({ label: 'div#menu', component: undefined }), finding({
      check: 'positive-tabindex',
      wcag: '2.4.3 Focus Order',
      label: 'div#skip',
      detail: 'tabindex="4" pulls this out of document order',
      caveat: undefined,
    })],
    note: 'the walk stopped at 1500 elements',
  }));

  session = await startServer({ home });
}, 20_000);

afterAll(() => {
  session?.stop();
  if (home) fs.rmSync(home, { recursive: true, force: true });
});

describe('the part index', () => {
  it('says a recording was never audited, rather than leaving the row blank', async () => {
    const index = await session.call('get_step_detail', { id: 'off', step: 1 });
    expect(index).toContain('not audited');
  });

  it('tells "audited and clean" apart from "never looked at"', async () => {
    expect(await session.call('get_step_detail', { id: 'clean', step: 1 }))
      .toContain('audited, nothing found');
  });

  it('counts the violations when there are some', async () => {
    expect(await session.call('get_step_detail', { id: 'found', step: 1 }))
      .toContain('3 accessibility violations');
  });
});

describe('the part itself', () => {
  const part = () => session.call('get_step_detail', { id: 'found', step: 1, include: ['a11y'] });

  it('groups by success criterion, biggest group first', async () => {
    const text = await part();
    expect(text).toContain('4.1.2 Name, Role, Value (level A) — 2');
    expect(text).toContain('2.4.3 Focus Order (level A) — 1');
    expect(text.indexOf('4.1.2')).toBeLessThan(text.indexOf('2.4.3'));
  });

  it('resolves the component to its name and file, which is the half core cannot do', async () => {
    expect(await part()).toContain('in CartButton src/Cart.tsx:12');
  });

  it('keeps a finding whose component never resolved, rather than dropping it', async () => {
    // Where it is is still where it is.
    expect(await part()).toContain('div#menu');
  });

  it('carries the caveat and what was not checked', async () => {
    const text = await part();
    expect(text).toContain('computed by the common paths only');
    expect(text).toContain('the walk stopped at 1500 elements');
  });

  it('says no fix was generated', async () => {
    expect(await part()).toContain('No fix is generated');
  });

  it('says nothing about a clean page being clean when it was never audited', async () => {
    const text = await session.call('get_step_detail', { id: 'off', step: 1, include: ['a11y'] });
    expect(text).toContain('says nothing about whether the page has');
    expect(text).toContain('only that nobody looked');
  });
});

describe('the flow summary', () => {
  it('carries the count when the audit ran', async () => {
    expect(await session.call('get_flow_summary', { id: 'found' })).toContain('Accessibility: 3 violations');
  });

  it('says audited-and-clean, which is a real result', async () => {
    expect(await session.call('get_flow_summary', { id: 'clean' }))
      .toContain('Accessibility: audited, nothing found');
  });

  it('stays silent on a recording that never audited, rather than saying so on every flow', async () => {
    expect(await session.call('get_flow_summary', { id: 'off' })).not.toContain('Accessibility:');
  });
});
