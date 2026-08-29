/**
 * The only place `chrome.devtools` is called.
 *
 * Ported from react-source-locator `src/core/inspected-window.ts` @ 6eb7a30.
 * It sat in that repo's `core/` because that repo had no `chrome/` layer and
 * every one of its surfaces was the DevTools panel. Here it cannot: `src/core/`
 * is bundled into `mcp-server/core.js` for a Node process with no `chrome`
 * object at all, so a `chrome.*` in there fails `npm run build:mcp` — the purity
 * rule is CI-enforced, not a convention. `src/chrome/` is where a wrapper like
 * this already belongs, next to `tabs.ts`, `storage.ts` and `scripting.ts`.
 *
 * Two things about this API are worth knowing before calling it:
 *
 *   - **`getResources()` is the DevTools cache, not the network.** It lists what
 *     the inspected page loaded, including scripts fetched before the extension
 *     was watching, and `getContent()` hands back their text without a second
 *     request. That is the whole strength of the panel's bundle provider, and
 *     the reason `DevtoolsProvider` exists alongside `WorkerProvider` rather
 *     than being replaced by it.
 *   - **It is callable only from a DevTools page.** `chrome.devtools` is
 *     undefined in the service worker, the popup and the content script, so
 *     anything importing this module must already know it is running in the
 *     panel. `isDevtoolsPage()` is here for the one caller that cannot know.
 *
 * Unlike the rest of `src/chrome/`, these do not return `Result`. Every one of
 * them has exactly one failure — the page navigated away, or the cache does not
 * hold the resource — and the caller's only response is to fall back to a fetch
 * or give up, so `null` says everything a `FlowError` would.
 */

/** A failure reported by `inspectedWindow.eval` — a page-side exception. */
export class InspectedWindowError extends Error {}

/**
 * Whether `chrome.devtools` is reachable from here at all.
 *
 * Not a paranoia check: the panel and the popup share result-rendering code, and
 * a shared module that reaches for the DevTools cache must be able to ask
 * whether it is in the panel before it does.
 */
export function isDevtoolsPage(): boolean {
  return typeof chrome !== 'undefined' && chrome.devtools?.inspectedWindow !== undefined;
}

/**
 * The shape `inspectedWindow.eval` reports a page-side failure with.
 *
 * Declared here rather than taken from `@types/chrome` because the two error
 * channels — `isError` for "DevTools could not run this" and `isException` for
 * "the page threw" — are typed as separate optional flags and both have to be
 * checked; a caller that reads only one gets `undefined` back and treats a
 * thrown exception as a successful `undefined` result.
 */
interface EvalExceptionInfo {
  isError?: boolean;
  isException?: boolean;
  code?: string;
  description?: string;
  value?: string;
  details?: unknown[];
}

function describe(info: EvalExceptionInfo): string {
  return info.value || info.description || info.code || 'Evaluation failed in the inspected page.';
}

/** Evaluates an expression in the inspected page and returns its JSON-cloned value. */
export function evalInPage<T>(expression: string): Promise<T> {
  return new Promise((resolve, reject) => {
    chrome.devtools.inspectedWindow.eval(expression, (result: T, info?: EvalExceptionInfo) => {
      if (info && (info.isError || info.isException)) reject(new InspectedWindowError(describe(info)));
      else resolve(result);
    });
  });
}

/**
 * Evaluates for side effects only, swallowing failures.
 *
 * Every caller of this is telling the page's agent to do something — arm the
 * picker, tear itself down. A page that has navigated away has already torn the
 * agent down for us, so the failure is the outcome we wanted.
 */
export async function evalVoid(expression: string): Promise<void> {
  try {
    await evalInPage<unknown>(expression);
  } catch {
    /* the page is gone or reloading — nothing to clean up */
  }
}

/** Everything the inspected page has loaded, as DevTools recorded it. */
export function getPageResources(): Promise<chrome.devtools.inspectedWindow.Resource[]> {
  return new Promise((resolve) => {
    chrome.devtools.inspectedWindow.getResources((resources) => {
      resolve(resources ?? []);
    });
  });
}

/**
 * Reads a resource's text out of the DevTools cache. Null on a miss.
 *
 * Empty text is a miss too, not an empty file: `getContent` reports a resource
 * it has no body for by handing back `''` rather than by failing, and treating
 * that as a zero-length bundle means the search reports "not found" for a script
 * it never actually read.
 */
export function getResourceContent(
  resource: chrome.devtools.inspectedWindow.Resource,
): Promise<string | null> {
  return new Promise((resolve) => {
    resource.getContent((content, encoding) => {
      if (typeof content !== 'string' || content.length === 0) {
        resolve(null);
        return;
      }
      resolve(encoding === 'base64' ? decodeBase64Utf8(content) : content);
    });
  });
}

/**
 * Decodes base64 as UTF-8.
 *
 * `atob` alone returns one character per *byte*, so any multi-byte character in
 * the bundle becomes mojibake and shifts every subsequent string index — which
 * silently breaks needle matching and every source-map column after it. The
 * symptom is a component that resolves to a plausible file at a nonsense
 * position, which is exactly the confident wrong answer this feature exists to
 * remove, so the decode is done properly rather than cheaply.
 */
export function decodeBase64Utf8(base64: string): string {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}
