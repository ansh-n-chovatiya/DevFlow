/**
 * A change to what ships has to be written down before it can be released.
 *
 * The release is cut from `## Unreleased`: `scripts/cut-release.mjs` renames
 * that heading to the version being tagged, and whatever is under it becomes
 * what users are told changed. So a commit that edits `src/` or `public/` and
 * leaves the section empty does not merely go undocumented — it is silently
 * folded into the next release under somebody else's heading, describing work
 * nobody did.
 *
 * That failure has no other gate. Typecheck, lint, the tests and the build all
 * pass on a perfectly good change with no entry, and the omission only surfaces
 * when a user reads a changelog that does not mention the thing they noticed.
 *
 * Deliberately **not** part of `npm run verify`. Verify is a statement about a
 * working tree — it is what `npm run package` runs, and what the release job
 * runs against a tag — and "has anything changed" is not a question a single
 * tree can answer. This needs two commits to compare, so it is its own CI step
 * and its own local command.
 *
 * Scope is `src/` and `public/` only. Docs, tests, scripts and workflows change
 * nothing a user can see, and a gate that fires on a typo fix is a gate people
 * learn to route around.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Paths whose change a user could notice. */
const SHIPPED = ['src/', 'public/'];

/** A first-push SHA, or any ref git will not resolve. */
const ZEROS = '0000000000000000000000000000000000000000';

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

/**
 * Whether git can resolve a ref, without the throw that asking costs.
 *
 * A shallow clone, a force-push and a brand-new branch all produce a `before`
 * SHA that is not in this checkout. None of them is a reason to fail a build.
 */
function resolvable(ref) {
  if (!ref || ref === ZEROS) return false;

  try {
    git('rev-parse', '--verify', `${ref}^{commit}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The files this run is about.
 *
 * Three callers, three ranges. A pull request is measured against its base, so
 * the gate reads the whole branch rather than its last commit — an entry added
 * in the first commit still counts. A push is measured against what the branch
 * pointed at before it. A developer running this by hand gets the comparison
 * they meant: everything not yet on `main`, plus whatever is still uncommitted.
 */
function changedFiles() {
  const base = process.env.GITHUB_BASE_REF;
  if (base) {
    const ref = resolvable(`origin/${base}`) ? `origin/${base}` : base;
    if (resolvable(ref)) return git('diff', '--name-only', `${ref}...HEAD`).split('\n');
  }

  const before = process.env.BEFORE_SHA;
  if (resolvable(before)) return git('diff', '--name-only', before, 'HEAD').split('\n');

  // Local. `...` is against the merge base, so a stale local main does not make
  // every file on the branch look changed.
  const local = [];
  if (resolvable('origin/main')) local.push(...git('diff', '--name-only', 'origin/main...HEAD').split('\n'));
  local.push(...git('diff', '--name-only', 'HEAD').split('\n'));
  return local;
}

const changed = changedFiles().filter(Boolean);
const shipped = changed.filter((file) => SHIPPED.some((prefix) => file.startsWith(prefix)));

if (shipped.length === 0) {
  console.log('changelog: nothing under src/ or public/ changed');
  process.exit(0);
}

const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
const headings = [...changelog.matchAll(/^## (.+)$/gm)].map((match) => match[1].trim());

const unreleasedMatch = changelog.match(/^##\s+Unreleased\s*\n([\s\S]*?)(?=\n##\s+|$)/m);
const hasUnreleasedContent = unreleasedMatch && unreleasedMatch[1].trim().length > 0;

if (hasUnreleasedContent) {
  console.log(`changelog: ## Unreleased covers ${shipped.length} changed file(s)`);
  process.exit(0);
}

/*
 * The release commit itself.
 *
 * Cutting a release renames `## Unreleased` to the version and bumps
 * `public/manifest.json` — which lands in `SHIPPED`, so without this the gate
 * would fail the one commit whose whole job is to write the changelog. The top
 * heading naming the version in `package.json` is what says that is what
 * happened.
 */
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version;
if (headings[0]?.startsWith(version)) {
  console.log(`changelog: ${version} was just cut, so there is nothing pending`);
  process.exit(0);
}

console.error('CHANGELOG.md has no `## Unreleased` section (or it is empty), but this changed:\n');
for (const file of shipped.slice(0, 10)) console.error(`  ✘ ${file}`);
if (shipped.length > 10) console.error(`  … and ${shipped.length - 10} more`);
console.error(`
Add a \`## Unreleased\` section at the top of CHANGELOG.md saying what changed for
someone using DevFlow. It becomes the release notes when the version is cut, so
an empty one folds this work into whatever ships next under the wrong heading.`);
process.exit(1);
