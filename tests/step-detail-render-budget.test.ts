/**
 * The half of a per-component budget that is easy to leave unsaid.
 *
 * `blame()` caps the changes it reports for one component and records what it
 * kept back in `moreChanges`. The number is written by the evaluator, travels
 * on the step, survives the save — and until the tool prints it, none of that
 * is visible from outside: the reader sees eight changed props and has no way
 * to tell that from a component where eight was all there was.
 *
 * Which is the difference between a prop worth chasing and a parent
 * re-rendering wholesale, and it is the same failure this project has already
 * had twice — `subscribes_to` edges and `topStateKeys` were both written and
 * unreadable until a second pass added the rendering. A field no tool prints
 * does not exist from outside, so the write and the renderer are one
 * deliverable and this is the renderer's half of it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, writeFlow, type McpSession } from './helpers/mcp-server.js';

const NOW = Date.UTC(2026, 8, 1, 11, 0);

let home: string;
let session: McpSession;

beforeAll(async () => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-render-budget-'));
  fs.mkdirSync(path.join(home, 'flows'), { recursive: true });

  writeFlow(home, {
    id: 'flow-budget',
    name: 'Type in the filter',
    timestamp: NOW,
    startUrl: 'https://shop.example.com/list',
    errorCount: 0,
    schemaVersion: 1,
    react: {
      detected: true,
      components: {
        'grid-0': { name: 'DataGrid', status: 'resolved', source: 'src/DataGrid.tsx', line: 9 },
        'cell-0': { name: 'Cell', status: 'resolved', source: 'src/Cell.tsx', line: 3 },
      },
    },
    renders: { read: true },
    steps: [
      {
        type: 'click',
        url: 'https://shop.example.com/list',
        timestamp: NOW + 1,
        action: 'Clicked "Sort"',
        stepNumber: 1,
        element: { tag: 'button', cssSelector: 'button.sort' },
        consoleLogs: [],
        networkCalls: [],
        renders: [
          {
            component: 'grid-0',
            props: [
              { key: 'rows', before: 2, after: 3 },
              { key: 'sort', before: 'asc', after: 'desc' },
            ],
            // Eleven more were seen and did not fit the per-component budget.
            moreChanges: 11,
          },
          // The neighbouring component fitted, and must say nothing about a
          // budget it never spent.
          { component: 'cell-0', props: [{ key: 'value', before: 1, after: 2 }] },
        ],
      },
    ],
  });

  session = await startServer({ home });
}, 30_000);

afterAll(() => session?.stop());

const renderPart = (): Promise<string> =>
  session.call('get_step_detail', { id: 'flow-budget', step: 1, include: ['render'] });

describe('changes the per-component budget kept back', () => {
  it('says how many more were seen, rather than showing two and implying that was all', async () => {
    const text = await renderPart();
    expect(text).toContain('11 more changes on this component');
  });

  it('names the setting that decides it, so the number is a choice and not a mystery', async () => {
    expect(await renderPart()).toContain('recording.renderMaxChanges');
  });

  it('says nothing about a budget the component did not spend', async () => {
    const text = await renderPart();
    // One line only: `Cell` fitted, and a line under it saying "and 0 more"
    // would be the kind of always-on noise that makes a real one unreadable.
    expect(text.match(/more change/g) ?? []).toHaveLength(1);
  });

  /**
   * The count is of *changes on one component*, never of renders. Nothing this
   * feature prints may imply a render count — the data is two readings, not a
   * commit hook, and cannot support one.
   */
  it('counts changes, not renders', async () => {
    const text = await renderPart();
    expect(text).toMatch(/more changes? on this component/);
    expect(text).not.toMatch(/\d+\s+(re-)?renders\b/i);
    expect(text).not.toMatch(/rendered \d+ times/i);
  });
});
