// @vitest-environment jsdom

/**
 * The two things the send dialog has to say before the POST leaves.
 *
 * Both were audited as missing and both are wiring rather than arithmetic, so
 * they are driven against the real controller and the real viewer.html markup:
 * a view model that returns the right sentence into an element nobody paints is
 * the failure mode a pure test cannot see.
 *
 *   1. Where the flow is going, and whether anything is listening there. The
 *      address appeared nowhere in the send path, and `checkMcp` was wired only
 *      to a button on the Settings screen — so a stale port was discovered by
 *      uploading to it.
 *   2. That step URLs travel whatever the Include switches say.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS } from '../src/features/settings/fields.js';
import { flowError } from '../src/shared/errors.js';
import type { Result } from '../src/shared/result.js';
import type { McpHealth } from '../src/features/mcp/health.js';
import type { Step } from '../src/shared/types.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(resolve(root, 'src/viewer.html'), 'utf8');
const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? '';

const LOCAL = 'http://127.0.0.1:4321/flows';

/** What the next `checkMcp` answers. Set per test. */
let health: Result<McpHealth> = {
  ok: true,
  value: { service: 'devflow-mcp-server', mode: 'local' },
};
// Typed on the generic rather than by naming parameters the stub does not read:
// `vi.fn` records the call either way, and asserting the dialog probed the right
// address with the right timeout is half of what these tests are for.
const checkMcp = vi.fn<(url: string, timeoutMs: number) => Promise<typeof health>>(
  () => Promise.resolve(health),
);

/** What the next `sendFlow` answers. */
let sent: Result<{ id: string; prompt: boolean }> = {
  ok: false,
  error: flowError('MCP_UNREACHABLE', 'Failed to fetch'),
};

vi.mock('../src/features/mcp/health.js', () => ({
  checkMcp: (url: string, timeout: number) => checkMcp(url, timeout),
}));

vi.mock('../src/features/mcp/send.js', () => ({
  sendFlow: () => Promise.resolve(sent),
  // The dialog's context figure renders the real walkthrough; these tests are
  // about the two banners, so it is stubbed to a fixed document.
  walkthroughFor: () => '# Flow\n',
}));

/** `mcpServerUrl` for the settings the dialog opens against. */
let address = LOCAL;

// Partial: `components.ts` reaches into this module for the settings drawer's
// own table, and stubbing the whole thing takes that down with it.
vi.mock(import('../src/features/settings/index.js'), async (importOriginal) => ({
  ...(await importOriginal()),
  load: () => Promise.resolve({ ...DEFAULTS, mcpServerUrl: address }),
}));

vi.mock('../src/chrome/storage.js', () => ({
  getLocal: () => Promise.resolve({ ok: false as const, error: null }),
  setLocal: () => Promise.resolve({ ok: true as const, value: undefined }),
  getSync: () => Promise.resolve({ ok: true as const, value: {} }),
  setSync: () => Promise.resolve({ ok: true as const, value: undefined }),
}));

vi.mock('../src/ui/toast.js', () => ({ showToast: () => undefined }));

const step = (over: Partial<Step> = {}): Step =>
  ({
    type: 'click',
    url: 'https://app.example.com/orders',
    timestamp: 1_000,
    action: 'Clicked "Save"',
    element: {
      tag: 'button',
      cssSelector: '#save',
      xpath: '/html[1]/body[1]/button[1]',
      boundingBox: null,
    },
    ...over,
  }) as Step;

const el = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const hidden = (id: string): boolean => el(id).classList.contains('hidden');

/** Let `openSend`'s storage read and the health probe settle. */
const flush = (): Promise<void> => new Promise((res) => setTimeout(res, 0));

let openSend: (options: { steps: Step[]; name: string }) => void;

