/**
 * Guards the graphify wiring against the one failure that is invisible locally:
 * config that works on the machine that created it and does not exist for
 * anybody else.
 *
 * That is not hypothetical. CLAUDE.md, .claude/settings.json and .agent/ ran
 * untracked for the whole time they were being developed — every session on
 * this machine consulted the graph, while a fresh clone got no CLAUDE.md at
 * all. Nothing caught it, because everything passes when the files are sitting
 * in your working tree. The only reliable check is `git ls-files`, so that is
 * what this does.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Files an assistant needs on disk in a fresh clone, before anything is run. */
const REQUIRED = [
  'CLAUDE.md',
  '.claude/settings.json',
  '.agent/rules/graphify.md',
  '.agent/workflows/graphify.md',
  '.graphifyignore',
  'scripts/graphify-hint.sh',
  'scripts/graphify-setup.mjs',
  '.github/workflows/graphify.yml',
];

/** Generated or per-developer — tracking these is its own kind of breakage. */
const FORBIDDEN = ['graphify-out', '.claude/settings.local.json'];

const errors = [];

/** True when git tracks the path. Directories count if anything under them is tracked. */
function tracked(path) {
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', path], {
      cwd: root,
      stdio: 'pipe',
    });
    return true;
  } catch {
    return false;
  }
}

// Is this even a checkout? `npm run verify` runs from tarballs and CI images
// where it may not be, and a guard that fails there helps nobody.
let isRepo = true;
try {
  execFileSync('git', ['rev-parse', '--git-dir'], { cwd: root, stdio: 'pipe' });
} catch {
  isRepo = false;
}

for (const file of REQUIRED) {
  if (!existsSync(resolve(root, file))) {
    errors.push(`${file} is missing — run \`npm run graphify:setup\``);
  } else if (isRepo && !tracked(file)) {
    errors.push(
      `${file} exists but is not tracked in git — a fresh clone would not get it. Run \`git add ${file}\``,
    );
  }
}

if (isRepo) {
  for (const path of FORBIDDEN) {
    if (tracked(path)) {
      errors.push(
        `${path} is tracked in git — it is generated or per-developer. Remove it with \`git rm -r --cached ${path}\``,
      );
    }
  }
}

// The directive is the entire point of committing CLAUDE.md. Losing it during
// an unrelated edit would leave the file present and the graph unmentioned,
// which is exactly the state this whole setup exists to prevent.
const claudeMd = resolve(root, 'CLAUDE.md');
if (existsSync(claudeMd)) {
  const text = readFileSync(claudeMd, 'utf8');
  if (!text.includes('graphify-out/GRAPH_REPORT.md')) {
    errors.push('CLAUDE.md no longer points at graphify-out/GRAPH_REPORT.md');
  }
}

// A hook that names a script that does not exist fails open: no error, no
// nudge, and nobody notices until someone asks why the graph is never read.
const settings = resolve(root, '.claude/settings.json');
if (existsSync(settings)) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(settings, 'utf8'));
  } catch (err) {
    errors.push(`.claude/settings.json is not valid JSON — ${err.message}`);
  }

  const commands = (parsed?.hooks?.PreToolUse ?? [])
    .flatMap((entry) => entry.hooks ?? [])
    .map((hook) => hook.command ?? '');

  if (!commands.some((cmd) => cmd.includes('graphify-hint.sh'))) {
    errors.push(
      '.claude/settings.json has no PreToolUse hook calling scripts/graphify-hint.sh',
    );
  }
}

if (errors.length) {
  console.error('graphify configuration problems:\n');
  for (const error of errors) console.error(`  ✘ ${error}`);
  console.error('\nThese break graph-aware sessions for everyone but you.');
  process.exit(1);
}

console.log('graphify: config is committed and wired up');
