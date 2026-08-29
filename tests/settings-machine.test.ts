// @vitest-environment jsdom

/**
 * The three machine-wide settings, and the two sides of the port.
 *
 * Phase 5's settings are the only ones on the screen that are not in force the
 * moment they are written. The number goes into `chrome.storage`; the thing it
 * governs is a Node process behind an HTTP boundary that may not be running,
 * may have been launched with a variable that outranks the file, and — for the
 * port — cannot act on it until it restarts. Every one of those is a way for a
 * control to look saved and do nothing.
 *
 * The port is worse than the other two, and it is the reason this file exists.
 * It is one number with two readers that cannot see each other: the server
 * binds it, and `mcpServerUrl` contains it. Moving one and not the other leaves
 * a server listening perfectly well on a port nothing sends to, and every
 * symptom of that points at the server rather than at the address.
 *
 * `mcp-config.test.ts` is the server's half — what the endpoint stores and what
 * bounds it. This is the extension's: what gets sent, where it gets sent, and
 * what the two rows say afterwards.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { alignToPort, portOf } from '../src/features/mcp/port.js';
import { configUrl } from '../src/features/mcp/remote.js';
import {
  fieldFor,
  MACHINE_KEYS,
  machineOverrides,
  type Field,
} from '../src/features/settings/fields.js';
import { addressNote, machineNote } from '../src/ui/settings/view.js';
import { installChromeSync, type SyncFake } from './helpers/chrome-sync.js';

describe('the address, moved to match the port', () => {
  it('keeps everything but the port, including the path a send needs', () => {
    // The setting points at `/flows` because that is where recordings are
    // POSTed. A rewrite that dropped it would break sending in the act of
    // fixing the port.
    expect(alignToPort('http://127.0.0.1:7734/flows', 9000)).toEqual({
      kind: 'moved',
      url: 'http://127.0.0.1:9000/flows',
      from: 7734,
    });
  });

  it('says nothing when the two already agree', () => {
    expect(alignToPort('http://localhost:7734/flows', 7734)).toEqual({ kind: 'agreed' });
    expect(addressNote({ kind: 'agreed' })).toBeNull();
  });

  it('leaves an address that is not this machine’s server exactly as it is', () => {
    /*
     * `mcp.port` says what the server *here* binds, and it reaches that server
     * through `POST /config` on this machine. An address pointing at a
     * colleague's box or a container is not that server, and moving its port
     * would silently redirect a send at a port nobody chose on a host this
     * setting says nothing about.
     */
    const alignment = alignToPort('https://flows.example.com/flows', 9000);
    expect(alignment).toEqual({ kind: 'remote', host: 'flows.example.com' });
    expect(addressNote(alignment)!.text).toContain('flows.example.com');
  });

  it('treats every spelling of loopback as this machine', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      expect(alignToPort(`http://${host}:7734/flows`, 9000).kind).toBe('moved');
    }
  });

  it('fills in the scheme’s own port rather than calling it absent', () => {
    // `http://127.0.0.1/flows` really does send to 80, and reporting "no port"
    // for it would make "already agrees" and "nothing to compare" the same
    // answer at the one moment they differ.
    expect(portOf('http://127.0.0.1/flows')).toBe(80);
    expect(portOf('https://flows.example.com/flows')).toBe(443);
    expect(portOf('not a url')).toBeNull();
  });

  it('says nothing about an address that is not a URL', () => {
    // It already has its own problem, and `resolve()` is about to fall back to
    // the default anyway.
    expect(alignToPort('127.0.0.1:7734', 9000)).toEqual({ kind: 'unusable' });
    expect(addressNote({ kind: 'unusable' })).toBeNull();
  });
});

describe('what is sent, and where', () => {
  it('sends the machine-wide half of the overrides, sparsely', () => {
    // `config.json` is the settings file and holds overrides only: a key at
    // its default belongs out of it, and its absence is what tells the server
    // to drop it rather than keep the last value it was sent.
    expect(
      machineOverrides({ 'mcp.port': 9000, 'mcp.maxTokens': 5000, theme: 'dark' }),
    ).toEqual({ 'mcp.port': 9000 });
    expect(machineOverrides({})).toEqual({});
  });

  it('posts to the origin the flows address names', () => {
    expect(configUrl('http://127.0.0.1:7734/flows')).toBe('http://127.0.0.1:7734/config');
    expect(configUrl('nonsense')).toBeNull();
  });

  it('is three keys, and the field table is where they are named', () => {
    expect([...MACHINE_KEYS]).toEqual(['mcp.port', 'mcp.maxFlows', 'mcp.maxFlowBytes']);
    for (const key of MACHINE_KEYS) expect(fieldFor(key)!.consumers).toContain('mcp');
  });
});

