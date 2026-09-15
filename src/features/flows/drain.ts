/**
 * Waiting for a queue to settle, without waiting forever.
 *
 * `finishRecording` used to drain the capture queue with `do { drained =
 * captureQueue; await drained } while (drained !== captureQueue)` — wait for
 * the queue, then check whether anything was added while waiting, and repeat
 * until nothing was. Correct when the queue empties in finite time, but a page
 * that keeps producing capture traffic faster than the queue can drain it
 * (busy DOM, rapid clicking, a script generating synthetic interactions) kept
 * that loop running forever: Stop would never resolve, and the recording
 * looked permanently stuck on.
 *
 * `waitForStable` is the same wait, bounded. It gives up after a bounded
 * number of rounds or a bounded amount of wall-clock time, whichever comes
 * first, and says so — the caller decides what "gave up" means (here,
 * finishing the recording anyway rather than hanging Stop).
 */
export interface DrainBudget {
  maxIterations: number;
  maxWaitMs: number;
  /** Injectable for tests; defaults to the real clock. */
  now?: () => number;
}

export interface DrainOutcome {
  /** Whether the queue was observed unchanged across one full wait. */
  stable: boolean;
  /** How many rounds it took (or how many were spent before giving up). */
  iterations: number;
}

/**
 * `current()` returns whatever identity object is still changing — here, the
 * capture queue's promise. Waits for it to hold the same value across two
 * consecutive reads, exactly as the original loop did, but stops after
 * `budget.maxIterations` rounds or `budget.maxWaitMs`, whichever comes first.
 *
 * Whatever was already queued when the bound is hit keeps running — this
 * function only stops *waiting* for it, it never cancels anything. The work
 * still in flight becomes a no-op the moment the caller marks the recording
 * finished, because every capture handler re-checks `recordingActive` before
 * it writes.
 */
export async function waitForStable(
  current: () => Promise<unknown>,
  budget: DrainBudget,
): Promise<DrainOutcome> {
  const now = budget.now ?? Date.now;
  const deadline = now() + budget.maxWaitMs;

  let iterations = 0;
  let drained = current();

  for (;;) {
    await drained;
    iterations++;

    const next = current();
    if (next === drained) return { stable: true, iterations };
    if (iterations >= budget.maxIterations || now() >= deadline) {
      return { stable: false, iterations };
    }
    drained = next;
  }
}
