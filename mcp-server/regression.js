/**
 * The regression check, run from CI rather than from a model.
 *
 * ## Why this is a command and not an MCP tool
 *
 * Every other capability here is something a model asks for while somebody is
 * working. This one runs with nobody watching, on a machine that has just
 * checked out a branch, and its output is read by a person on a pull request.
 * A tool call would be the wrong shape twice over: there is no model in the
 * loop to call it, and its answer has to become an exit code.
 *
 * ## Flows have to be in the repository, and that is a real requirement
 *
 * A recording lives in `~/.devflow/flows` on the machine that made it. CI has
 * no such directory, so a flow it is meant to replay must be committed —
 * `.devflow/flows/<id>/flow.json` by default, and `--flows` for anywhere else.
 * There is no way around this and no attempt is made to hide it: a check that
 * silently found nothing to run and exited 0 would be a green tick meaning
 * "nothing happened", which is the worst possible output for a regression gate.
 * An empty run is `inconclusive`, and `--strict` turns that into a failing exit
 * code.
 *
 * ## The switch is `replay.js`'s, and deliberately the same one
 *
 * This executes the user's test runner against their application, which is
 * exactly what `DEVFLOW_REPLAY` gates for `replay_flow`. Reaching for a second
 * variable would mean somebody who deliberately turned replay off could still
 * be made to run their code by a workflow file. In CI the environment is the
 * workflow's own, so setting it there is the deliberate act.
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  generatePlaywrightTest,
  implicatedFiles,
  planReplay,
  readRun,
  renderRegressionReport,
  runVerdict,
} from './core.js';

const DEFAULT_FLOWS_DIR = '.devflow/flows';
const DEFAULT_TIMEOUT_MS = 120_000;

/** Every committed flow under `dir`, newest first, or an empty list. */
export function readFlows(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }

  const flows = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const file = path.join(dir, entry.name, 'flow.json');
    try {
      const json = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (json && Array.isArray(json.steps)) flows.push(json);
    } catch {
      // A flow that will not parse is skipped rather than fatal — one corrupt
      // directory must not stop the other nine from being checked — but the
      // caller counts what it found, so the shortfall is visible.
    }
  }
  return flows;
}

/** The calls a recording made, flattened to what a wire comparison needs. */
export function recordedCalls(flow) {
  const calls = [];
  for (const step of flow.steps ?? []) {
    for (const call of step.networkCalls ?? []) {
      if (typeof call.url !== 'string' || typeof call.status !== 'number') continue;
      calls.push({
        method: String(call.method ?? 'GET'),
        url: call.url,
        status: call.status,
        durationMs: Number(call.durationMs) || 0,
      });
    }
  }
  return calls;
}

/**
 * Where Playwright put one named attachment, or null.
 *
 * The report nests suites arbitrarily deep, so this recurses the way
 * `core/replay`'s own walk does, with the same depth cap and the same refusal
 * to trust a shape: every array, object and string is checked before it is
 * read. JSON cannot hold a cycle, so depth is the only bound needed.
 */