beforeEach(async () => {
  document.body.innerHTML = body;
  address = LOCAL;
  health = { ok: true, value: { service: 'devflow-mcp-server', mode: 'local' } };
  sent = { ok: false, error: flowError('MCP_UNREACHABLE', 'Failed to fetch') };
  checkMcp.mockClear();

  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement): void {
    this.open = false;
  };

  vi.resetModules();
  ({ openSend } = await import('../src/ui/viewer/send-dialog.js'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function open(steps: Step[] = [step()]): Promise<void> {
  openSend({ steps, name: 'Flow A' });
  await flush();
}

describe('the destination is visible before the send', () => {
  it('names the address in full, path included', async () => {
    await open();
    expect(el('send-target').textContent).toBe(LOCAL);
    // The line truncates; the title is what the tail is owed.
    expect(el('send-target').title).toBe(LOCAL);
  });

  it('checks it when the dialog opens, not after the upload', async () => {
    await open();
    expect(checkMcp).toHaveBeenCalledTimes(1);
    expect(checkMcp).toHaveBeenCalledWith(LOCAL, DEFAULTS['mcp.healthTimeoutMs']);
  });

  it('reports the server that answered, and raises nothing', async () => {
    await open();
    expect(el('send-target-status').textContent).toBe(
      'Connected · devflow-mcp-server (local)',
    );
    expect(hidden('send-target-problem')).toBe(true);
  });
});

describe('a failed check says which failure it was', () => {
  it('paints the refused-connection case inline', async () => {
    health = { ok: false, error: flowError('MCP_UNREACHABLE', 'Failed to fetch') };
    await open();

    expect(hidden('send-target-problem')).toBe(false);
    expect(el('send-target-problem-title').textContent).toBe(
      'Nothing is listening on that port',
    );
    expect(el('send-target-problem-text').textContent).toContain('127.0.0.1:4321');
  });

  it('does not offer a local remedy for an address on another machine', async () => {
    address = 'http://build-box.example.com:4321/flows';
    health = { ok: false, error: flowError('MCP_UNREACHABLE', 'Failed to fetch') };
    await open();

    expect(el('send-target-problem-title').textContent).toContain('is not this machine');
    expect(el('send-target-problem-text').textContent).not.toContain('install');
  });

  it('never blocks Send on the reading, which can be stale by the click', async () => {
    health = { ok: false, error: flowError('MCP_UNREACHABLE', 'Failed to fetch') };
    await open();

    expect(el<HTMLButtonElement>('send-run').disabled).toBe(false);
  });

  it('checks again on demand, so starting the server clears the banner', async () => {
    health = { ok: false, error: flowError('MCP_UNREACHABLE', 'Failed to fetch') };
    await open();
    expect(hidden('send-target-problem')).toBe(false);

    health = { ok: true, value: { service: 'devflow-mcp-server', mode: 'local' } };
    el<HTMLButtonElement>('send-recheck').click();
    await flush();

    expect(checkMcp).toHaveBeenCalledTimes(2);
    expect(hidden('send-target-problem')).toBe(true);
  });

  /** The toast can only name one cause; the banner names the one that happened. */
  it('explains a send that failed anyway, in the same place', async () => {
    await open();
    expect(hidden('send-target-problem')).toBe(true);

    sent = { ok: false, error: flowError('MCP_UNREACHABLE', 'HTTP 502') };
    el<HTMLButtonElement>('send-run').click();
    await flush();

    expect(el('send-target-problem-title').textContent).toBe('Something else is on that port');
    expect(el('send-target-problem-text').textContent).toContain('HTTP 502');
  });
});

describe('step URLs are warned about whatever the switches say', () => {
  const CALLBACK = step({ url: 'https://app.example.com/callback?code=4/0AY0e-g7' });

  it('raises the banner on the README’s own worked example', async () => {
    await open([CALLBACK]);

    expect(hidden('send-credentials')).toBe(false);
    expect(el('send-credentials-text').textContent).toContain('?code=');
  });

  it('survives turning every Include switch off', async () => {
    await open([CALLBACK]);

    for (const input of document.querySelectorAll<HTMLInputElement>('#send-includes input')) {
      if (input.checked) {
        input.checked = false;
        input.dispatchEvent(new Event('change'));
      }
    }

    expect(hidden('send-credentials')).toBe(false);
    // …and the bare note stops promising "nothing else" while it is up.
    expect(el('send-note').textContent).not.toContain('nothing else');
  });

  it('stays quiet over a flow whose URLs are ordinary', async () => {
    await open([step()]);
    expect(hidden('send-credentials')).toBe(true);
  });
});
