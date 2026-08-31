/**
 * The only place `chrome.action` is called.
 *
 * The toolbar button is the one surface that is visible whatever the user is
 * looking at, which is why the badge is worth three states rather than one, and
 * why those calls are worth wrapping: the extension's promise that it is or is
 * not recording is made here, and a promise made from four scattered call sites
 * is one somebody eventually forgets to keep. `background/index.ts` reached for
 * `chrome.action.*` directly because there was nothing else to reach for.
 *
 * Like `devtools.ts` and unlike `storage.ts`, these do not return `Result`.
 * There is exactly one way each of them fails — the extension is being torn
 * down, or Chrome has not finished registering the action — and the caller's
 * only sane response is to carry on, because a badge that did not paint is not
 * a reason to abandon a recording. They swallow rather than throw, and the
 * `void` at each call site says the caller is not waiting.
 *
 * `openPopup` is the exception worth reading. It landed in Chrome 127 and the
 * manifest's floor is 116, so it is feature-detected rather than assumed, and
 * it reports whether it opened — that answer is load-bearing. The keyboard
 * shortcut uses it to ask before replacing an unsaved recording, and a caller
 * that believed a popup had opened when it had not would delete the flow it was
 * trying to protect.
 */

/** What the toolbar is currently saying. */
export interface ActionPaint {
  /** Empty string clears the badge, which is the only way to show "no flow". */
  text: string;
  /** Any CSS colour string Chrome accepts; see `BADGE_COLOR` in `shared/`. */
  color: string;
  title: string;
}

/**
 * Paint the badge and the tooltip together.
 *
 * One call rather than three, because the three are one statement about one
 * button and a half-applied paint is a lie: a red badge reading `23` under a
 * tooltip saying the recording has stopped is worse than either alone.
 */
export function paintAction({ text, color, title }: ActionPaint): void {
  try {
    void chrome.action.setBadgeText({ text });
    void chrome.action.setBadgeBackgroundColor({ color });
    void chrome.action.setTitle({ title });
  } catch {
    // The action is gone, which means so is the window this was describing.
  }
}

/**
 * Open the extension popup, reporting whether it actually opened.
 *
 * False means the caller must not proceed as though the user has been asked —
 * either this Chrome predates the API, or it refused because the call did not
 * come from a gesture it trusts.
 */
export async function openPopup(): Promise<boolean> {
  if (typeof chrome.action.openPopup !== 'function') return false;

  try {
    await chrome.action.openPopup();
    return true;
  } catch {
    return false;
  }
}
