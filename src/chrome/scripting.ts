/**
 * Getting the content script into a tab that does not have it.
 *
 * Manifest-declared content scripts only run on pages loaded *after* the
 * extension was installed or reloaded. Every tab that was already open is
 * therefore deaf, which is why pressing Start used to report success and record
 * nothing. Injecting on demand fixes the common case without asking the user to
 * reload anything.
 */

import { flowError } from '../shared/errors.js';
import { err, ok, type Result } from '../shared/result.js';
import { isRecordableUrl, sendToTab } from './tabs.js';

/** Built filenames, as they appear in dist/ and in the manifest. */
const CONTENT_SCRIPT = 'content.js';
const CONTENT_STYLES = 'content.css';
const AGENT_SCRIPT = 'injected/agent.js';

/** Whether a content script is already listening in this tab. */
export async function isContentScriptReady(tabId: number): Promise<boolean> {
  const result = await sendToTab<{ ok: boolean }>(tabId, { type: 'PING' });
  return result.ok;
}

/**
 * Ensure the tab can record, injecting the scripts if they are missing.
 *
 * The MAIN-world agent is injected first and separately: it patches `fetch`,
 * `XMLHttpRequest` and `console`, so anything the page does before it lands is
 * simply not observed. On an already-loaded page that is unavoidable — the
 * requests it made during load are gone — but everything after this point is
 * captured.
 */
export async function ensureContentScript(
  tabId: number,
  url: string | undefined,
): Promise<Result<void>> {
  if (!isRecordableUrl(url)) return err(flowError('TAB_NOT_RECORDABLE'));

  if (await isContentScriptReady(tabId)) return ok();

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: [AGENT_SCRIPT],
      world: 'MAIN',
    });
    await chrome.scripting.insertCSS({ target: { tabId }, files: [CONTENT_STYLES] });
    await chrome.scripting.executeScript({ target: { tabId }, files: [CONTENT_SCRIPT] });
  } catch (error) {
    return err(flowError('INJECTION_FAILED', error instanceof Error ? error.message : error));
  }

  // Injection resolving is not the same as the listener being registered.
  return (await isContentScriptReady(tabId)) ? ok() : err(flowError('TAB_NOT_READY'));
}
