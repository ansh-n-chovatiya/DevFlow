/**
 * Every way FlowSnap can fail, and what to tell the user about it.
 *
 * The message is written for the person looking at the popup, not for a log:
 * it says what happened and what to do next. `detail` carries the raw Chrome
 * error for the console, which is the only place it belongs.
 */

export type FlowErrorCode =
  | 'STORAGE_QUOTA'
  | 'STORAGE_WRITE'
  | 'STORAGE_READ'
  | 'NO_ACTIVE_TAB'
  | 'TAB_NOT_RECORDABLE'
  | 'TAB_NOT_READY'
  | 'TAB_GONE'
  | 'CAPTURE_FAILED'
  | 'CAPTURE_RATE_LIMITED'
  | 'INJECTION_FAILED'
  | 'IMAGE_UNUSABLE'
  | 'MCP_UNREACHABLE'
  | 'RESOURCE_UNFETCHABLE'
  | 'RESOURCE_TOO_LARGE';

export interface FlowError {
  code: FlowErrorCode;
  /** One sentence for the user: what happened, and what they can do. */
  message: string;
  /** The underlying Chrome or network error, for the console only. */
  detail?: string;
}

const MESSAGES: Record<FlowErrorCode, string> = {
  // With `unlimitedStorage` this can only be the disk, so it says the disk —
  // sending the user to delete flows would free almost nothing.
  STORAGE_QUOTA:
    "There's no room left on the disk, so the last step wasn't saved. Free some space and recording will continue.",
  STORAGE_WRITE: "Chrome wouldn't save that change. Your last step may be missing.",
  STORAGE_READ: "Chrome wouldn't read the saved flow. Try reopening this tab.",
  NO_ACTIVE_TAB: 'No active tab to record. Open a page and try again.',
  TAB_NOT_RECORDABLE:
    'Chrome blocks extensions on internal pages like chrome:// and the Web Store. Open a normal web page and try again.',
  TAB_NOT_READY:
    'This tab was open before FlowSnap was installed. Reload it and FlowSnap can record it.',
  TAB_GONE: 'That tab was closed before the step could be saved.',
  CAPTURE_FAILED: "Chrome wouldn't screenshot that page. The step was saved without an image.",
  CAPTURE_RATE_LIMITED:
    'Chrome limits how often extensions can screenshot. Some steps may have no image.',
  INJECTION_FAILED: "FlowSnap couldn't start on this tab. Reload the page and try again.",
  // The fallback only. Every real instance overrides it, because what to do
  // about a 40 MB file and what to do about a PDF are different sentences.
  IMAGE_UNUSABLE: "That file can't be used as a screenshot.",
  // Names the likeliest cause rather than the symptom: the server runs inside a
  // Claude Code session, so "unreachable" almost always means none is open. The
  // last clause matters — the flow is in the library, so this is a retry, not a
  // loss, and the old copy left people thinking they had just lost a recording.
  MCP_UNREACHABLE:
    'The FlowSnap MCP server is not running, so nothing was sent. Open Claude Code and try again — this flow is saved.',
  // The last two never reach the popup: a bundle that will not load costs one
  // component its source file and nothing else, and the flow says so in the
  // component's own `detail`. They are `FlowError`s so that the fetch wrapper
  // reports failure the same way every other call in `src/chrome/` does.
  RESOURCE_UNFETCHABLE:
    "One of the page's script bundles could not be read, so a component's source file is missing.",
  RESOURCE_TOO_LARGE:
    "One of the page's script bundles is too large to search, so a component's source file is missing.",
};

/** Coerce whatever Chrome or a `catch` handed us into one readable line. */
function describeDetail(detail: unknown): string | undefined {
  if (detail == null) return undefined;
  if (typeof detail === 'string') return detail;
  if (detail instanceof Error) return detail.message;
  try {
    return JSON.stringify(detail);
  } catch {
    return 'unserialisable error detail';
  }
}

/**
 * `message` overrides the canned sentence for this one instance.
 *
 * Used where the reason varies with what the user did rather than with what
 * Chrome refused — an unusable image is a different sentence for a PDF, an
 * empty file and a 40 MB one, and collapsing the three into one line throws
 * away the half that says what to do instead.
 */
export function flowError(code: FlowErrorCode, detail?: unknown, message?: string): FlowError {
  return { code, message: message ?? MESSAGES[code], detail: describeDetail(detail) };
}

/**
 * Chrome reports a full storage area as a `lastError` whose message mentions the
 * quota. There is no error code to switch on, so the string is the only signal.
 */
export function isQuotaMessage(message: string | undefined): boolean {
  return /quota|QUOTA_BYTES/i.test(message ?? '');
}
