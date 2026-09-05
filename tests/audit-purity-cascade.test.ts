/**
 * The cascade addresses a step by the same number `core/causal` does.
 *
 * Every node in the picture except the interaction itself is looked up in the
 * graph `buildCausalGraph` mints, and that module drops the stamped
 * `stepNumber`s for positions the moment two of them collide — because a ref
 * naming two events is a graph that cannot be walked. `buildCascade` used
 * `stepNumber ?? position` regardless, so on a flow with a duplicate stamp its
 * root ref named nothing, `effectsOf` came back empty, and the drawing was the
 * step with nothing under it.
 *
 * That is the failure worth a test rather than a comment: it does not throw and
 * it does not look wrong. "This interaction caused nothing observable" is a real
 * and common answer, so an empty cascade is indistinguishable from a correct
 * one unless something asserts the network and console nodes are there.
 *
 * A duplicate stamp is one deleted line away in any flow — the recorder stamps
 * at capture time and only `renumber()` on the way out repairs it.
 */

import { describe, expect, it } from 'vitest';
import { buildCascade, type CascadeInput, type CascadeStep } from '../src/core/cascade/index.js';

const step = (over: Partial<CascadeStep> = {}): CascadeStep => ({
  timestamp: 1_000,
  type: 'click',
  action: 'Clicked "Save"',
  url: 'https://app.example.com/orders',
  ...over,
});

/** Two steps stamped `2`, which is what a flow looks like after a deletion. */
const collided: CascadeInput = {
  steps: [
    step({ stepNumber: 2, action: 'Clicked "Save"' }),
    step({
      stepNumber: 2,
      timestamp: 2_000,
      action: 'Clicked "Submit"',
      networkCalls: [
        {
          method: 'POST',
          url: 'https://api.example.com/v2/submit',
          status: 500,
          timestamp: 2_010,
        },
      ],
      consoleLogs: [{ level: 'error', args: ['submit failed: /v2/submit'], timestamp: 2_020 }],
    }),
  ] as CascadeStep[],
};

describe('buildCascade numbers steps the way core/causal does', () => {
  it('draws what the second step caused even though both are stamped 2', () => {
    // Positional numbering, which is what the causal graph fell back to: the
    // second step is `2` by position as well, and the first is `1`.
    const cascade = buildCascade(collided, 2);
    expect(cascade).not.toBeNull();
    expect(cascade?.action).toBe('Clicked "Submit"');

    const kinds = cascade!.layers.flat().map((node) => node.kind);
    expect(kinds).toContain('network');
    expect(kinds).toContain('console');
  });

  it('still resolves the first step, which the stale stamps do not name at all', () => {
    const cascade = buildCascade(collided, 1);
    expect(cascade?.action).toBe('Clicked "Save"');
  });

  it('returns null for a number no step has, rather than an empty picture', () => {
    expect(buildCascade(collided, 9)).toBeNull();
  });

  it('leaves distinct stamped numbers alone', () => {
    const input: CascadeInput = {
      steps: [step({ stepNumber: 4, action: 'Clicked "Save"' }), step({ stepNumber: 7 })],
    };
    expect(buildCascade(input, 4)?.action).toBe('Clicked "Save"');
    expect(buildCascade(input, 1)).toBeNull();
  });
});
