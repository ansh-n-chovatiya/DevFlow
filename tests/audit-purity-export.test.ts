/**
 * The export writers are pure, and the archive says what encoding its names are.
 *
 * Both of these are invisible when they are wrong. A `new Date()` inside
 * `core/export/` typechecks, passes every assertion about step content, and only
 * shows up as `mcp-server/core.js` returning a different document on every host
 * — so the assertion has to be that moving the machine's clock and locale moves
 * nothing in the output. And a ZIP with no UTF-8 flag unpacks perfectly for
 * every name DevFlow writes today, which is exactly what makes it worth pinning
 * before somebody adds a name that is not ASCII.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { exportToJSON } from '../src/core/export/json.js';
import { exportToMarkdown } from '../src/core/export/markdown.js';
import { createZip } from '../src/core/export/zip.js';
import type { Step } from '../src/shared/types.js';

const step = (over: Partial<Step> = {}): Step =>
  ({
    type: 'click',
    url: 'https://app.example.com/orders',
    timestamp: Date.parse('2026-08-01T09:30:00Z'),
    action: 'Clicked "Save"',
    element: {
      tag: 'button',
      cssSelector: '#save',
      xpath: '/html[1]/body[1]/button[1]',
      boundingBox: null,
    },
    ...over,
  }) as Step;

afterEach(() => {
  vi.useRealTimers();
});

describe('core/export reads no clock', () => {
  it('renders the same Markdown whatever the machine thinks the time is', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T18:05:00Z'));
    const first = exportToMarkdown([step()]);
    vi.setSystemTime(new Date('2031-01-09T02:14:00Z'));
    const second = exportToMarkdown([step()]);
    expect(second).toBe(first);
  });

  it('writes the same JSON whatever the machine thinks the time is', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-24T18:05:00Z'));
    const first = exportToJSON([step()]);
    vi.setSystemTime(new Date('2031-01-09T02:14:00Z'));
    const second = exportToJSON([step()]);
    expect(second).toBe(first);
  });

  it('omits the export stamp entirely when the caller supplies none', () => {
    // Absent rather than invented: the caller owns the clock, and a document
    // that dates itself off a clock nobody handed it is the bug above.
    expect(exportToMarkdown([step()])).not.toContain('Exported');
    expect(JSON.parse(exportToJSON([step()]))).not.toHaveProperty('exportedAt');
  });

  it('stamps exactly the instant the caller handed over', () => {
    const now = new Date('2026-08-24T18:05:33Z');
    expect(exportToMarkdown([step()], { now })).toContain('· Exported 2026-08-24 18:05 UTC');
    expect(JSON.parse(exportToJSON([step()], { now })).exportedAt).toBe('2026-08-24T18:05:33.000Z');
  });
});

describe('the Markdown header is not locale-dependent', () => {
  /*
   * `toLocaleString()` was what both dates used, and it renders one recording as
   * "8/1/2026, 9:30:00 AM" in one place and "01.08.2026, 11:30:00" in another —
   * so two exports of the same flow differed in the header on machines that
   * agreed about everything else. Stubbing the formatter is the only way to
   * assert it is gone: a run under one locale cannot tell a fixed format from a
   * locale format that happens to agree with it.
   */
  it('does not format either date through toLocaleString', () => {
    const spy = vi.spyOn(Date.prototype, 'toLocaleString');
    try {
      const md = exportToMarkdown([step()], { now: new Date('2026-08-24T18:05:00Z') });
      expect(spy).not.toHaveBeenCalled();
      expect(md).toContain('Recorded 2026-08-01 09:30 UTC');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the ZIP declares its entry names as UTF-8', () => {
  /*
   * Bit 11 of the general-purpose flag, in both the local header (offset 6) and
   * the central directory entry (offset 8). Without it an unzipper is entitled
   * to decode the name as CP437, and a flow whose images folder is not ASCII
   * unpacks to mojibake with nothing in the archive to blame.
   */
  it('sets bit 11 in the local header and the central directory', async () => {
    const encoder = new TextEncoder();
    const blob = await createZip([{ name: 'flow.md', data: encoder.encode('# hi\n') }]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const view = new DataView(bytes.buffer);

    const localSignature = 0x04034b50;
    const centralSignature = 0x02014b50;
    const locals: number[] = [];
    const centrals: number[] = [];
    for (let i = 0; i + 4 <= bytes.length; i += 1) {
      const signature = view.getUint32(i, true);
      if (signature === localSignature) locals.push(view.getUint16(i + 6, true));
      if (signature === centralSignature) centrals.push(view.getUint16(i + 8, true));
    }

    // `.gitignore` is prepended by the writer, so both entries are checked.
    expect(locals).toHaveLength(2);
    expect(centrals).toHaveLength(2);
    for (const flags of [...locals, ...centrals]) expect(flags & 0x800).toBe(0x800);
  });

  it('round-trips a non-ASCII entry name byte for byte as UTF-8', async () => {
    const encoder = new TextEncoder();
    const name = 'images/étape-01.jpg';
    const blob = await createZip([{ name, data: encoder.encode('x') }]);
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const expected = [...encoder.encode(name)];
    const haystack = [...bytes];
    const found = haystack.some((_, i) => expected.every((byte, j) => haystack[i + j] === byte));
    expect(found).toBe(true);
  });
});
