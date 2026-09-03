/**
 * `__svelte_meta`: the one thing a Svelte element says about itself, and it says
 * it only in a development build.
 *
 * ## Why this is the whole of the Svelte adapter's input
 *
 * The React adapter starts from `element.__reactFiber$…` and walks an object
 * graph. Svelte has no equivalent, and this is measured rather than assumed
 * (`.ctx/spike-svelte.md`, Finding 1): a **production** Svelte element has
 * *zero* own properties. Not a hidden one, not a symbol carrying a component —
 * zero. The only element-to-function edge that survives minification is
 * `element[Symbol('events')][name]`, it exists solely on elements bound to one
 * of Svelte's 23 delegated events, and it yields the *event handler* rather than
 * the component that rendered the element. Measured, one such handler stringified
 * to `()=>wn(t)` — 9 characters, below `MIN_NEEDLE_LEN` (12), which the needle
 * builder correctly refuses.
 *
 * So there is exactly one input worth reading, and in dev it is better than
 * React's. `internal/client/dev/elements.js` writes
 *
 * ```js
 * element.__svelte_meta = { parent: dev_stack, loc: { file, line, column } };
 * ```
 *
 * which is file, line *and* column for the element plus a materialised chain of
 * the component call sites above it. React's `_debugSource` carries the first
 * half and nothing of the second.
 *
 * ## Why this module validates instead of casting
 *
 * The value comes off a page this extension does not own, through a `MAIN`-world
 * script, and every field of it is attacker-controlled in the ordinary sense
 * that any page script can write `el.__svelte_meta = 1`. The failure mode of a
 * cast is not a crash — it is `line: undefined` reaching `pos1()`, becoming `1`,
 * and a reader being sent confidently to the first line of a file. That is the
 * exact class of silently-plausible wrong number `core/locate/positions.ts`
 * exists to prevent, so the narrowing happens once, here, at the edge.
 *
 * ## Why the parent chain is flattened
 *
 * `parent` is a linked list, and a linked list read from page memory has no
 * guaranteed end: a cycle makes the walk hang on the click path. Flattening it
 * under a cap turns "trust the page's data structure" into "read at most N
 * frames", and leaves `chain.ts` filtering an array instead of re-deriving the
 * cap for itself.
 *
 * Pure — no DOM, no Chrome, no clock. The read that produces the raw value is
 * `src/injected/svelte.ts`; only the vocabulary and the narrowing are here.
 */

export { MAX_META_PARENT_WALK } from '../../shared/constants.js';
import { MAX_META_PARENT_WALK } from '../../shared/constants.js';

/**
 * Where an element is written, as the compiler recorded it.
 *
 * **The two axes have different bases, and that is Svelte's choice rather than
 * a bug here.** The compiler emits `$.add_locations(tpl, file, [[8, 0, …]])`
 * for a `<section>` written at the start of line 8 of `Counter.svelte`, and the
 * spike measured the resulting meta as `line: 8, column: 0` — so `line` is
 * 1-based and `column` is 0-based, the ordinary ESTree convention.
 *
 * They are plain `number`s here rather than `Pos1`/`Pos0` because this is the
 * narrowing of an untyped value read off a page. `chain.ts` is where each
 * crosses into the typed world, and it crosses them differently on purpose.
 */
export interface SvelteMetaLoc {
  file: string;
  /** 1-based. */
  line: number;
  /** 0-based. */
  column: number;
}

/**
 * One call site above an element.
 *
 * `type` is **not** always `'component'`. Measured on SvelteKit dev, the same
 * chain carries `'component'`, `'render'` and `'if'` frames, which is why
 * `chain.ts` filters rather than trusting every frame to name a component.
 *
 * `file` is the file the call site is *in* — the parent — and `componentTag` is
 * the name of the component being instantiated *at* it. The two belong to
 * different components, and reading them as one is the mistake this comment is
 * here to prevent.
 */
export interface SvelteMetaFrame {
  type: string;
  file: string;
  line: number;
  column: number;
  componentTag?: string;
}

/** `__svelte_meta`, narrowed, with the `parent` list flattened nearest-first. */
export interface SvelteMetaRead {
  loc: SvelteMetaLoc;
  frames: SvelteMetaFrame[];
  /** The walk hit `MAX_META_PARENT_WALK`, so `frames` does not reach the root. */
  truncated: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * A position the compiler wrote, or nothing.
 *
 * Rejects rather than clamps, and `min` differs per axis because the two axes
 * have different bases (see `SvelteMetaLoc`). A line of `NaN`, `0`, `-1` or
 * `'8'` is a position this module cannot describe: dropping the frame loses one
 * entry from a chain, whereas clamping it to a plausible number keeps the entry
 * and makes it lie — which is the failure `core/locate/positions.ts` exists for.
 */
function readNumber(value: unknown, min: number): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : null;
}

function readLoc(value: unknown): SvelteMetaLoc | null {
  if (!isRecord(value)) return null;
  if (typeof value.file !== 'string' || value.file === '') return null;

  const line = readNumber(value.line, 1);
  if (line === null) return null;

  return { file: value.file, line, column: readNumber(value.column, 0) ?? 0 };
}

function readFrame(value: unknown): SvelteMetaFrame | null {
  if (!isRecord(value)) return null;
  if (typeof value.type !== 'string' || value.type === '') return null;
  if (typeof value.file !== 'string' || value.file === '') return null;

  const line = readNumber(value.line, 1);
  if (line === null) return null;

  const column = readNumber(value.column, 0) ?? 0;
  const tag = typeof value.componentTag === 'string' ? value.componentTag : undefined;
  return { type: value.type, file: value.file, line, column, ...(tag ? { componentTag: tag } : {}) };
}

/**
 * Narrows a raw `el.__svelte_meta` into the measured shape, or says it is not one.
 *
 * `null` here means "this element was not rendered by a Svelte component in a
 * development build" — which is a different claim from every arm of
 * `AbsentReason`, and is why the caller has to decide between `null` and an
 * absence rather than this module deciding for it.
 *
 * A frame that fails validation ends the walk instead of being skipped: the
 * frames form an ancestry, and silently closing a gap in one would present a
 * grandparent as a parent.
 */
export function readSvelteMeta(value: unknown, frameLimit = MAX_META_PARENT_WALK): SvelteMetaRead | null {
  if (!isRecord(value)) return null;

  const loc = readLoc(value.loc);
  if (!loc) return null;

  const frames: SvelteMetaFrame[] = [];
  let cursor: unknown = value.parent;
  let truncated = false;

  while (isRecord(cursor)) {
    if (frames.length >= frameLimit) {
      truncated = true;
      break;
    }
    const frame = readFrame(cursor);
    if (!frame) break;
    frames.push(frame);
    cursor = cursor.parent;
  }

  return { loc, frames, truncated };
}
