/**
 * Nothing reads a setting at module scope.
 *
 * The failure this prevents is the quietest one in the mechanism: a setting that
 * appears to work and silently uses the compiled-in default. A value copied into
 * a module-level `const` is read once, at import time — before storage has
 * answered in the extension, and before the first control message has arrived in
 * the MAIN world — and it never changes again. The Settings screen saves it, the
 * storage area holds it, `resolve()` returns it, and the recorder ignores it.
 * Nothing throws and no other test notices.
 *
 * Structural, in the spirit of `tests/react-server-guard.test.ts` and
 * `tests/react-isolation.test.ts`: the guarantee is about what these files never
 * do, and a behavioural test can only cover the cases somebody thought of.
 *
 * "Module scope" is read off the indentation, which is exact here because the
 * repo is Prettier-formatted at two spaces: a statement inside any function or
 * block is indented, and a top-level one is not.
 */

import { globSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const read = (file: string): string => readFileSync(resolve(root, file), 'utf8');

/**
 * Lines that begin a top-level statement: column zero, and not a comment, an
 * import, a type, or a closing brace.
 */
function topLevelStatements(source: string): { line: number; text: string }[] {
  return source
    .split('\n')
    .map((text, index) => ({ line: index + 1, text }))
    .filter(({ text }) => text.length > 0 && !/^\s/.test(text))
    .filter(({ text }) => !/^(import|export type|export interface|type |interface |\}|\)|\*|\/)/.test(text));
}

describe('the injected agent never freezes a setting at import time', () => {
  const agent = read('src/injected/agent.ts');

  it('declares its config once, and nothing else reads it at the top level', () => {
    const reads = topLevelStatements(agent).filter(({ text }) => text.includes('config.'));

    // The declaration itself is `const config: AgentConfig = {`, which mentions
    // `config` but not `config.` — so this list should be empty outright.
    expect(reads).toEqual([]);
  });

  it('reads every config field inside a function, never into a module const', () => {
    // `const X = config.y` at column zero is the exact shape of the bug: the
    // value is taken once, at `document_start`, and the push that follows can
    // never reach it.
    expect(agent).not.toMatch(/^(?:const|let|var)\s+\w+\s*=\s*config\./m);
  });

  it('keeps the compiled-in defaults as the initial value, not as the only value', () => {
    // If `applyConfig` disappeared, every test above would still pass and the
    // agent would use the defaults forever. This is the line that says the
    // channel is wired at all.
    expect(agent).toContain('applyConfig(data.config)');
    expect(agent).toMatch(/function applyConfig\(/);
  });

  it('does not import the settings field table into the page’s own realm', () => {
    // The table carries every description and every default in the product, and
    // it would all be readable by the page. The agent gets a six-field message.
    expect(agent).not.toMatch(/from '.*features\/settings/);
  });
});

describe('no surface resolves its settings once, at import time', () => {
  /** Every file that reads the mechanism rather than the constants. */
  const consumers = [
    'src/content/index.ts',
    'src/background/index.ts',
    'src/core/mcp-bundle.ts',
    'src/ui/settings/main.ts',
    'src/ui/settings/components.ts',
    'src/ui/settings/view.ts',
    'src/ui/settings/file-view.ts',
    'src/ui/popup/main.ts',
    'src/ui/viewer/main.ts',
    'src/ui/viewer/review.ts',
    'src/ui/viewer/annotate.ts',
    'src/ui/viewer/export-dialog.ts',
    'src/ui/viewer/send-dialog.ts',
    'src/ui/theme.ts',
    'src/features/mcp/send.ts',
    'src/features/mcp/remote.ts',
    'src/features/mcp/machine.ts',
    'src/features/flows/store.ts',
    'src/features/export/download.ts',
  ];

  it.each(consumers)('%s', (file) => {
    const source = read(file);
    const offenders = topLevelStatements(source).filter(({ text }) =>
      /^(?:const|let|var)\s+\w+\s*=\s*(?:await\s+)?(?:load|loadSettings|resolve|loadOverrides|loadRecordingSettings|readRecordingStamp|snapshotForRecording|frozen|exportable|planImport|readPending|applyPending|renderLimits|flowRendering|exportDefaults|sendDefaults|openingOptions)\s*\(/.test(
        text,
      ),
    );

    expect(offenders).toEqual([]);
  });

  it('names every consumer there is — a new one must be added to the list', () => {
    // The test above is only as good as this list, so the list is checked
    // against the repo rather than trusted. Anything outside
    // `features/settings` that imports the mechanism and is not named here
    // would be silently unguarded.
    //
    // `recording.js` and `stamp.js` count as the mechanism: a recording's
    // frozen settings are read exactly like any other, and a value taken from
    // the snapshot at import time is the same bug one step further along — the
    // recorder would then use the *previous* recording's answer for every
    // recording that followed, forever.
    //
    // So do `file.js` and `pending.js`: an import resolves the whole object,
    // and a module-level `const plan = planImport(...)` would be a diff computed
    // against whatever storage held when the page loaded — shown to somebody
    // who is about to consent to it.
    //
    // `resolve.js` and `render.js` are Phase 4's, and `render.js` is the one
    // that matters most here: it is bundled into the MCP server, where a value
    // frozen at import time would be a *machine-wide* answer applied to every
    // flow the server ever renders, including the ones carrying their own.
    //
    // `features/mcp/machine.ts` is Phase 5's, and it is the one place a value
    // read at import would be *sent* rather than used: `POST /config` writes a
    // file, so a stale address or a stale override object would persist the
    // wrong answer on the far side of the wire rather than merely acting on it.
    const found = globSync('src/**/*.ts', { cwd: root })
      .map((file) => file.split('\\').join('/'))
      .filter((file) => !file.startsWith('src/features/settings/'))
      .filter((file) =>
        /from '[^']*settings\/(index|fields|agent|recording|stamp|file|pending|resolve|render)\.js'/.test(read(file)),
      )
      .sort();

    expect(found).toEqual([...consumers].sort());
  });
});
