/**
 * `flowsnap-mcp install` — register this server once, for every project.
 *
 * The setup was always one line and the line was always right:
 *
 *   claude mcp add flowsnap --scope user -- npx -y flowsnap-mcp
 *
 * `--scope user` is the whole of it, and it is also the whole of the problem:
 * `claude mcp add` defaults to `local` scope, which means *this directory*. Drop
 * the flag — copy the command without it, retype it from memory, follow a blog
 * post that omits it — and FlowSnap works in the folder you set it up in and
 * nowhere else. Nothing announces that. Every other project just reports no
 * flowsnap tools, which reads as the extension being broken rather than the
 * registration being narrow.
 *
 * A flag that must be right and cannot be checked is not a good place to keep a
 * requirement, so it moves in here where it cannot be forgotten. This never
 * takes a scope argument. There is one correct answer and it is compiled in.
 *
 * ### It asks the CLI rather than writing the file
 *
 * Claude Code owns `~/.claude.json` and its shape is Claude Code's to change.
 * `claude mcp add` is the supported way in, so that is what runs. This file
 * *reads* that config, but only ever to report — what is already registered,
 * and what would shadow what — and a read that fails costs a line of output,
 * never the install.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** The server's name in every scope, and what the extension's docs all say. */
const NAME = 'flowsnap';

/**
 * What gets registered, always: the published package, run through npx.
 *
 * Not the path to this file. A registration pointing into an `npx` cache is a
 * registration that stops working the day the cache is cleared, and one
 * pointing into a clone stops working the day the clone moves — which is the
 * single most common way a FlowSnap setup breaks, and it breaks silently.
 */
const ARGS = ['npx', '-y', 'flowsnap-mcp'];

/* Windows resolves a bare command name through the shell; POSIX does not, and
 * running the shell there would mean quoting every argument. */
const SHELL = process.platform === 'win32';

/* --- Output --- */

const out = (line) => process.stdout.write(`${line}\n`);
const ok = (line) => out(`  ✔ ${line}`);
const warn = (line) => out(`  ! ${line}`);
const detail = (line) => out(`    ${line}`);
const blank = () => out('');

/* --- Reading what is already there --- */

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Absent, unreadable, or not JSON. All three mean "nothing to report", and
    // none of them is a reason to refuse to install.
    return null;
  }
}

/**
 * Claude Code's own config file.
 *
 * `CLAUDE_CONFIG_DIR` moves it, and a machine that sets it is exactly the kind
 * that would otherwise get a confident report about a file nobody reads.
 */
function claudeJsonPath() {
  const dir = process.env.CLAUDE_CONFIG_DIR ?? os.homedir();
  return path.join(dir, '.claude.json');
}

/** A registration rendered the way `claude mcp list` renders one. */
function describe(entry) {
  if (!entry || typeof entry !== 'object') return 'unreadable';
  if (typeof entry.url === 'string') return entry.url;
  return [entry.command, ...(Array.isArray(entry.args) ? entry.args : [])].join(' ');
}

/** True when a registration already points at the published package. */
function isOurs(entry) {
  return describe(entry) === ARGS.join(' ');
}

/**
 * Every flowsnap registration on this machine, and the scope each sits in.
 *
 * The three scopes are three different places, and knowing which one answered
 * is the entire diagnosis when a session cannot see the server:
 *
 *   - **user** — `~/.claude.json`, top level. Every project. What we write.
 *   - **local** — `~/.claude.json`, under `projects[<cwd>]`. This directory
 *     only, and `claude mcp add`'s default, so it is the one people end up with
 *     by accident.
 *   - **project** — `.mcp.json` in the working directory, committed and shared.
 *
 * A narrower scope wins inside its directory, so a local or project entry
 * silently replaces the user one for anybody standing in that folder. That is
 * worth a line of output every time.
 */
export function registrations(cwd = process.cwd()) {
  const found = [];
  const config = readJson(claudeJsonPath()) ?? {};

  const user = config.mcpServers?.[NAME];
  if (user) found.push({ scope: 'user', entry: user, where: claudeJsonPath() });

  const local = config.projects?.[cwd]?.mcpServers?.[NAME];
  if (local) found.push({ scope: 'local', entry: local, where: `${claudeJsonPath()} (projects)` });

  const project = readJson(path.join(cwd, '.mcp.json'))?.mcpServers?.[NAME];
  if (project) found.push({ scope: 'project', entry: project, where: path.join(cwd, '.mcp.json') });

  return found;
}

/* --- The CLI --- */

function claude(args) {
  return spawnSync('claude', args, { encoding: 'utf8', shell: SHELL });
}

/** Claude Code's version, or `null` when the CLI is not on this machine's PATH. */
function claudeVersion() {
  const probe = claude(['--version']);
  if (probe.error || probe.status !== 0) return null;
  return probe.stdout.trim();
}

