// Wires this clone up to graphify: the assistant config that travels in the
// repo, the git hooks that do not, and a first build of the graph itself.
//
// Runs from `postinstall`, so it has one hard rule: it must never fail an
// install. graphify is a Python tool and a plain `npm install` cannot bring it
// along, so "not installed" is an ordinary outcome here, not an error — the
// script says how to get it and exits 0. Every step is idempotent; running it
// again is the documented way to repair a half-configured checkout.

import { execFileSync } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GRAPH = join(ROOT, 'graphify-out', 'graph.json');
const REPORT = join(ROOT, 'graphify-out', 'GRAPH_REPORT.md');

const args = process.argv.slice(2);
const rebuild = args.includes('--rebuild');
// `postinstall` passes this. It downgrades a missing graphify from a printed
// walkthrough to a single line, because most people running `npm install` are
// here for the extension and have not opted into any of this.
const quiet = args.includes('--quiet');

const say = (msg) => console.log(msg);
const step = (msg) => console.log(`  ${msg}`);

/**
 * Resolves the graphify executable, or null when it is not installed.
 *
 * Walks PATH rather than shelling out to `command -v`/`where`: spawning a shell
 * to answer this earns a Node deprecation warning on every `npm install`, and
 * the lookup is a few lines either way.
 */
function findGraphify() {
  // PATHEXT is what makes `graphify` match `graphify.exe` on Windows.
  const exts = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';')
    : [''];
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const candidate = join(dir, `graphify${ext}`);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // Not here, or not executable — keep looking.
      }
    }
  }
  return null;
}

/**
 * Runs a graphify subcommand. Returns false instead of throwing: one failing
 * step should not strand the ones after it, and none of them are load-bearing
 * enough to justify failing an install.
 */
function graphify(bin, argv, label) {
  try {
    execFileSync(bin, argv, { cwd: ROOT, stdio: 'pipe', encoding: 'utf8' });
    step(`✔ ${label}`);
    return true;
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || '').trim().split('\n')[0];
    step(`✘ ${label}${detail ? ` — ${detail}` : ''}`);
    return false;
  }
}

const bin = findGraphify();

if (!bin) {
  if (quiet) {
    say('graphify not found — `uv tool install graphifyy` then `npm run graphify:setup` enables graph-aware AI sessions.');
  } else {
    say('graphify is not installed, so the knowledge graph was not built.\n');
    say('It is a Python tool (3.10+) and installs on its own:\n');
    say('    uv tool install graphifyy      # or: pipx install graphifyy\n');
    say('Then run `npm run graphify:setup` to finish wiring up this clone.');
    say('Everything else in FlowSnap works without it — the graph only makes');
    say('Claude Code and Antigravity better at navigating this codebase.');
  }
  process.exit(0);
}

say('Setting up graphify…');

// The repo already carries CLAUDE.md, .claude/settings.json, .agent/rules and
// .agent/workflows in git, so these two are usually no-ops that rewrite what is
// already there. They run anyway because they also install the user-level skill
// that Antigravity loads from ~/.agent/skills, which git cannot ship.
graphify(bin, ['claude', 'install'], 'Claude Code — CLAUDE.md section + PreToolUse hook');
graphify(bin, ['antigravity', 'install'], 'Antigravity — .agent/ rules, workflow and skill');

// The real reason this script exists. Hooks live in .git/hooks, which is not
// part of the repository, so a clone has none — without this step the graph
// would only ever be as fresh as the last time somebody rebuilt it by hand.
if (existsSync(join(ROOT, '.git'))) {
  graphify(bin, ['hook', 'install'], 'git hooks — rebuild after commit and on branch switch');
} else {
  step('· git hooks skipped (not a git checkout)');
}

/**
 * True when the graph on disk was built from a commit other than HEAD.
 *
 * "Present" is not the same as "usable". A clone that committed before the
 * hooks were installed has a graph describing code that has since moved, and a
 * stale graph is worse than none: it reads as authoritative. Rebuilding costs a
 * second, so this errs toward rebuilding whenever it cannot prove freshness.
 */
function isStale() {
  if (!existsSync(REPORT)) return true;
  try {
    const built = /^- Built from commit: `([0-9a-f]{7,})`/m.exec(readFileSync(REPORT, 'utf8'));
    if (!built) return true;
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: ROOT,
      stdio: 'pipe',
      encoding: 'utf8',
    }).trim();
    return !head.startsWith(built[1]);
  } catch {
    // Not a checkout, or no commits yet. Nothing to be stale against.
    return false;
  }
}

if (rebuild || !existsSync(GRAPH)) {
  // AST only: no API key, no network, ~1s on this repo. The semantic pass over
  // docs and images is the part that costs anything, and it is opt-in via
  // `/graphify .` inside an assistant.
  graphify(bin, ['update', '.'], 'knowledge graph built at graphify-out/');
} else if (isStale()) {
  graphify(bin, ['update', '.'], 'knowledge graph was stale — rebuilt from HEAD');
} else {
  step('· graph already current with HEAD');
}

say('\nDone. Claude Code and Antigravity will consult the graph before reading files.');
