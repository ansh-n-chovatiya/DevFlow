/**
 * The cascade is looked up by step *number*, and the review draws by position.
 *
 * `stepNumber` is stamped at capture time and goes stale the moment a step is
 * deleted — `core/flow`'s `renumber` exists for exactly that, and every other
 * path out of a flow already calls it. `ui/viewer/review.ts` did not, so
 * `buildCascade` searched for a number no remaining step carried, `openCascade`
 * answered false, and the "What this caused" button on every card below the
 * deleted step did nothing at all: no picture, no sentence, no error.
 *
 * This pins the shape of that failure rather than the DOM, because the fix is
 * one call and the thing that must not come back is the mismatch.
 */

import { describe, expect, it } from 'vitest';
import { buildCascade } from '../src/core/cascade/index.js';
import { renumber } from '../src/core/flow/index.js';
import type { Step } from '../src/shared/types.js';

/** Three steps as the recorder stamps them, with the first one deleted. */
const afterDeletingStepOne = (): Step[] =>
  [
    {
      type: 'click',
      action: 'Clicked "Pay"',
      url: 'https://example.com/',
      timestamp: 2,
      stepNumber: 2,
      networkCalls: [
        {
          method: 'POST',
          url: 'https://example.com/api/pay',
          requestHeaders: {},
          requestBody: null,
          status: 500,
          responseHeaders: {},
          responseBody: null,
          durationMs: 40,
          timestamp: 3,
        },
      ],
    },
    {
      type: 'click',
      action: 'Clicked "Retry"',
      url: 'https://example.com/',
      timestamp: 9,
      stepNumber: 3,
    },
  ] as unknown as Step[];

describe('a cascade asked for by the number on the card', () => {
  it('finds nothing once a deletion has made the stamped numbers stale', () => {
    // The first remaining card is drawn as "Step 1"; its stamp still says 2.
    expect(buildCascade({ steps: afterDeletingStepOne(), stores: [] }, 1)).toBeNull();
  });

  it('finds the step once the list is renumbered from position', () => {
    const cascade = buildCascade({ steps: renumber(afterDeletingStepOne()), stores: [] }, 1);

    expect(cascade).not.toBeNull();
    expect(cascade?.step).toBe(1);
    expect(cascade?.action).toBe('Clicked "Pay"');
  });

  it('leaves an untouched recording exactly where it was', () => {
    // Renumbering is a no-op on a flow nobody has edited, so the fix cannot
    // change what the button already drew.
    const steps = afterDeletingStepOne().map((step, at) => ({ ...step, stepNumber: at + 1 }));

    expect(buildCascade({ steps: renumber(steps), stores: [] }, 2)?.step).toBe(
      buildCascade({ steps, stores: [] }, 2)?.step,
    );
  });
});
