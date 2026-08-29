import { describe, expect, it } from 'vitest';
import {
  formatAgo,
  formatBytes,
  formatDateTime,
  formatElapsed,
  formatRelative,
  formatTokens,
} from '../src/ui/format.js';

const MINUTE = 60_000;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;

describe('formatBytes', () => {
  it('reports KB below a megabyte and MB above it', () => {
    expect(formatBytes(4096)).toBe('4 KB');
    expect(formatBytes(912 * 1024)).toBe('912 KB');
    expect(formatBytes(1.25 * 1024 * 1024)).toBe('1.3 MB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10.0 MB');
  });

  it('never reports "0 KB" for something that exists', () => {
    // A step that occupies 40 bytes has still been written; rounding it to zero
    // would make the storage meter look broken at the start of a recording.
    expect(formatBytes(40)).toBe('1 KB');
    expect(formatBytes(0)).toBe('0 KB');
  });
});

describe('formatTokens', () => {
  it('reads as a count, not a size — the send dialog is asking about context', () => {
    expect(formatTokens(400)).toBe('100');
    expect(formatTokens(20_000)).toBe('5.0k');
    expect(formatTokens(400_000)).toBe('100k');
  });

  it('keeps a decimal only while it still means something', () => {
    expect(formatTokens(4 * 9_500)).toBe('9.5k');
    expect(formatTokens(4 * 42_400)).toBe('42k');
  });

  it('treats a negative or empty flow as nothing rather than as a bug on screen', () => {
    expect(formatTokens(0)).toBe('0');
    expect(formatTokens(-100)).toBe('0');
  });
});

describe('formatRelative', () => {
  it('says "just now" for anything under a minute', () => {
    expect(formatRelative(0)).toBe('just now');
    expect(formatRelative(59_000)).toBe('just now');
  });

  it('singularises', () => {
    expect(formatRelative(MINUTE)).toBe('1 minute ago');
    expect(formatRelative(2 * MINUTE)).toBe('2 minutes ago');
    expect(formatRelative(HOUR)).toBe('1 hour ago');
    expect(formatRelative(DAY)).toBe('yesterday');
    expect(formatRelative(3 * DAY)).toBe('3 days ago');
  });

  it('gives up past a week, so the caller shows a date instead', () => {
    expect(formatRelative(8 * DAY)).toBeNull();
  });

  it('treats a clock that went backwards as now', () => {
    // Chrome's storage timestamps and Date.now() can disagree across a system
    // clock change; "in -3 minutes" is not a thing to show anyone.
    expect(formatRelative(-5000)).toBe('just now');
  });
});

describe('formatAgo', () => {
  it('abbreviates for lines that are already tight', () => {
    expect(formatAgo(400)).toBe('now');
    expect(formatAgo(2400)).toBe('2s ago');
    expect(formatAgo(4 * MINUTE)).toBe('4m ago');
    expect(formatAgo(3 * HOUR)).toBe('3h ago');
  });
});

describe('formatElapsed', () => {
  it('zero-pads minutes so the timer does not change width as it counts', () => {
    expect(formatElapsed(0)).toBe('00:00');
    expect(formatElapsed(47_000)).toBe('00:47');
    expect(formatElapsed(9 * MINUTE + 5000)).toBe('09:05');
  });

  it('adds hours only once there are any', () => {
    expect(formatElapsed(59 * MINUTE)).toBe('59:00');
    expect(formatElapsed(HOUR + 2 * MINUTE + 5000)).toBe('1:02:05');
  });

  it('floors rather than rounding, so the timer never shows a second early', () => {
    expect(formatElapsed(1999)).toBe('00:01');
  });
});

describe('formatDateTime', () => {
  it('drops the year while it is still obvious', () => {
    const at = new Date(2026, 7, 14, 9, 32).getTime();
    expect(formatDateTime(at, new Date(2026, 11, 1).getTime())).toBe('14 Aug, 09:32');
  });

  it('brings the year back once it is not', () => {
    const at = new Date(2025, 0, 3, 18, 5).getTime();
    expect(formatDateTime(at, new Date(2026, 0, 1).getTime())).toBe('3 Jan 2025, 18:05');
  });

  it('zero-pads the clock so a mono column does not shift', () => {
    const at = new Date(2026, 2, 9, 7, 4).getTime();
    expect(formatDateTime(at, at)).toBe('9 Mar, 07:04');
  });

  it('returns nothing for a timestamp that is not one', () => {
    expect(formatDateTime(Number.NaN)).toBe('');
  });
});
