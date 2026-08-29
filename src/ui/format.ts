/**
 * Turning numbers into the words a person reads.
 *
 * Pure and shared by every surface, so "2 minutes ago" means the same thing in
 * the popup and in the viewer. Covered by tests/format.test.ts.
 */

const KB = 1024;
const MB = KB * 1024;

/** Storage sizes, at the precision the number deserves: `912 KB`, `1.2 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 KB';
  if (bytes < MB) return `${Math.max(1, Math.round(bytes / KB))} KB`;
  return `${(bytes / MB).toFixed(1)} MB`;
}

/**
 * Bytes of text as the tokens a model will charge for them.
 *
 * Four characters to a token is the rule of thumb Anthropic publishes for
 * English prose, and JSON keys and URLs are denser than that — so this reads as
 * a floor, which is why every caller prefixes it with `~`. It exists because
 * "3.4 MB" answers a question about disk and the question being asked here is
 * about context.
 */
export function formatTokens(bytes: number): string {
  return formatTokenCount(Math.max(0, bytes) / 4);
}

/**
 * A token count that is already a token count.
 *
 * Split out from `formatTokens` when the send dialog gained a second figure it
 * does not derive from a length: an image's cost is a per-image constant, not
 * four characters to the token, and reaching it through the bytes formatter
 * meant multiplying by four to have it divided by four again.
 */
export function formatTokenCount(tokens: number): string {
  const rounded = Math.round(Math.max(0, tokens));
  if (rounded < 1000) return `${rounded}`;
  if (rounded < 10_000) return `${(rounded / 1000).toFixed(1)}k`;
  return `${Math.round(rounded / 1000)}k`;
}

const MINUTE = 60_000;
const HOUR = MINUTE * 60;
const DAY = HOUR * 24;

/**
 * How long ago something happened, in a full phrase: `just now`, `2 minutes
 * ago`. For anything older than a week the phrase stops being useful and the
 * caller should show a date instead — hence the `null`.
 */
export function formatRelative(ageMs: number): string | null {
  if (ageMs < 0) return 'just now';
  if (ageMs < MINUTE) return 'just now';

  if (ageMs < HOUR) {
    const minutes = Math.floor(ageMs / MINUTE);
    return minutes === 1 ? '1 minute ago' : `${minutes} minutes ago`;
  }

  if (ageMs < DAY) {
    const hours = Math.floor(ageMs / HOUR);
    return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  }

  const days = Math.floor(ageMs / DAY);
  if (days > 7) return null;
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

/** The same age, abbreviated, for a line that is already tight: `2s`, `4m`. */
export function formatAgo(ageMs: number): string {
  if (ageMs < 1000) return 'now';
  if (ageMs < MINUTE) return `${Math.floor(ageMs / 1000)}s ago`;
  if (ageMs < HOUR) return `${Math.floor(ageMs / MINUTE)}m ago`;
  return `${Math.floor(ageMs / HOUR)}h ago`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * An absolute moment, for anything `formatRelative` has given up on: `14 Aug,
 * 09:32`, and `14 Aug 2025, 09:32` once the year stops being obvious.
 *
 * Deliberately not `toLocaleString`, which returns a different string on every
 * machine and would put a slash-heavy US date into a mono column sized for this
 * one. The clock is local; only the shape is fixed.
 */
export function formatDateTime(timestamp: number, now = Date.now()): string {
  const at = new Date(timestamp);
  if (Number.isNaN(at.getTime())) return '';

  const day = at.getDate();
  const month = MONTHS[at.getMonth()];
  const year = at.getFullYear() === new Date(now).getFullYear() ? '' : ` ${at.getFullYear()}`;
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;

  return `${day} ${month}${year}, ${time}`;
}

/**
 * A running timer: `00:47`, `12:05`, `1:02:05`. Minutes stay zero-padded so the
 * digits do not shift width as it counts — the tabular-figures rule in CSS only
 * fixes the glyphs, not how many of them there are.
 */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const seconds = total % 60;
  const minutes = Math.floor(total / 60) % 60;
  const hours = Math.floor(total / 3600);

  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return hours > 0 ? `${hours}:${mm}:${ss}` : `${mm}:${ss}`;
}
