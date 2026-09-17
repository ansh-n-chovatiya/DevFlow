/**
 * `SENSITIVE_HEADERS` widened past 4 literal names, report.md §2 finding 2 /
 * §3.2: `X-Auth-Token`, `Proxy-Authorization` and the rest of the
 * `*-token`/`*-auth*`/`*-key*` family used to pass through raw.
 *
 * `src/injected/agent.ts` is a MAIN-world page agent — `install()` runs
 * unconditionally at import (it patches `window.fetch`/`XMLHttpRequest` and
 * registers listeners the moment the module loads), the same shape
 * `tests/agent-network.test.ts` already imports it for. But driving that
 * through a real `fetch` proves nothing about *case*-insensitivity here: the
 * platform's `Headers` class lower-cases every name before this file ever
 * sees it, so a request built that way can never exercise the regex against
 * the mixed-case header names a real page sends via
 * `XMLHttpRequest.setRequestHeader`, which is handed the name exactly as
 * given. So this reads the regex literal out of the source instead — the
 * same "can't import it, read it instead" move
 * `tests/dom-changes.test.ts`/`tests/render-sampling.test.ts` make for
 * `src/content/index.ts` and `src/background/index.ts` — and runs it as a
 * real `RegExp`, against the exact mixed-case names a page would send, rather
 * than checking for a substring in the file.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const source = readFileSync(path.join(process.cwd(), 'src/injected/agent.ts'), 'utf8');

/**
 * The exact `SENSITIVE_HEADERS` declaration, parsed into a real `RegExp`.
 *
 * Anchored on the declaration itself rather than searched for loosely, so a
 * rename or a second regex literal elsewhere in the file can't make this
 * match the wrong thing silently.
 */
const declaration = source.match(/\nconst SENSITIVE_HEADERS = \/(.+)\/([a-z]*);\n/);
if (!declaration) throw new Error('SENSITIVE_HEADERS declaration not found in agent.ts');
const SENSITIVE_HEADERS = new RegExp(declaration[1], declaration[2]);

describe('the widened header-name pattern', () => {
  it('still redacts everything the 4-name version did', () => {
    for (const name of ['authorization', 'cookie', 'set-cookie', 'x-api-key']) {
      expect(SENSITIVE_HEADERS.test(name), name).toBe(true);
    }
  });

  it('redacts the *-token/*-auth*/*-key* family the audit found missing, case as a page would send it', () => {
    for (const name of [
      'X-Auth-Token',
      'X-Session-Token',
      'Proxy-Authorization',
      'X-Access-Token',
      'X-Amz-Security-Token',
      'X-Csrf-Token',
    ]) {
      expect(SENSITIVE_HEADERS.test(name), name).toBe(true);
    }
  });

  it('leaves an ordinary header name alone', () => {
    for (const name of ['Content-Type', 'Accept', 'X-Request-Id']) {
      expect(SENSITIVE_HEADERS.test(name), name).toBe(false);
    }
  });

  it('is still a single `RegExp`, not a function, so both call sites keep working unchanged', () => {
    expect(SENSITIVE_HEADERS).toBeInstanceOf(RegExp);
    // Case-insensitive is load-bearing for the two call sites that never go
    // through `Headers` — `xhr.setRequestHeader` and the parsed
    // `getAllResponseHeaders()` line, both at ~src/injected/agent.ts:800-825 —
    // which see a page's header name exactly as sent, not lower-cased first.
    expect(declaration[2]).toContain('i');
  });
});
