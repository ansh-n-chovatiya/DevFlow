/**
 * `devflow-mcp regression` — the command a workflow runs.
 *
 * Argument parsing, the graph read, and printing. The check itself is
 * `regression.js`; this is the shell around it, kept separate for the reason
 * `install.js` is: a file that starts a browser should not be imported by a
 * process that only wanted to print usage.
 *
 * **Posting to a pull request is not done here and cannot be.** The report goes
 * to stdout and to `--out`, and a workflow decides whether to publish it. That
 * is ADR 0010's shape applied to a second thing: what DevFlow *writes down* and
 * what it *sends* are two switches, and the one that sends belongs to whoever
 * owns the repository's credentials — not to a tool that could be made to
 * comment on a stranger's PR by a workflow file it does not control.
 */

import fs from 'node:fs';
import path from 'node:path';

const USAGE = `devflow-mcp regression — replay committed flows against this checkout

  --flows <dir>    where committed flows live (default .devflow/flows)
  --mode <m>       mocked (default) or live
  --base <ref>     compare changed files against this ref, e.g. origin/main
  --out <file>     also write the report here, for a workflow to publish
  --strict         exit non-zero when the check could not decide
  --timeout <ms>   per-flow runner timeout (default 120000)

Runs the user's own test runner against their application, so it is behind the
same switch replay_flow is: set DEVFLOW_REPLAY=1. Nothing is posted anywhere —
the report is printed, and publishing it is the workflow's decision.
`;

function parse(argv) {
  const options = { mode: 'mocked', strict: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[(i += 1)];
    switch (arg) {
      case '--flows': options.flowsDir = next(); break;
      case '--mode': options.mode = next(); break;
      case '--base': options.base = next(); break;
      case '--out': options.out = next(); break;
      /*
       * Only a number this can act on. `Number(next())` is `NaN` for a missing
       * or unparseable value, and `NaN` is not `undefined` — so it survived the
       * default in `regressionCheck` and reached `setTimeout`, which treats it
       * as zero. Every replay was then killed before it started, every verdict
       * was "the runner produced nothing readable", and without `--strict` the
       * job exited 0: a regression gate reporting green because its own
       * argument was mistyped.
       */
      case '--timeout': {
        const asked = Number(next());
        if (Number.isFinite(asked) && asked > 0) options.timeoutMs = asked;
        else options.badTimeout = true;
        break;
      }
      case '--strict': options.strict = true; break;
      case '--help': case '-h': options.help = true; break;
      default:
        options.unknown = arg;
    }
  }
  return options;
}

export async function regressionCommand(argv) {
  const options = parse(argv);

  if (options.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (options.unknown) {
    process.stderr.write(`devflow-mcp regression: unknown argument "${options.unknown}"\n\n${USAGE}`);
    return 2;
  }
  if (options.mode !== 'mocked' && options.mode !== 'live') {
    process.stderr.write(`devflow-mcp regression: --mode takes "mocked" or "live"\n`);
    return 2;
  }
  if (options.badTimeout) {
    process.stderr.write(
      'devflow-mcp regression: --timeout takes a positive number of milliseconds. Refusing rather ' +
        'than falling back to the default: a run under a timeout nobody meant is a verdict nobody ' +
        'should read.\n',
    );
    return 2;
  }
  if (process.env.DEVFLOW_REPLAY !== '1') {
    process.stderr.write(
      'devflow-mcp regression: refusing to run. This executes your test runner against your\n' +
        'application, so it is behind the same switch replay_flow is. Set DEVFLOW_REPLAY=1 in the\n' +
        'workflow that means to run it.\n',
    );
    return 2;
  }

  const root = process.cwd();

  /*
   * The graph, if this machine has one. CI usually does not — the ARKG lives in
   * `~/.devflow` on a developer's laptop — and the shortlist is then simply
   * absent rather than empty, because "no changed file has been observed" and
   * "there is no graph here" are different sentences and only one of them is
   * about the pull request.
   */
  let observedFiles = [];
  try {
    const { openArkg, getObservedFiles, closeArkg } = await import('./arkg.js');
    const db = path.join(process.env.DEVFLOW_DIR ?? path.join(process.env.HOME ?? '.', '.devflow'), 'arkg.db');
    if (fs.existsSync(db)) {
      openArkg(db);
      observedFiles = Object.keys(getObservedFiles() ?? {});
      closeArkg();
    }
  } catch {
    // A graph that will not open costs the shortlist and nothing else.
  }

  const { regressionCheck } = await import('./regression.js');
  const { report, code } = await regressionCheck({ ...options, root, observedFiles });

  process.stdout.write(`${report}\n`);
  if (options.out) {
    try {
      fs.writeFileSync(options.out, `${report}\n`);
    } catch (error) {
      process.stderr.write(`devflow-mcp regression: could not write ${options.out} (${error.message})\n`);
    }
  }
  return code;
}
