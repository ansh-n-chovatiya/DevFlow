/**
 * What one interaction did to the document, judged from what a
 * MutationObserver saw.
 *
 * One step, and only the part that can be reasoned about without a browser —
 * the observer itself, and everything that reads a live node, is in
 * `content/index.ts`. The split is `core/render`'s, for its reason: the budget
 * decisions are the ones that can be wrong in a way a reader would believe.
 */

export type { DomChangeBudget, DomChangePlan, DomObservation, RankableChange } from './changes.js';
export { planDomChanges, rankForBudget, rankOf } from './changes.js';
export type { DomCollector } from './observe.js';
export { collect, collectorFull, createCollector, describe, isDevFlowNode } from './observe.js';
export { climb, interactionTarget, isElement } from './walk.js';
