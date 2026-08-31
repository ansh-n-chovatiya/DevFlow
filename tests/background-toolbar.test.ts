/**
 * What the toolbar says, and the key that drives it.
 *
 * A service worker registers its listeners at import, so the module cannot be
 * loaded into a test — the source is the seam that is left, exactly as in
 * `tests/mcp-auto-send.test.ts` and `tests/settings-module-scope.test.ts`.
 *
 * Both failures these cover were silent. The badge was set from four call sites
 * and cleared from one, so stopping a recording left the toolbar showing the
 * same red count as a live one for as long as the browser stayed open — nothing
 * threw, and the only way to notice was to go looking. And a command whose name
 * drifts from the manifest's key is a keyboard shortcut that simply stops
 * working: Chrome delivers the name it was declared under, the listener compares
 * it to a different string, and no error is raised anywhere.
 */

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../src/background/index.ts', import.meta.url), 'utf8');

const manifest = JSON.parse(
  readFileSync(new URL('../public/manifest.json', import.meta.url), 'utf8'),
) as { commands?: Record<string, unknown> };

/**
 * One top-level function or listener, ending at the first closing brace in
 * column one — `}` for a declaration, `});` for a listener. Bounded rather than
 * "everything after the signature", so an assertion cannot be satisfied by a
 * line that belongs to the next function down.
 */
function body(signature: string): string {
  const start = source.indexOf(signature);
  expect(start, `${signature} is gone`).toBeGreaterThan(-1);

  const rest = source.slice(start);
  const end = rest.search(/\n\}\)?;?\n/);
  return rest.slice(0, end === -1 ? undefined : end);
}

describe('the toolbar', () => {
  it('is written from one place, so no caller can set it and forget the rest', () => {
    /*
     * Text, colour and tooltip are three facts about one state. Set from
     * separate call sites they drift, which is how a stopped recording kept a
     * live recording's colour while carrying a count nothing would clear.
     *
     * The wrapper is the one place, and the worker reaches it the way CLAUDE.md
     * says every `chrome.*` call is reached — through `src/chrome/`. Asserted
     * on both halves: the worker makes no raw call, and the wrapper makes each
     * exactly once. Either alone can be satisfied while the promise is broken.
     */
    expect(source).not.toMatch(/chrome\.action\./);

    const wrapper = readFileSync(
      new URL('../src/chrome/action.ts', import.meta.url),
      'utf8',
    );
    expect(wrapper.match(/chrome\.action\.setBadgeText/g)).toHaveLength(1);
    expect(wrapper.match(/chrome\.action\.setBadgeBackgroundColor/g)).toHaveLength(1);
    expect(wrapper.match(/chrome\.action\.setTitle/g)).toHaveLength(1);
  });

  it('repaints when a recording ends, which is the moment it used to go stale', () => {
    expect(body('async function finishRecording()')).toContain('refreshAction()');
  });

  it('repaints on the three keys the answer is made of', () => {
    // `recordingPaused` is the popup's write and `recordedSteps` is emptied by
    // the popup and the viewer too, so the worker cannot learn about either from
    // its own call sites.
    const listener = body('chrome.storage.onChanged.addListener(');

    expect(listener).toContain("'recordingActive' in changes");
    expect(listener).toContain("'recordingPaused' in changes");
    expect(listener).toContain("'recordedSteps' in changes");
    expect(listener).toContain('refreshAction()');
  });

  it('repaints on wake, because a badge does not survive a browser restart', () => {
    expect(source).toContain('void refreshAction();');
  });
});

describe('the recording command', () => {
  it('listens for the command the manifest declares, by the same name', () => {
    const names = Object.keys(manifest.commands ?? {});
    expect(names).toHaveLength(1);

    const listener = body('chrome.commands.onCommand.addListener(');
    expect(listener).toContain(`command !== '${names[0]}'`);
  });

  it('will not silently delete a recording nobody has archived', () => {
    // The popup asks before a new recording replaces an unsaved one. A keystroke
    // has nowhere to ask, so it must not be the one path that skips the
    // question — see `toggleRecording`.
    const toggle = body('async function toggleRecording()');

    const guard = toggle.indexOf('recordedSteps');
    const start = toggle.indexOf('startRecording()');

    expect(guard).toBeGreaterThan(-1);
    expect(start).toBeGreaterThan(guard);
  });
});
