/**
 * `mcp-server/rsc.js` — the half of RSC attribution that needs a filesystem.
 *
 * **The manifest contents are transcribed from `.ctx/spike-rsc.md` §4 and §5**,
 * which printed them off a real `next build`: the two client-reference entries
 * with their integer ids `56850` and `7523` — the same integers the production
 * `I` rows carry — and the whole `server-reference-manifest.json` object down to
 * the `codeHash: null`.
 *
 * The parts the spike did *not* print are the parts this suite deliberately
 * varies: it never recorded the JavaScript wrapper around the client-reference
 * entries, so both quotings are built here and both must read the same, and it
 * never recorded what a half-written or absent build looks like, so those are
 * asserted as distinct reasons rather than as one silence.
 *
 * `mcp-server/` is a second npm package with no types, reached through a dynamic
 * import of a file URL the way `otel-store.test.ts` reaches its own.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

interface Reading<T> {
  available: boolean;
  reason?: string;
  normalized?: boolean;
  modules?: Map<string, T>;
  actions?: Map<string, T>;
}

interface Entry {
  id: string;
  file: string;
  exportName: string;
  chunks?: string[];
  runtime?: string;
  workers?: string[];
}

interface RscModule {
  rscEnabled(): boolean;
  nextDirFor(root: string, distDir?: string): string | null;
  readClientReferences(root: string, distDir?: string): Reading<Entry>;
  readServerReferences(root: string, distDir?: string): Reading<Entry>;
  readManifests(root: string, distDir?: string): { client: Reading<Entry>; server: Reading<Entry> };
  forgetManifests(): void;
  fileForModuleId(root: string, id: unknown, distDir?: string): Entry & { found: boolean; reason?: string };
  fileForActionId(root: string, id: unknown, distDir?: string): Entry & { found: boolean; reason?: string };
  rscReading(root: string, distDir?: string): Record<string, unknown>;
}

const here = dirname(fileURLToPath(import.meta.url));
const rsc = (await import(pathToFileURL(join(here, '..', 'mcp-server', 'rsc.js')).href)) as RscModule;

// ── The fixtures ─────────────────────────────────────────────────────────────

/**
 * The two entries §4 printed, as an object literal.
 *
 * The wrapper is this file's invention — the spike printed the mapping and not
 * the assignment around it — which is exactly why the scanner is wrapper
 * agnostic and why the escaped form below is tested beside this one.
 */
const CLIENT_ENTRIES =
  '{"[project]/app/components/ClientCounter.tsx":{"id":56850,"name":"*","chunks":["/_next/static/chunks/3fntmmi971322.js","/_next/static/chunks/0h52v0jkvejiz.js"],"async":false},' +
  '"[project]/app/components/ActionForm.tsx":{"id":7523,"name":"*","chunks":["/_next/static/chunks/3fntmmi971322.js"],"async":false}}';

const PLAIN_MANIFEST = `globalThis.__RSC_MANIFEST=globalThis.__RSC_MANIFEST||{};globalThis.__RSC_MANIFEST["/page"]=${CLIENT_ENTRIES}`;

/** The same entries embedded as a JSON *string*, which is the other quoting. */
const ESCAPED_MANIFEST = `globalThis.__RSC_MANIFEST["/page"]=${JSON.stringify(CLIENT_ENTRIES)}`;

/** spike-rsc §5, `.next/server/server-reference-manifest.json`, verbatim. */
const SERVER_MANIFEST = JSON.stringify({
  node: {
    '40f43782738bb9c45a0870d2dcbb114f82c8acb929': {
      workers: { 'app/page': { moduleId: 57526, async: false, codeHash: null } },
      filename: 'app/actions.ts',
      exportedName: 'echoAction',
    },
  },
  edge: {},
  encryptionKey: 'SPIKE_ENCRYPTION_KEY_NOT_TO_BE_RETURNED',
});

let root = '';

