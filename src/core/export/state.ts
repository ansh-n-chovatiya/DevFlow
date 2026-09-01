/**
 * What the app's stores did, written into a compiled spec beside the step that
 * did it.
 *
 * ## Why this is not an assertion
 *
 * The roadmap item this answers is "state assertions from before/after store
 * diffs", and an assertion is not what ships, deliberately.
 *
 * DevFlow reads a store by walking React's fiber tree from inside the page,
 * looking for the shapes it recognises — a `react-redux` provider whose value
 * carries `getState`, a query client, a context a component actually consumed.
 * A test runner has no handle on any of that. Playwright could run the same
 * walk through `page.evaluate`, and that is exactly what must not be generated:
 * it is a few hundred lines of React-internals code pasted into a file the
 * developer owns, frozen at the version of React that was current the day the
 * flow was exported, and its failure mode is the worst one a regression suite
 * has. When React moves an internal the assertion throws, the suite goes red,
 * and it is reporting a bug in the application that is not there. An assertion
 * that can be wrong about the thing it is asserting is worse than no assertion,
 * because the response to a red test is to go and look at the app.
 *
 * The app's own store, on the other hand, is reachable *to the app's own
 * developer*, by whatever handle they choose to expose — and choosing it is an
 * app change, which is Invariant 1's whole point: DevFlow does not make one.
 *
 * So what the compiler can honestly carry is the observation. "This click is
 * the one that set `checkout.status` to `error`" is the answer to *what should
 * I assert here*, which is the question somebody turning a recording into a
 * regression test is actually stuck on. It is written beside the step, in the
 * paths the app's own store uses, and it says in the file why it is a comment.
 *
 * ## What is printed, and what is not
 *
 * The operations in the order the differ produced them, which is path order —
 * no ranking, because there is no honest one. Whether `/cart/total` matters
 * more than `/cart/items/0/qty` is a question about the app, and a compiler
 * that guessed would be burying the operation the reader came for under one it
 * chose. A reader scanning for a path they recognise is best served by an order
 * they can predict.
 *
 * Both of `StepStateDelta`'s honesty flags travel, because each changes what
 * the list means: a `bounded` patch describes a *view* of the store cut at the
 * snapshot caps, and a `collapsed` one describes coarser operations than the
 * ones that happened. A developer writing an assertion off either of those
 * without being told would be asserting on something the recording never
 * claimed.
 *
 * Pure, like everything under `src/core/`: steps in, comment lines out.
 */

import type { PatchOp, Step } from '../../shared/types.js';
import { commentText } from './literals.js';

/**
 * Operations printed for one store on one step.
 *
 * Tier 3 and deliberately not a setting. It is the length of a comment block a
 * person reads before their eye slides off, and the number that suits an app is
 * not a different number — a patch with more operations than this is one whose
 * shape the reader gets from the first few and whose detail they get from
 * `get_state_patch`, which has the whole of it.
 */
const OPS_PER_STORE = 6;

/** Characters of one operation's value. A comment line, not a fixture. */
const VALUE_CHARS = 60;

/**
 * The block that explains, once per file, why these are comments.
 *
 * Once per file rather than once per step: repeated beside every step it would
 * be most of the spec, and the point it makes is about the compiler rather than
 * about any one interaction.
 */
export const STATE_PREAMBLE: readonly string[] = [
  'State changes seen while recording are written beside the steps that caused',
  'them, as comments rather than as assertions.',
  '',
  "DevFlow reads a store by walking React's fiber tree from inside the page.",
  'This runner has no handle on that, and generating the walk into this file',
  'would tie your suite to React internals: when React moves one, the assertion',
  'throws and the suite reports a bug in your app that is not there.',
  '',
  'Your store is reachable to you, by whatever handle you choose to expose.',
  'These lines say what changed and where, so the assertion you write is the one',
  'you meant.',
];

/**
 * One operation's value, or `null` for the operation that has none.
 *
 * Returned without its ` = ` so the caller can escape the value alone.
 * `commentText` trims what it is given, so an escaper applied to the separator
 * as well eats the spaces around it and produces `/checkout/status= "error"`.
 */
function value(op: PatchOp): string | null {
  if (op.op === 'remove') return null;
  try {
    const encoded = JSON.stringify(op.value) ?? String(op.value);
    return encoded.length > VALUE_CHARS ? `${encoded.slice(0, VALUE_CHARS)}…` : encoded;
  } catch {
    // A value the snapshot let through that will not stringify — a BigInt, or
    // an object with a throwing `toJSON`. The path and the operation are still
    // the finding.
    return '(unprintable)';
  }
}

/**
 * One step's state changes, as comment bodies without the `//`.
 *
 * Bodies rather than whole lines so each generator can indent them the way it
 * indents everything else — the two differ by two spaces and by nothing else,
 * which is what keeps them line-for-line mirrors.
 *
 * Empty for a step whose stores did not move, which is most steps: a recording
 * writes no delta at all when nothing changed, so absence here is the recording
 * saying nothing happened rather than this deciding not to mention it.
 */
export function stateComments(step: Step): string[] {
  const deltas = step.state ?? [];
  if (!deltas.length) return [];

  const lines: string[] = ['State observed here — assert on it in your app’s own terms:'];

  for (const delta of deltas) {
    const store = commentText(delta.store);
    const ops = delta.patch ?? [];

    for (const op of ops.slice(0, OPS_PER_STORE)) {
      const shown = value(op);
      const suffix = shown === null ? '' : ` = ${commentText(shown)}`;
      lines.push(`  ${store}  ${op.op} ${commentText(op.path)}${suffix}`);
    }

    const over = ops.length - OPS_PER_STORE;
    if (over > 0) {
      lines.push(
        `  ${store}  … ${over} more operation${over === 1 ? '' : 's'} — get_state_patch has all of them`,
      );
    }

    /*
     * Each flag changes what the list above means, so neither is optional
     * decoration. Under `bounded` the patch describes the store as the snapshot
     * caps left it, and a path that is absent may have changed below the cut;
     * under `collapsed` the operations are coarser than the ones the app made.
     */
    if (delta.bounded) {
      lines.push(
        `  ${store}  the snapshot was cut at its caps, so this is a bounded view of the store`,
      );
    }
    if (delta.collapsed) {
      lines.push(
        `  ${store}  ${delta.collapsed} finer operation${delta.collapsed === 1 ? ' was' : 's were'} folded into coarser replaces to fit the budget`,
      );
    }
  }

  return lines;
}

/** Whether any step in a flow has state worth a preamble. */
export function hasState(steps: readonly Step[]): boolean {
  return steps.some((step) => (step.state ?? []).length > 0);
}
