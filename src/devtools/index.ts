/**
 * DevTools host page: registers the panel, and holds one port open to the
 * worker for exactly as long as DevTools is open.
 *
 * The port is the close signal, and there is no other. A pick is armed in the
 * page, where nothing can observe DevTools closing — so a panel closed mid-pick
 * would otherwise leave the agent's capture-phase listeners and its crosshair
 * cursor on the page. This document unloads when DevTools closes, the port
 * disconnects, and the worker disarms the pick. (`PICK_TIMEOUT_MS` is the
 * backstop, not the mechanism: two minutes of a page that will not let you click
 * anything is a bug report, not a cleanup story.)
 *
 * A port rather than a heartbeat from the panel, because the panel's timers are
 * throttled while the DevTools window is backgrounded — undocked and behind the
 * page it inspects — and a missed beat would disarm a pick the user is in the
 * middle of making.
 *
 * Ported from react-source-locator's `devtools/index.ts`. What changed: the
 * worker no longer tears the agent out of the page on disconnect. DevFlow's
 * agent is a manifest content script serving the recorder as well, and it is
 * still needed by the tab it is in — so the disconnect cancels the *pick*, not
 * the agent.
 */

import { sendToWorker } from '../shared/messages.js';

/**
 * The port's name, with the inspected tab's id appended.
 *
 * A port carries no `sender.tab` from a DevTools page — that is the same fact
 * `DEVTOOLS_OPENED` exists for — so a disconnect arrives with nothing on it to
 * say which tab has just lost its panel. Correlating a disconnect with a
 * separately-sent message would be a race with two DevTools windows open on two
 * tabs; the name is the one piece of a port both ends see.
 *
 * The literal is repeated in `background/index.ts` rather than shared, because
 * `src/shared/` was frozen in Wave 0 and this constant did not exist then.
 * `tests/devtools.test.ts` asserts the two copies still say the same thing —
 * a mismatch is otherwise silent: nothing throws, no panel ever registers, and
 * every close leaks an armed pick.
 */
const DEVTOOLS_PORT = 'devflow-devtools';

const tabId = chrome.devtools.inspectedWindow.tabId;

/*
 * The panel's tab strip entry. Named for the specific functionality it controls
 * in DevTools (React component and source locating), allowing other DevFlow tools
 * (e.g. Flow Recorder) to register their own dedicated DevTools panels cleanly.
 */
chrome.devtools.panels.create('React Locator', 'icons/icon48.png', 'panel.html');

/**
 * Opens the port, and re-opens it if the worker underneath it dies.
 *
 * An MV3 worker is killed whenever Chrome likes, which disconnects the port
 * while DevTools is still very much open. Without the reconnect the restarted
 * worker never learns this panel exists, and the close that follows cleans up
 * nothing. Reconnecting also re-announces the tab, which is why `DEVTOOLS_OPENED`
 * is sent from here on every connect rather than once at load.
 *
 * `chrome.runtime.id` is the guard against the other way a port dies: the
 * extension being reloaded or updated out from under this page. That context is
 * gone for good, and retrying into it is an infinite loop.
 */
function connect(): void {
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connect({ name: `${DEVTOOLS_PORT}:${tabId}` });
  } catch {
    // The extension was reloaded; this page belongs to the previous one.
    return;
  }

  port.onDisconnect.addListener(() => {
    // Read, or Chrome logs "Unchecked runtime.lastError" on every worker death.
    void chrome.runtime.lastError;
    if (chrome.runtime.id === undefined) return;
    connect();
  });

  void sendToWorker({ type: 'DEVTOOLS_OPENED', tabId });
}

connect();