function attachmentPath(report, name, depth = 0) {
  if (!report || typeof report !== 'object' || depth > 12) return null;

  if (Array.isArray(report.attachments)) {
    for (const attachment of report.attachments) {
      if (attachment?.name === name && typeof attachment.path === 'string') return attachment.path;
    }
  }

  for (const key of ['suites', 'specs', 'tests', 'results']) {
    if (!Array.isArray(report[key])) continue;
    for (const child of report[key]) {
      const found = attachmentPath(child, name, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * The calls the run observed, out of the attachment the unmocked spec makes.
 *
 * Every failure here is the same answer — an empty list — and that is safe
 * precisely because `compareWire` treats an empty list as *not observed*
 * rather than as *nothing happened*. A parse error that silently became "no
 * requests were made" would turn a broken collector into a reported outage.
 */
export function readObservedCalls(reportJson) {
  const file = attachmentPath(reportJson, 'devflow-calls');
  if (!file) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((call) => call && typeof call.url === 'string' && typeof call.status === 'number')
      .map((call) => ({
        method: String(call.method ?? 'GET'),
        url: call.url,
        status: call.status,
        durationMs: Number(call.durationMs) || 0,
      }));
  } catch {
    return [];
  }
}

/** The runner's JSON report, or null. Its verdict comes from `readRun` either way. */
function parseReport(stdout) {
  try {
    return JSON.parse(stdout);
  } catch {
    return null;
  }
}

/** One subprocess, with a timeout and its output captured. */
function run(executable, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, { cwd, shell: false });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    // Decoded by the stream rather than per read: `stdout` is parsed as the
    // runner's JSON report, which carries the flow's own name and every failure
    // message, and appending an undecoded chunk replaces whatever multi-byte
    // character the read boundary fell inside. See `replay.js`'s `runCommand`.
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk) => (stdout += chunk));
    child.stderr?.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ stdout: '', stderr: String(error?.message ?? error), timedOut: false, failed: true });
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve({ stdout, stderr, timedOut, failed: false });
    });
  });
}

/** `git diff --name-only <base>...HEAD`, or an empty list when git cannot say. */
async function changedFiles(root, base) {
  if (!base) return [];
  // The argument is a ref a workflow supplies, so it is checked against a
  // conservative shape before it reaches an argv — the rule `core/git` keeps
  // for a commit-ish, applied to a branch name.
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(base)) return [];
  const result = await run('git', ['diff', '--name-only', `${base}...HEAD`], root, 15_000);
  return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

/**
 * Run every committed flow and report.
 *
 * Returns the report text and an exit code. The code is the product: a
 * workflow reads it, and a check that could not decide must not return 0 under
 * `--strict`.
 */
export async function regressionCheck(options) {
  const {
    root = process.cwd(),
    flowsDir = DEFAULT_FLOWS_DIR,
    mode = 'mocked',
    base = null,
    strict = false,
    observedFiles = [],
    prefix = '',
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const flows = readFlows(path.resolve(root, flowsDir));
  const runs = [];

  for (const flow of flows) {
    const plan = planReplay(String(flow.id ?? 'flow'));
    const specFile = path.resolve(root, plan.specPath);
    fs.mkdirSync(path.dirname(specFile), { recursive: true });
    fs.writeFileSync(
      specFile,
      generatePlaywrightTest(flow.steps ?? [], String(flow.name ?? flow.id ?? 'flow'), {
        mocks: mode !== 'live',
      }),
    );

    const result = await run('npx', ['playwright', ...plan.args], root, timeoutMs);
    const verdict = readRun({
      stdout: result.stdout,
      stderr: result.stderr,
      timedOut: result.timedOut,
    });

    runs.push({
      flowId: String(flow.id ?? ''),
      flowName: String(flow.name ?? flow.id ?? 'flow'),
      verdict,
      /*
       * What the run's own browser saw, written by the spec itself.
       *
       * Only an unmocked spec emits this file, which is the right shape: in
       * mocked mode there is nothing to observe that is not the recording
       * played back, and `compareWire` refuses that comparison anyway. An
       * absent file leaves this empty and the report says the wire was not
       * observed — never that nothing was called.
       */
      calls: readObservedCalls(parseReport(result.stdout)),
      recorded: recordedCalls(flow),
    });
  }

  const changed = await changedFiles(root, base);
  const { implicated, unseen } = implicatedFiles({ changed, prefix, observed: observedFiles });

  const report = renderRegressionReport({
    mode,
    runs,
    changedFiles: changed.length,
    implicated,
    unseen,
    observedRenders: false,
  });

  const verdict = runVerdict(runs);
  const code = verdict === 'regressed' ? 1 : verdict === 'inconclusive' && strict ? 1 : 0;
  return { report, verdict, code };
}
