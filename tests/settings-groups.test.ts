/**
 * Settings are grouped by concept, not by origin.
 *
 * The criterion the merge is judged against is not that the settings all work —
 * they would work perfectly well in a "Recording" section and a section that was
 * recognisably the other product's. It is that a person reading the rail cannot
 * tell that this used to be two extensions. Half of `FIELDS` came from a
 * recorder and half from a tool that finds the file a component was written in,
 * and the four concepts in docs/CONTRACTS.md §3.6 cut across that seam rather
 * than along it: the editor and the project root serve both halves, and always
 * did.
 *
 * That is a claim about a data table, so it is checkable. What is asserted here
 * is the partition — every group under exactly one of the four, and the four
 * holding exactly the keys §3.6 lists — because the way this regresses is a
 * twelfth group added by somebody who had one setting that did not fit, called
 * after the feature it came from.
 */

import { describe, expect, it } from 'vitest';

import {
  CONCEPTS,
  conceptInfo,
  FIELDS,
  GROUPS,
  type Concept,
  type Field,
} from '../src/features/settings/fields.js';

/** §3.6, transcribed: the prefixes and flat keys each concept owns. */
const CONTRACT: Record<Concept, readonly string[]> = {
  source: [
    'editor',
    'customEditorTemplate',
    'projectRoot',
    'reactCapture',
    'reactResolve',
    'react.',
    /*
     * AHEAD OF THE CONTRACT, deliberately, and the only entry here that is.
     *
     * §3.6 does not list `vue.*` under any concept. It was written when React
     * was the only runtime that could name a component, and `vue.maxVNodeWalk`
     * is the same question — *which component drew this, and where was it
     * written* — asked of the second one. The `source` concept is where it
     * belongs; the document has not been told yet, and this repository does not
     * edit CONTRACTS.md to make a test pass.
     *
     * So this line is a request, not a transcription: §3.6's first bullet needs
     * `vue.*` added beside `react.*`. Until it is, the assertion below is
     * testing this file's opinion rather than the contract's, which is worth
     * exactly one line of comment and no more.
     */
    'vue.',
    'locator.hidden.',
  ],
  recording: [
    'recording.',
    'screenshots.',
    'network.',
    'console.',
    'annotation.',
    'thumbnails.',
  ],
  handover: ['export.', 'mcp.', 'mcpAutoSend', 'mcpServerUrl'],
  appearance: ['theme', 'ui.'],
};

const CONCEPT_OF = new Map<string, Concept>(GROUPS.map((group) => [group.id, group.concept]));

function conceptFor(field: Field): Concept {
  const found = CONCEPT_OF.get(field.group);
  expect(found, `group ${field.group} belongs to no concept`).toBeDefined();
  return found!;
}

/** Which concept §3.6 puts a key under, by the longest matching entry. */
function contractConcept(key: string): Concept | null {
  let best: { concept: Concept; length: number } | null = null;
  for (const [concept, patterns] of Object.entries(CONTRACT) as [Concept, string[]][]) {
    for (const pattern of patterns) {
      const hit = pattern.endsWith('.') ? key.startsWith(pattern) : key === pattern;
      if (hit && (!best || pattern.length > best.length)) {
        best = { concept, length: pattern.length };
      }
    }
  }
  return best?.concept ?? null;
}

describe('the four concepts', () => {
  it('are the four the contract froze, in its order', () => {
    expect(CONCEPTS.map((concept) => concept.id)).toEqual([
      'source',
      'recording',
      'handover',
      'appearance',
    ]);
    expect(CONCEPTS.map((concept) => concept.title)).toEqual([
      'React & source resolution',
      'Recording',
      'Export & MCP',
      'Appearance',
    ]);
  });

  it('each have a title, and `conceptInfo` is total over the union', () => {
    for (const concept of CONCEPTS) {
      expect(conceptInfo(concept.id).title, concept.id).toBe(concept.title);
    }
  });

  it('name no half of the product', () => {
    /*
     * The banned list, applied where it bites hardest. A concept called
     * "Locator" or "Recorder" would be the merge failing in one word, on the
     * most-read text on the screen — and it would read as entirely reasonable to
     * whoever added it.
     */
    for (const concept of [...CONCEPTS, ...GROUPS]) {
      const title = concept.title.toLowerCase();
      expect(title, concept.id).not.toContain('locator');
      expect(title, concept.id).not.toContain('recorder');
      expect(title, concept.id).not.toContain('devflow');
    }
  });
});

describe('the partition', () => {
  it('puts every group under exactly one concept', () => {
    for (const group of GROUPS) {
      expect(CONCEPTS.map((concept) => concept.id), group.id).toContain(group.concept);
    }
    expect(new Set(GROUPS.map((group) => group.id)).size).toBe(GROUPS.length);
  });

  it('leaves no concept empty, which would be a heading over nothing', () => {
    for (const concept of CONCEPTS) {
      expect(
        GROUPS.some((group) => group.concept === concept.id),
        concept.id,
      ).toBe(true);
    }
  });

  it('runs the groups in concept order, so the rail reads as four blocks', () => {
    // The rail is built from `GROUPS` in table order and puts a heading above the
    // first group of each run. A group filed out of order would produce the same
    // heading twice, which reads as two sections that happen to share a name.
    const seen: string[] = [];
    for (const group of GROUPS) {
      if (seen.at(-1) !== group.concept) seen.push(group.concept);
    }
    expect(seen).toEqual([...new Set(seen)]);
    expect(seen).toEqual(CONCEPTS.map((concept) => concept.id));
  });
});

describe('every key lands where the contract says', () => {
  it.each(FIELDS.map((field) => [field.key, field] as const))('%s', (key, field) => {
    const expected = contractConcept(key);
    expect(expected, `§3.6 names no home for ${key}`).not.toBeNull();
    expect(conceptFor(field as Field)).toBe(expected);
  });

  it('has an entry in §3.6 for every key, and no entry for a key that is gone', () => {
    const unmatched = FIELDS.filter((field) => contractConcept(field.key) === null);
    expect(unmatched.map((field) => field.key)).toEqual([]);
  });
});
