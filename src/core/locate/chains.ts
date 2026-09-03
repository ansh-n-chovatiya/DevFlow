/**
 * Matching component chains to the steps they belong to.
 *
 * The agent walks fibers in the page's own JS context and the recorder builds
 * steps in the isolated world. They are two listeners on one event, and the
 * message between them is asynchronous, so a chain can arrive either side of the
 * handler that wants it.
 *
 * Attaching whatever arrived most recently is the obvious approach and is wrong
 * in two ways that happen constantly:
 *
 *   - A click on a `<select>` is deliberately dropped by the recorder, because
 *     the `change` step already describes it. Its chain is never claimed, and
 *     would land on whatever step came next.
 *   - An `input` step is written 800 ms after the keystroke that caused it, by
 *     which time several later chains have arrived.
 *
 * So chains are keyed by `event.timeStamp`, which both worlds read from the same
 * dispatch and which needs nothing shared between them. A chain nobody claims
 * expires; a step whose chain never comes is written without one.
 *
 * Pure — no Chrome, no DOM. Timers only, which is what makes it testable.
 */

export interface KeyedChain<T> {
  /** `event.timeStamp` of the interaction this describes. */
  eventTime: number;
  value: T;
  /** When it arrived, for expiry. */
  at: number;
}

export interface ChainBufferOptions {
  /** Unclaimed chains held at once. */
  size: number;
  /** How long an unclaimed chain is worth keeping. */
  ttlMs: number;
  /** Longest a step may wait for a chain that has not arrived. */
  timeoutMs: number;
}

export interface ChainBuffer<T> {
  /** A chain arrived. Hands it straight to a waiting step, or holds it. */
  deliver(chain: KeyedChain<T>): void;
  /** The chain for one event, or null once `timeoutMs` has passed. */
  take(eventTime: number, now: number): Promise<T | null>;
  clear(): void;
  /** Unclaimed chains currently held — for tests and diagnostics. */
  pending(): number;
  /**
   * Adopt new limits.
   *
   * The buffer is built once, at `document_start`, and the three numbers it is
   * built from are settings a recording freezes — so they are not known until
   * the snapshot has been read, which is after the page can already have been
   * clicked. Rebuilding the buffer at that point would drop chains already
   * held; reconfiguring it keeps them and applies the new limits from the next
   * one. Called only when a recording starts, which is exactly when the frozen
   * values are re-read.
   */
  configure(next: ChainBufferOptions): void;
}

export function createChainBuffer<T>(options: ChainBufferOptions): ChainBuffer<T> {
  // A copy, so a caller cannot move the limits by mutating what it passed in —
  // `configure` is the one way, and it is the one that says why.
  let limits: ChainBufferOptions = { ...options };
  const held: KeyedChain<T>[] = [];
  /*
   * A queue per key, not one waiter per key.
   *
   * `event.timeStamp` is the key, and two steps can legitimately share one: a
   * `click` and the `change` it triggers are dispatched from the same user
   * gesture, and both ask for the chain. A single slot meant the second `take`
   * overwrote the first's resolver, so the first waited out its timeout and
   * recorded no components even though its chain had arrived. Costly rather than
   * wrong — a step loses its attribution, it never gains someone else's — but it
   * loses it silently, and the fix is a line.
   */
  const waiters = new Map<number, ((value: T) => void)[]>();

  return {
    deliver(chain) {
      const queue = waiters.get(chain.eventTime);
      const waiter = queue?.shift();
      if (waiter) {
        if (queue && queue.length === 0) waiters.delete(chain.eventTime);
        waiter(chain.value);
        return;
      }

      const cutoff = chain.at - limits.ttlMs;
      for (let i = held.length - 1; i >= 0; i--) {
        if (held[i].at < cutoff) held.splice(i, 1);
      }

      held.push(chain);
      while (held.length > limits.size) held.shift();
    },

    take(eventTime, now) {
      const index = held.findIndex((entry) => entry.eventTime === eventTime);
      if (index !== -1) {
        const [found] = held.splice(index, 1);
        // Older than the buffer's own TTL: the event it describes is long past,
        // and a stale chain is worse than none.
        if (now - found.at > limits.ttlMs) return Promise.resolve(null);
        return Promise.resolve(found.value);
      }

      return new Promise((resolve) => {
        const settle = (value: T | null): void => {
          const queue = waiters.get(eventTime);
          if (queue) {
            const at = queue.indexOf(waiter);
            if (at !== -1) queue.splice(at, 1);
            if (queue.length === 0) waiters.delete(eventTime);
          }
          resolve(value);
        };

        const timer = setTimeout(() => settle(null), limits.timeoutMs);

        const waiter = (value: T): void => {
          clearTimeout(timer);
          resolve(value);
        };

        const queue = waiters.get(eventTime);
        if (queue) queue.push(waiter);
        else waiters.set(eventTime, [waiter]);
      });
    },

    clear() {
      held.length = 0;
      waiters.clear();
    },

    pending() {
      return held.length;
    },

    configure(next) {
      limits = { ...next };
      // The new size applies from the next arrival rather than by trimming
      // here: a chain already held belongs to a step that may be about to ask
      // for it, and dropping it would lose an attribution the walk already paid
      // for.
    },
  };
}
