/**
 * The only place `chrome.tabs` is called.
 *
 * Two things here are load-bearing beyond wrapping the API: screenshots are
 * taken from an explicit window rather than "whatever has focus", and captures
 * are spaced so they stay inside Chrome's rate limit.
 */

import { flowError } from '../shared/errors.js';
import { CAPTURE_MIN_INTERVAL_MS } from '../shared/constants.js';
import { err, ok, type Result } from '../shared/result.js';

/**
 * URL schemes Chrome refuses to let extensions touch. Starting a recording on
 * one of these used to report success and then capture nothing at all.
 */
const BLOCKED_SCHEMES = [
  'chrome:',
  'chrome-extension:',
  'chrome-search:',
  'chrome-untrusted:',
  'devtools:',
  'edge:',
  'about:',
  'view-source:',
  'data:',
];

/** Hosts that are ordinary https but still off-limits to extension scripts. */
const BLOCKED_HOSTS = ['chromewebstore.google.com', 'chrome.google.com'];

/** Whether FlowSnap is allowed to run on a URL at all. Pure — see tests. */
export function isRecordableUrl(url: string | undefined): boolean {
  if (!url) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (BLOCKED_SCHEMES.includes(parsed.protocol)) return false;

  // chrome.google.com is only blocked for the Web Store path, but the store is
  // the only reason anyone lands there from an extension.
  if (BLOCKED_HOSTS.includes(parsed.hostname)) return false;

  return parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'file:';
}

export async function getActiveTab(): Promise<Result<chrome.tabs.Tab>> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.id == null ? err(flowError('NO_ACTIVE_TAB')) : ok(tab);
}

/**
 * Reload a tab and resolve when the new document has finished loading.
 *
 * `chrome.tabs.reload` resolves when the reload has been *started*, so starting
 * a recording straight after it raced the navigation: the outgoing page was
 * still there to answer the readiness ping, so it was told to record and logged
 * a navigation step for the page being thrown away — and then the incoming one
 * logged the real one. Two navigation steps for a page the user saw once.
 *
 * `complete` is only accepted after a `loading`, so a tab that was already
 * mid-load when the popup opened cannot resolve this with the old document's
 * event.
 */
export function reloadAndWait(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    let started = false;
    let settled = false;

    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };

    const onUpdated = (id: number, info: chrome.tabs.TabChangeInfo): void => {
      if (id !== tabId) return;
      if (info.status === 'loading') started = true;
      else if (info.status === 'complete' && started) finish();
    };

    // Registered before the reload, so the events it produces cannot be missed.
    chrome.tabs.onUpdated.addListener(onUpdated);
    const timer = setTimeout(finish, timeoutMs);

    void chrome.tabs.reload(tabId).catch(finish);
  });
}

// ── Capture ──────────────────────────────────────────────────────────────────

/**
 * Chrome permits roughly two `captureVisibleTab` calls per second and rejects
 * the rest. The original code fired one every 150 ms and swallowed the
 * rejection, so fast clicking silently produced steps with no screenshot. This
 * spaces calls instead of losing them.
 */
let lastCaptureAt = 0;
let captureChain: Promise<unknown> = Promise.resolve();

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureNow(
  windowId: number | undefined,
  quality: number,
  minIntervalMs: number,
): Promise<Result<string>> {
  const wait = minIntervalMs - (Date.now() - lastCaptureAt);
  if (wait > 0) await sleep(wait);

  try {
    const dataUrl =
      windowId == null
        ? await chrome.tabs.captureVisibleTab({ format: 'jpeg', quality })
        : await chrome.tabs.captureVisibleTab(windowId, { format: 'jpeg', quality });
    lastCaptureAt = Date.now();
    return ok(dataUrl);
  } catch (error) {
    lastCaptureAt = Date.now();
    const detail = error instanceof Error ? error.message : String(error);
    const rateLimited = /quota|too many/i.test(detail);
    return err(flowError(rateLimited ? 'CAPTURE_RATE_LIMITED' : 'CAPTURE_FAILED', detail));
  }
}

/**
 * Screenshot a specific window's visible tab.
 *
 * `windowId` comes from the message sender, not from "the current window" — a
 * service worker has no meaningful current window, so the old call captured
 * whichever window last had focus, which is not necessarily the one the step
 * came from.
 *
 * `quality` and `minIntervalMs` are required, and are the frozen
 * `screenshots.quality` and `screenshots.minIntervalMs` of the recording this
 * capture belongs to — passed in rather than read here because this module is
 * called from the worker at capture time and a value read at import would be
 * the compiled-in default forever. See `features/settings/recording.ts`.
 */
export function captureVisibleTab(
  windowId: number | undefined,
  quality: number,
  minIntervalMs = CAPTURE_MIN_INTERVAL_MS,
): Promise<Result<string>> {
  // Serialise: two concurrent captures would both see the same `lastCaptureAt`
  // and neither would wait.
  const next = captureChain.then(() => captureNow(windowId, quality, minIntervalMs));
  captureChain = next.catch(() => undefined);
  return next;
}

// ── Messaging ────────────────────────────────────────────────────────────────

/**
 * Send to a tab, treating "no receiving end" as a normal outcome — it means the
 * content script is not there, which is a state the caller has to handle rather
 * than an exception.
 */
export async function sendToTab<T>(tabId: number, message: unknown): Promise<Result<T>> {
  try {
    const response = (await chrome.tabs.sendMessage(tabId, message)) as T;
    return ok(response);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return err(flowError(/No tab with id/i.test(detail) ? 'TAB_GONE' : 'TAB_NOT_READY', detail));
  }
}