function noClaude() {
  warn('Claude Code is not on your PATH, so there is nothing to register with.');
  detail('Install it, then run this again:');
  detail('  npm install -g @anthropic-ai/claude-code');
  blank();
  detail('Already have it under another name? The command this would have run is:');
  detail(`  claude mcp add ${NAME} --scope user -- ${ARGS.join(' ')}`);
  return 1;
}

/** Whatever the CLI said about why it would not do the thing. */
function relay(result) {
  const said = `${result.stderr ?? ''}${result.stdout ?? ''}`.trim();
  for (const line of (said || 'the claude CLI failed with no output').split('\n')) detail(line);
}

/**
 * The lines about registrations that are not the user-scope one.
 *
 * Printed after a successful install rather than instead of it: the install
 * genuinely worked, and the shadowing is a separate true thing about this
 * directory that the person would otherwise discover by being confused.
 */
function reportShadows(found) {
  for (const other of found) {
    if (other.scope === 'user') continue;
    blank();
    warn(`a ${other.scope}-scope ${NAME} is also registered here`);
    detail(`${other.where} -> ${describe(other.entry)}`);
    detail('it wins inside this directory. remove it with:');
    detail(`  claude mcp remove ${NAME} -s ${other.scope}`);
  }
}

/* --- The commands --- */

export function install({ force = false } = {}) {
  blank();

  if (claudeVersion() === null) return noClaude();

  const found = registrations();
  const user = found.find((entry) => entry.scope === 'user');

  if (user && !force) {
    /*
     * Already there. Two cases, and they are not the same case.
     *
     * Pointing at the published package is the finished state — say so and stop,
     * because re-adding it would only be a way to fail on "already exists".
     * Pointing somewhere else is somebody's deliberate choice (a clone, a fork,
     * a pinned version), and silently replacing it is not this command's call to
     * make. It says what is there and what would replace it, and `--force` is
     * how the person agrees.
     */
    if (isOurs(user.entry)) {
      ok(`${NAME} is already registered at user scope`);
      detail(describe(user.entry));
    } else {
      warn(`${NAME} is already registered at user scope, pointing somewhere else`);
      detail(describe(user.entry));
      detail('leave it, or replace it with the published package:');
      detail('  npx flowsnap-mcp install --force');
      reportShadows(found);
      blank();
      return 1;
    }
  } else {
    // `claude mcp add` refuses a name that exists, so a replacement is a remove
    // and an add. Only reached under --force, where that is what was asked for.
    if (user) claude(['mcp', 'remove', NAME, '--scope', 'user']);

    const added = claude(['mcp', 'add', NAME, '--scope', 'user', '--', ...ARGS]);

    if (added.status !== 0) {
      /*
       * One failure is not a failure: the config was unreadable a moment ago —
       * moved by `CLAUDE_CONFIG_DIR`, or held open — so the entry was there and
       * this could not see it. The CLI's own answer is the authority.
       */
      if (/already exists/i.test(`${added.stderr ?? ''}${added.stdout ?? ''}`)) {
        ok(`${NAME} is already registered at user scope`);
      } else {
        warn(`could not register ${NAME}`);
        relay(added);
        blank();
        return 1;
      }
    } else {
      ok(`registered ${NAME} at user scope`);
      detail(ARGS.join(' '));
    }
  }

  reportShadows(found);
  blank();
  out('  open any Claude Code session and press Send.');
  blank();
  return 0;
}

export function uninstall() {
  blank();

  if (claudeVersion() === null) return noClaude();

  const found = registrations();

  if (!found.some((entry) => entry.scope === 'user')) {
    ok(`${NAME} is not registered at user scope`);
  } else {
    const removed = claude(['mcp', 'remove', NAME, '--scope', 'user']);
    if (removed.status !== 0) {
      warn(`could not remove ${NAME}`);
      relay(removed);
      blank();
      return 1;
    }
    ok(`removed ${NAME} from user scope`);
  }

  // The narrower scopes are somebody else's file — a committed `.mcp.json`, or
  // a per-directory entry — so they are named, never deleted.
  reportShadows(found);
  blank();
  return 0;
}

export function usage() {
  out(`flowsnap-mcp — recorded browser flows, as tools Claude can call.

  npx flowsnap-mcp install      register for every project you open
  npx flowsnap-mcp install --force
                                replace a user-scope registration that points elsewhere
  npx flowsnap-mcp uninstall    remove the user-scope registration
  npx flowsnap-mcp              run the server (what Claude Code does)

Flows are read from ~/.flowsnap/flows. FLOWSNAP_DIR moves them.`);
}

/** Dispatch for the verbs `server.js` hands over. Returns the exit code. */
export function run(command, args = []) {
  switch (command) {
    case 'install':
      return install({ force: args.includes('--force') || args.includes('-f') });
    case 'uninstall':
    case 'remove':
      return uninstall();
    case 'help':
    case '--help':
    case '-h':
      usage();
      return 0;
    default:
      usage();
      return 2;
  }
}
