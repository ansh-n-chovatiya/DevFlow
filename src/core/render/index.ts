/**
 * What re-rendered across one step, judged from two readings of the fiber tree.
 *
 * One step, and deliberately only one: the walk that produces the readings is
 * impure — it touches fibers, the DevTools global and the page — and lives in
 * `injected/render.ts`. What is here is the part that can be reasoned about
 * without a browser, which is also the part that can be wrong in a way a person
 * would believe. See `blame.ts` for why `wasted` is the claim that needed the
 * care.
 */

export type {
  BlameResult,
  RenderBudget,
  RenderObservation,
  RenderSampleChange,
} from './blame.js';
export { blame } from './blame.js';
