/**
 * `flowsnap-mcp install` — the scope, taken out of the user's hands.
 *
 * The setup command was always documented correctly and was always one flag
 * away from being wrong: `claude mcp add` defaults to `local` scope, which is
 * *this directory*, so a command copied without `--scope user` produces a
 * FlowSnap that works in one folder and is silently absent everywhere else.
 * Nothing reports that — other projects just have no flowsnap tools, which
 * reads as the extension being broken.
 *
 * So the claim under test is narrow and worth pinning exactly: **whatever else
 * this command does, the registration it writes is user scope, every time.**
 * The first case asserts the argv verbatim, because that string is the entire
 * feature and a reordering that dropped the flag would still "work" against a
 * looser assertion.
 *
 * Against a real spawned process and a fake `claude` on PATH, for the reason
 * `helpers/mcp-server.ts` gives: `server.js` is a script with top-level side
 * effects and no typecheck over it. The fake also buys the thing a real CLI
 * could not — the exact arguments, recorded, with nothing registered on the
 * machine running the suite.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../mcp-server/server.js', import.meta.url));

const homes: string[] = [];

/**
 * One fake `claude`, made once, driven per case by the environment.
 *
 * It was written per machine, next to that machine's home, which is the obvious
 * shape and costs about half a second every time: macOS inspects a newly
 * written executable the first time it is run, so eleven fakes meant eleven
 * scans and a file that took eight seconds. The behaviour that actually varies
 * between cases — where to record the argv, and whether `mcp add` should fail —
 * is two strings, and two strings travel fine in `env`.
 */
const shared = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsnap-install-bin-'));
const BIN = path.join(shared, 'bin');
fs.mkdirSync(BIN);
fs.writeFileSync(
  path.join(BIN, 'claude'),
  '#!/bin/sh\n' +
    'echo "$@" >> "$FAKE_CALLS"\n' +
    // `--version` has to succeed or the command stops before it starts.
    '[ "$1" = "--version" ] && echo "2.0.31 (Claude Code)" && exit 0\n' +
    // The failure arm: `mcp add` refusing, in the words a real CLI uses.
    '[ -n "$FAKE_ADD_FAILS" ] && [ "$2" = "add" ] && echo "$FAKE_ADD_FAILS" >&2 && exit 1\n' +
    'exit 0\n',
  { mode: 0o755 },
);

afterAll(() => {
  for (const home of homes) fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(shared, { recursive: true, force: true });
});

interface Run {
  readonly code: number;
  readonly out: string;
  /** Every `claude` invocation the command made, one argv per line. */
  readonly calls: string[];
}

interface Machine {
  readonly home: string;
  readonly cwd: string;
  readonly calls: string;
  /** `false` is the machine that has never installed Claude Code. */
  readonly hasClaude: boolean;
  readonly addFails: string;
}

/**
 * A machine: a home with a `~/.claude.json`, a working directory, and — unless
 * the case is about its absence — the fake `claude` above on PATH.
 */
function machine(options: {
  claudeJson?: unknown;
  mcpJson?: unknown;
  withClaude?: boolean;
  addFails?: string;
}): Machine {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'flowsnap-install-'));
  homes.push(home);

  const cwd = path.join(home, 'project');
  const calls = path.join(home, 'calls.txt');
  fs.mkdirSync(cwd);
  fs.writeFileSync(calls, '');

  fs.writeFileSync(
    path.join(home, '.claude.json'),
    JSON.stringify(options.claudeJson ?? {}, null, 2),
  );
  if (options.mcpJson) {
    fs.writeFileSync(path.join(cwd, '.mcp.json'), JSON.stringify(options.mcpJson, null, 2));
  }

  return {
    home,
    cwd,
    calls,
    hasClaude: options.withClaude !== false,
    addFails: options.addFails ?? '',
  };
}

function run(where: Machine, args: string[]): Run {
  /*
   * Vitest's own `NODE_OPTIONS` are not inherited.
   *
   * They carry the loader that instruments this suite, and a child that boots
   * under it pays a second of startup to register hooks for a process that runs
   * one function and exits — twelve times over, on the critical path of a suite
   * that otherwise finishes in four seconds. The subject here is a plain Node
   * script; it should be spawned as one.
   */
  const env = { ...process.env };
  delete env.NODE_OPTIONS;

  const result = spawnSync(process.execPath, [SERVER, ...args], {
    cwd: where.cwd,
    encoding: 'utf8',
    env: {
      ...env,
      /*
       * A machine with no Claude Code gets a PATH with no Claude Code — which
       * means dropping the suite's own, since the developer running it almost
       * certainly has the CLI installed and would otherwise be testing their
       * machine rather than the case.
       */
      PATH: where.hasClaude ? `${BIN}${path.delimiter}${env.PATH ?? ''}` : shared,
      HOME: where.home,
      FAKE_CALLS: where.calls,
      FAKE_ADD_FAILS: where.addFails,
      // Set explicitly as well as through HOME: the installer honours it, and a
      // machine that sets it is exactly the one that would otherwise get a
      // confident report about a file nobody reads.
      CLAUDE_CONFIG_DIR: where.home,
    },
  });

  return {
    code: result.status ?? -1,
    out: `${result.stdout}${result.stderr}`,
    calls: fs.readFileSync(where.calls, 'utf8').split('\n').filter(Boolean),
  };
}

/** A user-scope registration pointing at the published package. */
const REGISTERED = {
  mcpServers: { flowsnap: { type: 'stdio', command: 'npx', args: ['-y', 'flowsnap-mcp'] } },
};

