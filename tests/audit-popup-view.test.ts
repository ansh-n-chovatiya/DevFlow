/**
 * Two strings the popup got wrong, and neither of them looked wrong.
 *
 * The dialog is the sharper one. One `<dialog>` serves two questions — `Discard
 * flow` asks about deleting, `Start recording` asks about replacing — and it was
 * only ever dressed for the first. Pressing the popup's primary action on top of
 * an unsaved flow raised a sheet headed *Discard this flow?* whose filled button
 * read *Discard flow*, and the only mention of recording was one clause in the
 * middle of the body. Read at the speed a confirmation is actually read, that is
 * an offer to throw the flow away rather than a question about the thing that
 * was just pressed — so the safe-looking answer, *Keep it*, silently cancels the
 * recording the user asked for.
 *
 * The second is vocabulary. CONTRACTS §4.1 makes *flow* the noun for one
 * recording and lists "recording (as a noun)" among the words it is not, and the
 * popup's fallback flow name was `Recording — 14 Aug, 09:32`. `lint:vocab` looks
 * for misspellings of the frozen *labels* and cannot see a noun; this can.
 */

import { describe, expect, it } from 'vitest';

import type { Step } from '../src/shared/types.js';
import { confirmPrompt, suggestFlowName } from '../src/ui/popup/view.js';

const NOW = 1_700_000_000_000;

function step(overrides: Partial<Step> = {}): Step {
  return {
    type: 'click',
    url: 'https://github.com',
    timestamp: NOW - 5000,
    action: 'Clicked "Save changes"',
    element: { tag: 'button', cssSelector: 'button', xpath: '/button', boundingBox: null },
    ...overrides,
  } as Step;
}

describe('the one dialog, asked on behalf of two buttons', () => {
  it('names the action it is confirming, not the other one', () => {
    const start = confirmPrompt('start', 4);

    expect(start.title).toContain('Start recording');
    expect(start.confirm).toBe('Start recording');
    // Not "Keep it": the thing being kept and the thing being cancelled are
    // different, and the caller is not asking about keeping.
    expect(start.cancel).toBe('Cancel');
  });

  it('still asks plainly about deleting when deleting is what was pressed', () => {
    const discard = confirmPrompt('discard', 4);

    expect(discard.title).toBe('Discard this flow?');
    expect(discard.confirm).toBe('Discard flow');
    expect(discard.cancel).toBe('Keep it');
  });

  it('says what is at stake either way, and counts it', () => {
    expect(confirmPrompt('discard', 4).body).toContain('All 4 recorded steps');
    expect(confirmPrompt('discard', 1).body).toContain('The one recorded step');
    expect(confirmPrompt('start', 4).body).toContain('The 4 recorded steps');
    expect(confirmPrompt('start', 1).body).toContain('The one recorded step');

    for (const reason of ['discard', 'start'] as const) {
      expect(confirmPrompt(reason, 2).body).toContain('cannot be undone');
    }
  });
});

describe('the name a flow is filed under', () => {
  it('calls it a flow, which is the only noun CONTRACTS §4.1 allows', () => {
    // No title and no host to borrow from, so this is the fallback branch.
    const name = suggestFlowName([step({ title: undefined, url: 'about:blank' })], NOW);

    expect(name).not.toMatch(/Recording/);
    expect(name).toMatch(/^Flow — /);
  });
});
