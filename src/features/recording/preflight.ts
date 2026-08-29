/**
 * Can this tab be recorded, and is it ready?
 *
 * Answering before the user presses Start is the whole point: the popup used to
 * flip to "Recording in progress" regardless of whether anything was listening,
 * so a recording on a chrome:// page, the Web Store, or any tab opened before
 * the extension was installed produced nothing at all, with no error.
 *
 * Two entry points, because opening the popup and pressing Start are different
 * acts. `probe` only looks; `prepare` injects.
 */

import { ensureContentScript, isContentScriptReady } from '../../chrome/scripting.js';
import { getActiveTab, isRecordableUrl } from '../../chrome/tabs.js';
import { flowError, type FlowError } from '../../shared/errors.js';
import { err, ok, type Result } from '../../shared/result.js';

export interface RecordingTarget {
  tabId: number;
  windowId: number;
  url: string;
  /** Hostname, for display. Empty when the URL will not parse. */
  host: string;
  title: string;
  /** Chrome's favicon for the tab, if it has one. Display only. */
  favIconUrl?: string;
}

/**
 * What the popup found when it looked at the active tab.
 *
 * `needs-attach` is separated from `blocked` because the two read identically to
 * the user but resolve differently: the page is perfectly recordable, it just
 * predates the extension, and pressing Start will fix it. Collapsing them into
 * one error is how the old build ended up telling people to reload pages that
 * were never going to work.
 */
export type Preflight =
  | { status: 'ready'; target: RecordingTarget }
  | { status: 'needs-attach'; target: RecordingTarget }
  | { status: 'blocked'; error: FlowError; title: string; url: string };

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/** Look at the active tab without touching it. Safe to call on popup open. */
export async function probe(): Promise<Preflight> {
  const tab = await getActiveTab();
  if (!tab.ok) return { status: 'blocked', error: tab.error, title: '', url: '' };

  const { id, windowId, url, title, favIconUrl } = tab.value;

  if (id == null) {
    return { status: 'blocked', error: flowError('NO_ACTIVE_TAB'), title: title ?? '', url: '' };
  }

  if (!isRecordableUrl(url)) {
    return {
      status: 'blocked',
      error: flowError('TAB_NOT_RECORDABLE', url),
      title: title ?? '',
      url: url ?? '',
    };
  }

  const target: RecordingTarget = {
    tabId: id,
    windowId,
    url: url!,
    host: hostOf(url!),
    title: title ?? '',
    favIconUrl,
  };

  return (await isContentScriptReady(id))
    ? { status: 'ready', target }
    : { status: 'needs-attach', target };
}

/**
 * Resolve the tab a recording would target, injecting the content script if it
 * is missing. Call this when the user has actually asked to record.
 */
export async function prepare(): Promise<Result<RecordingTarget>> {
  const found = await probe();
  if (found.status === 'blocked') return err(found.error);

  const attached = await ensureContentScript(found.target.tabId, found.target.url);
  return attached.ok ? ok(found.target) : err(attached.error);
}