function build(options: { client?: string; server?: string } = {}): void {
  const serverDir = join(root, '.next', 'server', 'app');
  mkdirSync(serverDir, { recursive: true });
  if (options.client !== undefined) {
    writeFileSync(join(serverDir, 'page_client-reference-manifest.js'), options.client);
  }
  if (options.server !== undefined) {
    writeFileSync(join(root, '.next', 'server', 'server-reference-manifest.json'), options.server);
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'devflow-rsc-'));
  delete process.env.DEVFLOW_RSC;
  rsc.forgetManifests();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  delete process.env.DEVFLOW_RSC;
  rsc.forgetManifests();
});

// ── The gate ─────────────────────────────────────────────────────────────────

describe('the switch', () => {
  /*
   * On by default and `DEVFLOW_RSC=0` to switch off — `git.js`'s direction and
   * not `replay.js`'s, because this reads files under a root the server already
   * opens source from and runs no subprocess.
   */
  it('is on unless it is switched off', () => {
    expect(rsc.rscEnabled()).toBe(true);
    process.env.DEVFLOW_RSC = '0';
    expect(rsc.rscEnabled()).toBe(false);
  });

  it('reads nothing at all when switched off', () => {
    build({ client: PLAIN_MANIFEST, server: SERVER_MANIFEST });
    process.env.DEVFLOW_RSC = '0';

    expect(rsc.readClientReferences(root).reason).toBe('disabled');
    expect(rsc.readServerReferences(root).reason).toBe('disabled');
    expect(rsc.rscReading(root)).toEqual({ available: false, reason: 'disabled' });
  });
});

// ── Containment ──────────────────────────────────────────────────────────────

describe('nextDirFor', () => {
  it('is the build output under the root', () => {
    expect(rsc.nextDirFor('/tmp/app')).toBe(join('/tmp/app', '.next', 'server'));
  });

  /*
   * The root is chosen by the caller and the `distDir` could be too. A dist
   * directory that walks out of the project would make this a file reader for
   * the whole disk, which is the containment `get_source_snippet` already draws.
   */
  it('refuses a dist directory that escapes the root', () => {
    expect(rsc.nextDirFor('/tmp/app', '../../etc')).toBeNull();
  });
});

// ── Client references ────────────────────────────────────────────────────────

describe('readClientReferences', () => {
  it('joins the integer a production I row carries to the file it names', () => {
    build({ client: PLAIN_MANIFEST });
    const reading = rsc.readClientReferences(root);

    expect(reading.available).toBe(true);
    expect(reading.modules?.get('56850')?.exportName).toBe('*');
    // `endsWith`, not equality, because the leading `[project]/` survives until
    // `core.js` carries `normalizeModulePath` — see the tidying test below.
    expect(reading.modules?.get('56850')?.file.endsWith('app/components/ClientCounter.tsx')).toBe(
      true,
    );
    expect(reading.modules?.get('7523')?.file.endsWith('app/components/ActionForm.tsx')).toBe(true);
  });

  /*
   * The two quotings must produce identical readings. Getting this wrong looks
   * like "your app has no client components" rather than like a parse failure,
   * which is the failure mode that would survive a review.
   */
  it('reads the escaped quoting identically to the plain one', () => {
    build({ client: ESCAPED_MANIFEST });
    const escaped = rsc.readClientReferences(root);
    rsc.forgetManifests();
    build({ client: PLAIN_MANIFEST });
    const plain = rsc.readClientReferences(root);

    expect([...(escaped.modules ?? [])].map(([k, v]) => [k, v.file])).toEqual(
      [...(plain.modules ?? [])].map(([k, v]) => [k, v.file]),
    );
  });

  /*
   * The tidying is `core/rsc/flight.ts`'s rule, reached through `core.js`, and
   * there is deliberately no second copy of it here — one rule in one place is
   * the only way the wire half and the filesystem half agree about what a file
   * is called.
   *
   * `mcp-bundle.ts` does not export it yet and is another unit's file, so today
   * the raw key comes back and `normalized` says `false`. That is on the
   * integrator queue, and this assertion is written so that landing the export
   * turns the answer from `[project]/app/…` into `app/…` without turning this
   * test red: what is pinned is that `normalized` never disagrees with the path
   * it actually produced.
   */
  it('ties the normalized flag to the path it really returned', () => {
    build({ client: PLAIN_MANIFEST });
    const reading = rsc.readClientReferences(root);
    const file = reading.modules?.get('56850')?.file;

    expect(file?.endsWith('app/components/ClientCounter.tsx')).toBe(true);
    expect(reading.normalized).toBe(file === 'app/components/ClientCounter.tsx');
  });

  /*
   * Three ways of having nothing, and three different things for the reader to
   * do about them. One silence would send all three to the wrong fix.
   */
  it('tells no build apart from a build with no manifest', () => {
    expect(rsc.readClientReferences(root).reason).toBe('no-build');
    rsc.forgetManifests();
    build({ server: SERVER_MANIFEST });
    expect(rsc.readClientReferences(root).reason).toBe('no-manifest');
  });

  it('finds no entries in a manifest whose shape it does not know, without throwing', () => {
    build({ client: 'globalThis.__RSC_MANIFEST = somethingElseEntirely();' });
    const reading = rsc.readClientReferences(root);
    expect(reading.available).toBe(true);
    expect(reading.modules?.size).toBe(0);
  });

  /*
   * Never `eval`, never `import()`. The manifest is the user's build output
   * reached by path, and running it would make this server execute code because
   * a model asked a question.
   */
  it('does not execute the manifest', () => {
    build({
      client: `globalThis.SPIKE_RSC_MANIFEST_WAS_EXECUTED = true;\n${PLAIN_MANIFEST}`,
    });
    rsc.readClientReferences(root);

    expect((globalThis as Record<string, unknown>).SPIKE_RSC_MANIFEST_WAS_EXECUTED).toBeUndefined();
  });
});