describe('installing registers for every project, not for one directory', () => {
  it('adds at user scope, with the published package, and nothing else', () => {
    const where = machine({});
    const result = run(where, ['install']);

    expect(result.code).toBe(0);
    /*
     * Verbatim. This one string is the whole feature: `--scope user` is what
     * separates "works everywhere" from "works in the folder you were standing
     * in", and it is invisible in every symptom of its own absence.
     */
    expect(result.calls).toEqual([
      '--version',
      'mcp add flowsnap --scope user -- npx -y flowsnap-mcp',
    ]);
    expect(result.out).toContain('registered flowsnap at user scope');
  });

  it('takes no scope from the caller, at any spelling', () => {
    // There is one correct scope and it is compiled in. A command that could be
    // told otherwise would be the flag this exists to remove, wearing a hat.
    const source = fs.readFileSync(
      fileURLToPath(new URL('../mcp-server/install.js', import.meta.url)),
      'utf8',
    );
    for (const scope of ['local', 'project']) {
      expect(source.includes(`--scope ${scope}`), scope).toBe(false);
    }
    expect(source.match(/'--scope'/g)).not.toBeNull();
  });

  it('is safe to run twice: an identical registration is left alone', () => {
    const where = machine({ claudeJson: REGISTERED });
    const result = run(where, ['install']);

    expect(result.code).toBe(0);
    // No `mcp add`, because `claude mcp add` refuses a name that exists and the
    // second run would otherwise report a failure for the finished state.
    expect(result.calls).toEqual(['--version']);
    expect(result.out).toContain('already registered at user scope');
  });

  it('refuses to overwrite a registration pointing somewhere else, until forced', () => {
    const pinned = {
      mcpServers: { flowsnap: { type: 'stdio', command: 'node', args: ['/old/clone/server.js'] } },
    };

    const first = run(machine({ claudeJson: pinned }), ['install']);
    expect(first.code).toBe(1);
    expect(first.calls).toEqual(['--version']);
    expect(first.out).toContain('node /old/clone/server.js');
    expect(first.out).toContain('--force');

    const forced = run(machine({ claudeJson: pinned }), ['install', '--force']);
    expect(forced.code).toBe(0);
    // A replacement is a remove and an add, in that order — `mcp add` refuses a
    // name that is already there.
    expect(forced.calls).toEqual([
      '--version',
      'mcp remove flowsnap --scope user',
      'mcp add flowsnap --scope user -- npx -y flowsnap-mcp',
    ]);
  });

  it('names the narrower registration that would shadow it in this directory', () => {
    /*
     * The diagnosis nobody makes on their own. A `.mcp.json` in the working
     * directory wins over the user-scope entry for anyone standing in that
     * folder, so the install genuinely worked *and* this directory will still
     * run something else — two true things, and only the first is obvious.
     */
    const where = machine({
      claudeJson: REGISTERED,
      mcpJson: { mcpServers: { flowsnap: { command: 'node', args: ['./mcp-server/server.js'] } } },
    });
    const result = run(where, ['install']);

    expect(result.code).toBe(0);
    expect(result.out).toContain('a project-scope flowsnap is also registered here');
    expect(result.out).toContain('node ./mcp-server/server.js');
    expect(result.out).toContain('claude mcp remove flowsnap -s project');
  });

  it('says the CLI is missing rather than reporting success into the void', () => {
    const where = machine({ withClaude: false });
    const result = run(where, ['install']);

    expect(result.code).toBe(1);
    expect(result.out).toContain('not on your PATH');
    // The manual command, so somebody with `claude` under another name is not
    // left with nothing.
    expect(result.out).toContain('claude mcp add flowsnap --scope user -- npx -y flowsnap-mcp');
  });

  it('treats the CLI saying it already exists as the finished state', () => {
    // Reached when this command's own read of the config came back empty but
    // the entry was there. The CLI is the authority on its own file.
    const where = machine({ addFails: 'MCP server flowsnap already exists in user config' });
    const result = run(where, ['install']);

    expect(result.code).toBe(0);
    expect(result.out).toContain('already registered at user scope');
  });

  it('relays a real failure instead of claiming it worked', () => {
    const where = machine({ addFails: 'EACCES: permission denied' });
    const result = run(where, ['install']);

    expect(result.code).toBe(1);
    expect(result.out).toContain('could not register flowsnap');
    expect(result.out).toContain('EACCES');
  });
});

describe('the rest of the command surface', () => {
  it('removes the user-scope registration, and only that one', () => {
    const where = machine({
      claudeJson: REGISTERED,
      mcpJson: { mcpServers: { flowsnap: { command: 'node', args: ['./mcp-server/server.js'] } } },
    });
    const result = run(where, ['uninstall']);

    expect(result.code).toBe(0);
    expect(result.calls).toEqual(['--version', 'mcp remove flowsnap --scope user']);
    // Somebody else's committed file. Named, never deleted.
    expect(fs.existsSync(path.join(where.cwd, '.mcp.json'))).toBe(true);
    expect(result.out).toContain('claude mcp remove flowsnap -s project');
  });

  it('does not report removing what was never there', () => {
    const result = run(machine({}), ['uninstall']);

    expect(result.code).toBe(0);
    expect(result.calls).toEqual(['--version']);
    expect(result.out).toContain('is not registered at user scope');
  });

  it('answers a typo with the usage rather than a server nobody is speaking to', () => {
    /*
     * The failure this prevents: `flowsnap-mcp instal` falls through to server
     * mode, binds the port, sits on a stdio transport with no client, and looks
     * to the person who typed it like a command that hung.
     */
    const result = run(machine({}), ['instal']);

    expect(result.code).toBe(2);
    expect(result.out).toContain('npx flowsnap-mcp install');
    expect(result.calls).toEqual([]);
  });

  it('prints the usage on request', () => {
    const result = run(machine({}), ['--help']);

    expect(result.code).toBe(0);
    expect(result.out).toContain('register for every project you open');
  });
});
