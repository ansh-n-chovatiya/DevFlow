/**
 * Waiting for the capture queue to settle, without waiting forever.
 *
 * `finishRecording` used to drain the queue with `do { drained = captureQueue;
 * await drained } while (drained !== captureQueue)` — no ceiling on how long
 * that could take if new work kept landing on the queue faster than it could
 * drain. `waitForStable` is the same wait with a bound; these tests are the
 * two claims that matter: a queue that settles in finite time still reports
 * `stable: true` at the same point the old loop would have returned, and a
 * queue that never stops growing still returns — bounded, not stuck — rather
 * than hanging the test (and, in the product, hanging Stop).
 */

import { describe, expect, it } from 'vitest';
import { waitForStable } from '../src/features/flows/drain.js';

describe('waitForStable', () => {
  it('reports stable once two consecutive reads agree, like the original loop', async () => {
    const queue = Promise.resolve();
    let reads = 0;

    const current = () => {
      reads++;
      return queue;
    };

    const outcome = await waitForStable(current, { maxIterations: 50, maxWaitMs: 1000 });

    expect(outcome.stable).toBe(true);
    // One read to get the value, one more to confirm nothing changed while
    // awaiting it — the same two reads the original `do`/`while` cost for an
    // already-settled queue.
    expect(reads).toBe(2);
  });

  it('keeps waiting through a finite backlog and still reports stable', async () => {
    let queue = Promise.resolve();
    let remaining = 5;

    const current = () => {
      if (remaining > 0) {
        remaining--;
        queue = queue.then(() => undefined);
      }
      return queue;
    };

    const outcome = await waitForStable(current, { maxIterations: 50, maxWaitMs: 1000 });

    expect(outcome.stable).toBe(true);
    expect(remaining).toBe(0);
  });

  it('gives up once the iteration bound is hit, for a queue that never stops growing', async () => {
    let queue = Promise.resolve();

    // Every read adds more work — the runaway-page scenario the original loop
    // could never escape.
    const current = () => {
      queue = queue.then(() => undefined);
      return queue;
    };

    const outcome = await waitForStable(current, { maxIterations: 10, maxWaitMs: 60_000 });

    expect(outcome.stable).toBe(false);
    expect(outcome.iterations).toBe(10);
  });

  it('gives up once the wall-clock bound is hit, independent of the iteration count', async () => {
    let queue = Promise.resolve();
    let now = 0;

    const current = () => {
      queue = queue.then(() => undefined);
      return queue;
    };

    const outcome = await waitForStable(current, {
      maxIterations: 1_000_000,
      maxWaitMs: 30,
      now: () => {
        now += 10;
        return now;
      },
    });

    expect(outcome.stable).toBe(false);
    expect(outcome.iterations).toBeGreaterThan(0);
  });

  it('resolves promptly for a runaway queue — this test itself does not hang', async () => {
    let queue = Promise.resolve();
    const current = () => {
      queue = queue.then(() => undefined);
      return queue;
    };

    // No injected clock: the real one, bounded tightly, so a regression back
    // to the unbounded loop would time out this test rather than the product.
    const outcome = await waitForStable(current, { maxIterations: 1_000_000, maxWaitMs: 20 });
    expect(outcome.stable).toBe(false);
  }, 2000);
});