// ── Server references ────────────────────────────────────────────────────────

describe('readServerReferences', () => {
  it('joins a next-action id to its file and export', () => {
    build({ server: SERVER_MANIFEST });
    const entry = rsc.fileForActionId(root, '40f43782738bb9c45a0870d2dcbb114f82c8acb929');

    expect(entry).toMatchObject({
      found: true,
      file: 'app/actions.ts',
      exportName: 'echoAction',
      runtime: 'node',
      workers: ['app/page'],
    });
  });

  /** The one key in that file that is a secret, and it is not an attribution. */
  it('never returns the encryption key', () => {
    build({ server: SERVER_MANIFEST });
    const reading = rsc.readServerReferences(root);
    expect(JSON.stringify([...(reading.actions ?? [])])).not.toContain('SPIKE_ENCRYPTION_KEY');
  });

  it('says not-in-manifest for an id from another build', () => {
    build({ server: SERVER_MANIFEST });
    // The dev id for the same function — spike §5: ids are build-specific.
    expect(rsc.fileForActionId(root, '407b166389441c1666eec1bde1af6e797f736ab3f6')).toMatchObject({
      found: false,
      reason: 'not-in-manifest',
    });
  });

  it('degrades to a reason on malformed JSON rather than throwing', () => {
    build({ server: '{ this is not json' });
    expect(rsc.readServerReferences(root).reason).toBe('unreadable');
  });
});

// ── The lookups and the summary ──────────────────────────────────────────────

describe('fileForModuleId', () => {
  it('takes the id as the wire sends it — a number — and answers', () => {
    build({ client: PLAIN_MANIFEST });
    const entry = rsc.fileForModuleId(root, 56850);
    expect(entry.found).toBe(true);
    expect(entry.file.endsWith('app/components/ClientCounter.tsx')).toBe(true);
  });

  it('carries the reason through when there is no build to read', () => {
    expect(rsc.fileForModuleId(root, 56850)).toMatchObject({ found: false, reason: 'no-build' });
  });
});

describe('rscReading', () => {
  it('counts both manifests and says plainly what it cannot do', () => {
    build({ client: PLAIN_MANIFEST, server: SERVER_MANIFEST });
    expect(rsc.rscReading(root)).toMatchObject({
      available: true,
      clientModules: 2,
      serverActions: 1,
      // Not an empty result to be inferred from — the finding, stated.
      serverComponents: 'absent',
    });
  });

  it('is unavailable, with a reason, on a project that was never built', () => {
    expect(rsc.rscReading(root)).toMatchObject({ available: false, reason: 'no-build' });
  });
});