describe('what the row says afterwards', () => {
  const port = fieldFor('mcp.port') as Field;
  const reply = {
    file: '/home/u/.flowsnap/config.json',
    effective: { 'mcp.port': 9000 },
    overridden: [],
    restart: null,
  };

  it('names the file when there is nothing else to say', () => {
    const note = machineNote(port, 9000, 'http://127.0.0.1:7734/flows', reply);
    expect(note.tone).toBe('success');
    expect(note.text).toContain('/home/u/.flowsnap/config.json');
  });

  it('says the file was not written when nothing answered', () => {
    /*
     * The failure this endpoint actually has. `pushMachineConfig` is called
     * from one place and never retried in the background, so a server that was
     * down at the moment of the change leaves the value undelivered — and the
     * fix is the user's: start it, and press the button again. A row that went
     * green on the storage write alone would be hiding all of that.
     */
    const note = machineNote(port, 9000, 'http://127.0.0.1:7734/flows', null);
    expect(note.tone).toBe('danger');
    expect(note.text).toContain('http://127.0.0.1:7734/flows');
    expect(note.text).toContain('Send to server');
  });

  it('reports a value the server will never use over one it merely stored', () => {
    // The write succeeded, the file says what was asked for, and the number in
    // force is somebody else's — set on a process the user did not start.
    const note = machineNote(port, 9000, 'http://127.0.0.1:7734/flows', {
      ...reply,
      effective: { 'mcp.port': 7734 },
      overridden: [{ key: 'mcp.port', by: 'FLOWSNAP_PORT', using: 7734 }],
    });

    expect(note.tone).toBe('danger');
    expect(note.text).toContain('FLOWSNAP_PORT');
    expect(note.text).toContain('7734');
  });

  it('reports a clamp the server applied', () => {
    const flows = fieldFor('mcp.maxFlows') as Field;
    const note = machineNote(flows, 0, 'http://127.0.0.1:7734/flows', {
      ...reply,
      effective: { 'mcp.maxFlows': 1 },
    });

    expect(note.tone).toBe('danger');
    expect(note.text).toContain('clamped it to 1');
  });

  it('does not claim success while the port is still waiting for a restart', () => {
    const note = machineNote(port, 9000, 'http://127.0.0.1:7734/flows', {
      ...reply,
      restart: 'This server is listening on 7734 and cannot move a socket it has already bound.',
    });

    expect(note.tone).not.toBe('success');
    expect(note.text).toContain('already bound');
  });
});

// ── The page, driven ─────────────────────────────────────────────────────────

let chromeFake: SyncFake | undefined;
let posted: { url: string; body: unknown }[];

/**
 * Let the controller settle.
 *
 * Deeper than the other page tests need: a machine-wide commit is a write, a
 * push, a re-read and a repaint, each with its own awaits, and a count that
 * only just covered them would fail as a timing mystery the day one more
 * `await` is added.
 */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) await Promise.resolve();
};

/** Every reply the stubbed server gives, so a test can make it fail. */
let answer: { ok: boolean; body: Record<string, unknown> };

async function openSettings(sync: Record<string, unknown> = {}): Promise<void> {
  chromeFake = installChromeSync(sync);
  chromeFake.seedLocal({});
  posted = [];

  vi.stubGlobal('fetch', (url: string, init: { body: string }) => {
    posted.push({ url: String(url), body: JSON.parse(init.body) });
    return Promise.resolve({
      ok: answer.ok,
      status: answer.ok ? 200 : 500,
      json: () => Promise.resolve(answer.body),
    });
  });

  document.body.replaceChildren();
  vi.resetModules();
  await import('../src/ui/settings/main.js');
  await settle();
}

/** The sync area, for a case that has opened the page. */
const area = (): Record<string, unknown> => chromeFake!.area();

function row(key: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(`[data-key="${key}"]`);
  expect(found, `no row for ${key}`).not.toBeNull();
  return found!;
}

const noteOf = (key: string): string =>
  row(key).querySelector<HTMLElement>('.setting-row__note')!.textContent ?? '';

async function commit(key: string, value: string): Promise<void> {
  const input = row(key).querySelector<HTMLInputElement>('[data-focus]')!;
  input.value = value;
  input.dispatchEvent(new Event('change'));
  await settle();
}

