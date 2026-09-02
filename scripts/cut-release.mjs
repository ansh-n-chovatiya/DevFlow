/**
 * Cuts a new release:
 * 1. Verifies CHANGELOG.md has an `## Unreleased` section with content.
 * 2. Bumps the version in package.json, package-lock.json, and syncs to manifest & mcp-server.
 * 3. Renames `## Unreleased` in CHANGELOG.md to `## <version> — <YYYY-MM-DD>`.
 * 4. Runs `npm run verify` to ensure tests and builds pass.
 * 5. Commits the changes and creates an annotated git tag `v<version>`.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function parseSemver(v) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function bumpVersion(current, bumpType) {
  const parsed = parseSemver(current);
  if (!parsed) {
    throw new Error(`Current version in package.json (${current}) is not a valid semver`);
  }
  const [major, minor, patch] = parsed;

  if (bumpType === 'patch') return `${major}.${minor}.${patch + 1}`;
  if (bumpType === 'minor') return `${major}.${minor + 1}.0`;
  if (bumpType === 'major') return `${major + 1}.0.0`;

  if (parseSemver(bumpType)) {
    return bumpType;
  }

  throw new Error(`Unknown bump type or invalid semver: "${bumpType}". Expected patch, minor, major, or X.Y.Z.`);
}

function getTodayDate() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

const args = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const flags = new Set(process.argv.slice(2).filter((arg) => arg.startsWith('--')));

const bumpArg = args[0] || 'patch';
const isDryRun = flags.has('--dry-run');
const skipVerify = flags.has('--skip-verify');
const noGit = flags.has('--no-git');

// 1. Check working directory status unless dry-run
if (!isDryRun && !flags.has('--allow-dirty')) {
  const status = git('status', '--porcelain');
  if (status.length > 0) {
    console.error('Working directory is not clean. Commit or stash changes first, or pass --allow-dirty.');
    console.error(status);
    process.exit(1);
  }
}

// 2. Read package.json and determine new version
const pkgPath = resolve(root, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const currentVersion = pkg.version;
const newVersion = bumpVersion(currentVersion, bumpArg);

console.log(`Bumping version: ${currentVersion} → ${newVersion}`);

// 3. Validate CHANGELOG.md
const changelogPath = resolve(root, 'CHANGELOG.md');
const changelog = readFileSync(changelogPath, 'utf8');

const unreleasedMatch = changelog.match(/^##\s+Unreleased\s*\n([\s\S]*?)(?=\n##\s+|$)/m);
if (!unreleasedMatch || unreleasedMatch[1].trim().length === 0) {
  console.error(`Cannot cut release ${newVersion}: CHANGELOG.md has no ## Unreleased section or it is empty.`);
  console.error('Please add release notes under ## Unreleased describing what changed.');
  process.exit(1);
}

const dateStr = getTodayDate();
const newChangelog = changelog.replace(/^##\s+Unreleased/m, `## ${newVersion} — ${dateStr}`);

if (isDryRun) {
  console.log(`[dry-run] Would update CHANGELOG.md: ## Unreleased → ## ${newVersion} — ${dateStr}`);
  console.log(`[dry-run] Would update package.json version to ${newVersion}`);
  console.log('[dry-run] Dry run completed.');
  process.exit(0);
}

// 4. Write updated CHANGELOG.md
writeFileSync(changelogPath, newChangelog);
console.log(`Updated CHANGELOG.md with header: ## ${newVersion} — ${dateStr}`);

// 5. Update package.json
pkg.version = newVersion;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// 6. Update package-lock.json if present
const lockPath = resolve(root, 'package-lock.json');
try {
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.version = newVersion;
  if (lock.packages?.['']) {
    lock.packages[''].version = newVersion;
  }
  writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
} catch {
  // Ignore if package-lock is missing
}

// 7. Synchronize version to manifest & mcp-server
execFileSync('node', [resolve(root, 'scripts/sync-version.mjs')], { cwd: root, stdio: 'inherit' });

// 8. Verify build and tests
if (!skipVerify) {
  console.log('Running verification...');
  execFileSync('npm', ['run', 'verify'], { cwd: root, stdio: 'inherit' });
}

// 9. Git commit and tag
if (!noGit) {
  const filesToStage = [
    'CHANGELOG.md',
    'package.json',
    'package-lock.json',
    'public/manifest.json',
    'mcp-server/package.json',
    'mcp-server/package-lock.json',
    'compiler-plugin/package.json',
  ];
  git('add', ...filesToStage);
  git('commit', '-m', `v${newVersion}`);
  git('tag', '-a', `v${newVersion}`, '-m', `v${newVersion}`);

  console.log(`\nSuccessfully cut release v${newVersion} and created tag.`);
  console.log(`To publish, run:\n  git push origin main --tags\n`);
} else {
  console.log(`\nFiles updated for v${newVersion}. Git commit and tag skipped (--no-git).`);
}
