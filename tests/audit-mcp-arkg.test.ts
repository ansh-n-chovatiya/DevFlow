/**
 * Two ways a component's identity used to be lost inside the graph.
 *
 * Both are silent from outside, which is why they get tests rather than a note:
 * one drops an edge and reports the component as having called nothing, and the
 * other drops the write entirely and reports `stored: false`. Neither raises
 * anything a reader of `get_app_architecture` could notice.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

/** Only what these two cases touch. `tests/arkg.test.ts` sets the pattern. */
interface Db {
  prepare(sql: string): { all(): unknown[] };
}

interface Arkg {
  openArkg(path: string): Db;
  closeArkg(): void;
  ingestFlow(flow: Record<string, unknown>, git: unknown): boolean;
  ingestComponentPick(pick: Record<string, unknown>, git: unknown): void;
  getAppArchitecture(): { topComponents: { id: string; calls: unknown[] }[] };
}

const MODULE_URL = new URL('../mcp-server/arkg.js', import.meta.url).href;
const arkg = (await import(/* @vite-ignore */ MODULE_URL)) as Arkg;

const homes: string[] = [];

function graph(): Db {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'devflow-audit-arkg-'));
  homes.push(home);
  return arkg.openArkg(path.join(home, 'arkg.db'));
}

afterEach(() => {
  arkg.closeArkg();
  for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
});

describe('a component merged away part-way through one flow', () => {
  /*
   * `ingestFlow` records the row each flow id landed on as it walks the
   * component table, then writes every `calls`, `renders`, `subscribes_to` and
   * `caused_by` edge afterwards. A *later* component's `reconcileIdentity` can
   * merge away a row an earlier one already recorded — two entries with one
   * name and one file are exactly what it folds, and it breaks its tie on the
   * id — so the edges went out against a row that no longer existed.
   *
   * `repointEdges` has already run by then, so nothing repaired them. The
   * component survived, its endpoint did not, and `get_app_architecture` showed
   * it as having called nothing.
   */
  it('still attributes its edges to the row that survived', () => {
    const db = graph();
    const now = Date.now();

    // `zzz1` is iterated first and sorts second, so it is the one that loses.
    arkg.ingestFlow(
      {
        id: 'f1',
        name: 'flow',
        timestamp: now,
        react: {
          components: {
            zzz1: { name: 'Row', source: 'src/Row.tsx', line: 1 },
            aaa1: { name: 'Row', source: 'src/Row.tsx', line: 1 },
          },
        },
        steps: [
          {
            type: 'click',
            action: 'click',
            url: 'https://app.example/',
            timestamp: now,
            element: { cssSelector: 'button', react: { owner: 'zzz1', chain: ['aaa1', 'zzz1'] } },
            networkCalls: [
              { method: 'GET', url: 'https://app.example/api/things', status: 200, durationMs: 10, timestamp: now },
            ],
          },
        ],
      },
      null,
    );

    const rows = db.prepare('SELECT id FROM arkg_components').all() as { id: string }[];
    expect(rows).toHaveLength(1);
    const survivor = rows[0].id;

    const edges = db
      .prepare('SELECT type, from_node_id, to_node_id FROM arkg_edges')
      .all() as { type: string; from_node_id: string; to_node_id: string }[];

    // Nothing points at a component row that is not there.
    const dangling = edges.filter(
      (edge) => edge.from_node_id !== survivor && edge.from_node_id === 'zzz1',
    );
    expect(dangling).toEqual([]);

    // And the endpoint reaches the reader, which is the thing that was lost.
    const architecture = arkg.getAppArchitecture();
    expect(architecture.topComponents[0].id).toBe(survivor);
    expect(architecture.topComponents[0].calls).toHaveLength(1);

    // A chain whose two neighbours became one row is not a component rendering
    // itself — the guard for that was comparing ids that had since merged.
    expect(edges.filter((edge) => edge.type === 'renders')).toEqual([]);
  });
});

describe('a bare-name pick whose minted key is already taken', () => {
  /*
   * `resolvePick` refuses to guess between two same-named rows, correctly — and
   * the insert then landed on `sha('<name>|')`, which the first of them still
   * held from when it was created unsourced. That threw
   * `UNIQUE constraint failed`, `arkgTry` swallowed it, the endpoint answered
   * `stored: false`, and *every* later bare-name pick of that component was
   * dropped for the life of the database.
   */
  it('records the observation instead of throwing for ever', () => {
    const db = graph();

    // Step 1 mints the key; steps 2 and 3 leave two same-named sourced rows.
    arkg.ingestComponentPick({ name: 'Row' }, null);
    arkg.ingestComponentPick({ name: 'Row', sourceFile: 'src/a.tsx' }, null);
    arkg.ingestComponentPick({ name: 'Row', sourceFile: 'src/b.tsx' }, null);

    expect(() => arkg.ingestComponentPick({ name: 'Row' }, null)).not.toThrow();
    expect(() => arkg.ingestComponentPick({ name: 'Row' }, null)).not.toThrow();

    // The two that could not be told apart are untouched, and the pick that
    // matched neither is its own row — which is what `resolvePick` decided.
    const rows = db
      .prepare('SELECT id, source_file, frequency FROM arkg_components')
      .all() as { id: string; source_file: string | null; frequency: number }[];

    expect(rows.map((row) => row.source_file).sort()).toEqual([null, 'src/a.tsx', 'src/b.tsx']);
    const unsourced = rows.find((row) => row.source_file === null);
    expect(unsourced?.frequency).toBe(2);
    // Still 16 hex, so `MINTED_HERE` reads it as provisional and a flow that
    // names the file can still adopt it.
    expect(unsourced?.id).toMatch(/^[0-9a-f]{16}$/);
  });
});