beforeEach(() => {
  answer = {
    ok: true,
    body: {
      ok: true,
      file: '/home/u/.flowsnap/config.json',
      applied: {},
      effective: {},
      ignored: [],
      overridden: [],
      restart: null,
    },
  };
  Object.defineProperty(globalThis.navigator, 'clipboard', {
    configurable: true,
    value: { writeText: () => Promise.resolve() },
  });

  // jsdom implements the element but not the modal methods — and `close` has to
  // fire the event the dialog's own handler is on, or confirming does nothing.
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement): void {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close(
    this: HTMLDialogElement,
    value?: string,
  ): void {
    if (value !== undefined) this.returnValue = value;
    this.open = false;
    this.dispatchEvent(new Event('close'));
  };
});

afterEach(() => {
  // Only the page cases install one; the pure ones above share this file for
  // the subject, not for the harness.
  chromeFake?.restore();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('changing the port, on the screen', () => {
  it('tells the server that is running now, then moves the address', async () => {
    /*
     * The ordering is the whole thing. The server that has to be told about the
     * new port is the one currently answering on the *old* one — a push sent to
     * the new address would go to a port nothing is listening on yet, and the
     * file would never be written.
     */
    await openSettings();
    await commit('mcp.port', '9000');

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('http://127.0.0.1:7734/config');
    expect(posted[0].body).toEqual({ 'mcp.port': 9000 });

    // And only then the address, which is the other side of the same setting.
    expect(area()).toEqual({
      'mcp.port': 9000,
      mcpServerUrl: 'http://127.0.0.1:9000/flows',
    });
  });

  it('says on the address row that it was moved, and why', async () => {
    // A setting that silently changes a second setting is its own kind of trap,
    // and this one changes the address a recording is sent to.
    await openSettings();
    await commit('mcp.port', '9000');

    expect(noteOf('mcpServerUrl')).toContain('7734');
    expect(noteOf('mcp.port')).toContain('/home/u/.flowsnap/config.json');
  });

  it('leaves a remote address alone, and says so rather than moving it', async () => {
    await openSettings({ mcpServerUrl: 'https://flows.example.com/flows' });
    await commit('mcp.port', '9000');

    expect(area().mcpServerUrl).toBe('https://flows.example.com/flows');
    expect(noteOf('mcpServerUrl')).toContain('flows.example.com');
  });

  it('keeps the setting and says the file was not written when nothing answered', async () => {
    /*
     * The write to `chrome.storage` succeeded and the delivery did not, and the
     * row has to say the second part. Reverting the setting would be worse: the
     * user's answer is not wrong, it simply has not reached a server yet, and
     * the button beside the row is how it does when one is running.
     */
    answer = { ok: false, body: { error: 'connection refused' } };
    await openSettings();
    await commit('mcp.maxFlows', '12');

    expect(area()['mcp.maxFlows']).toBe(12);
    expect(noteOf('mcp.maxFlows')).toContain('not written');
  });

  it('does not push anything for a setting that travels in the flow', async () => {
    // The other MCP settings have a channel already. Sending them here would
    // promote them to machine-wide, where they would overrule every recording
    // this machine reads — including flows from a browser that never asked.
    await openSettings();
    await commit('mcp.maxTokens', '30000');

    expect(posted).toEqual([]);
  });

  it('delivers a port that arrived in an imported settings file', async () => {
    /*
     * the import is a change like any other, and it is the one path to these
     * three that does not go through a row. A file naming a port that is stored
     * and not delivered leaves the extension posting to a port the server will
     * never bind — the exact state the port setting exists to make impossible,
     * reached by the door with no handle on it.
     *
     * Driven through the `{}` view, which is the same five steps a picked file
     * takes: parse, plan, show the diff, confirm, apply.
     */
    await openSettings();

    const pane = document.querySelector<HTMLTextAreaElement>('[data-focus="json-overrides"]')!;
    pane.value = '{\n  "mcp.port": 9000\n}';
    pane.dispatchEvent(new Event('input'));
    await settle();

    [...document.querySelectorAll<HTMLButtonElement>('.json-view__actions .btn')]
      .find((button) => button.textContent?.includes('Review and apply'))!
      .click();
    await settle();

    document.querySelector('dialog')!.close('confirm');
    await settle();

    expect(posted).toHaveLength(1);
    expect(posted[0].url).toBe('http://127.0.0.1:7734/config');
    expect(posted[0].body).toEqual({ 'mcp.port': 9000 });
    expect(area().mcpServerUrl).toBe('http://127.0.0.1:9000/flows');
  });

  it('sends the machine half again when a key is reset, so the file loses it', async () => {
    await openSettings({ 'mcp.maxFlows': 12 });
    row('mcp.maxFlows').querySelector<HTMLButtonElement>('.setting-row__reset')!.click();
    await settle();

    expect(posted).toHaveLength(1);
    expect(posted[0].body).toEqual({});
    expect(area()['mcp.maxFlows']).toBeUndefined();
  });
});
