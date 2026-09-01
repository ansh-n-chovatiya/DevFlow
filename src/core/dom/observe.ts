/**
 * Reading a burst of `MutationRecord`s down to a handful of facts.
 *
 * Pure functions over DOM nodes, in `core/selector`'s and `core/describe`'s
 * sense: no `chrome.*`, no module-level state, no clock, nothing that needs a
 * browser to be *running* rather than merely present. The observer itself — when
 * a window opens, how long it stays open, what it does with the answer — is in
 * `content/index.ts`, because that is a question about the recording rather than
 * about the records. The split is the one `core/render/blame.ts` made against
 * `injected/render.ts`, and it is here for the same reason: everything below can
 * be wrong in a way a reader would believe, so it has to be exercisable without
 * a page.
 *
 * ## Folding, and why the callback must not describe anything
 *
 * The reverted v3.2.0 attempt pushed every record on the document into an array.
 * The array was the headline problem; the quieter one is that describing a
 * mutation costs far more than observing it — a selector is a `querySelectorAll`
 * against the document to prove uniqueness, and a page mid-transition delivers
 * sixty records a second.
 *
 * So `collect` does no DOM queries at all. Each record is folded into a group
 * under a key built from an integer minted per node, and the group holds *live
 * references*. `describe` runs once, when the window closes and off the
 * gesture, and only then does anything build a selector. A step on a page that
 * mutated four hundred times pays four hundred map lookups.
 *
 * ## The fold is by element and attribute, never by value
 *
 * Ten rows appended to one list is one observation with a count of ten, because
 * the reader's question is *what did this interaction do* and ten near-identical
 * lines answer it ten times. Keying on the value instead would defeat the whole
 * fold in the one case it exists for: an attribute a CSS transition rewrites
 * sixty times has sixty distinct values and is one fact.
 */

import { DEVFLOW_ELEMENT_PREFIX, DOM_CHANGE_TEXT_CAP } from '../../shared/constants.js';
import { generateSelector } from '../selector/index.js';
import type { DomChangeKind } from '../../shared/types.js';
import type { DomObservation } from './changes.js';

/**
 * Elements whose coming and going is the toolchain, not the application.
 *
 * A CSS-in-JS runtime appends a `<style>` per component it first renders, and a
 * code-split route appends a `<script>`; on the first click into a new route
 * those alone can be most of what changed. None of them is what somebody asking
 * what an interaction did is asking about, and each one that survives costs a
 * line of the dozen a step gets.
 */
const UNINTERESTING_TAGS = new Set(['STYLE', 'SCRIPT', 'LINK', 'META', 'TEMPLATE']);

/** One folded group of mutations, holding live nodes rather than descriptions. */
interface DomGroup {
  kind: DomChangeKind;
  /** The element it happened to, or the one it happened inside. */
  target: Element;
  /** For `added` and `removed`, one of the nodes — named when the window closes. */
  sample: Element | null;
  attribute?: string;
  count: number;
}

/**
 * What one window has seen so far.
 *
 * Handed in and mutated rather than held here, so this module has no state of
 * its own and two windows could exist at once without discovering each other.
 * The recorder only ever opens one — see `content/index.ts` — but a module that
 * would break if it opened two is a module with state, whatever it calls it.
 */
export interface DomCollector {
  groups: Map<string, DomGroup>;
  /** An integer per node, so a group key costs no DOM work to build. */
  ids: Map<Node, number>;
  nextId: number;
  /** Records looked at, against `cap`. */
  seen: number;
  cap: number;
  /** The collector stopped early — see `StepDomChanges.capped`. */
  capped: boolean;
}

export function createCollector(cap: number): DomCollector {
  return {
    groups: new Map(),
    ids: new Map(),
    nextId: 0,
    seen: 0,
    cap: Math.max(1, cap),
    capped: false,
  };
}

/** Whether this collector has stopped and should be disconnected. */
export function collectorFull(collector: DomCollector): boolean {
  return collector.capped || collector.seen >= collector.cap;
}

/**
 * Nodes DevFlow put into the page, recognised so the fold can refuse them.
 *
 * This is not tidiness. The recording indicator is removed and re-added around
 * every screenshot, so without this every single step would open with a `div`
 * appearing and going in `<body>` — DevFlow reporting on DevFlow, at the top of
 * the budget, on every step of every flow.
 */
export function isDevFlowNode(node: Node | null): boolean {
  let el: Element | null =
    node instanceof Element ? node : ((node?.parentNode as Element | null) ?? null);
  // Bounded rather than a walk to the root: DevFlow's own DOM is one div deep,
  // and this runs once per record on a page that may be mutating continuously.
  for (let depth = 0; el && depth < 8; depth++) {
    if (typeof el.id === 'string' && el.id.startsWith(DEVFLOW_ELEMENT_PREFIX)) return true;
    el = el.parentElement;
  }
  return false;
}

function nodeId(collector: DomCollector, node: Node): number {
  const existing = collector.ids.get(node);
  if (existing !== undefined) return existing;
  const id = collector.nextId++;
  collector.ids.set(node, id);
  return id;
}

/**
 * Add one observation to its group, or start the group.
 *
 * The group map is bounded by the same number as the records, and needs its own
 * check rather than inheriting theirs: a single `childList` record can carry
 * hundreds of added nodes, so the record count alone does not bound how many
 * groups exist. Filling it stops the window exactly as running out of records
 * does, because from a reader's side those are one fact — the collector stopped
 * before the step did.
 */
function fold(
  collector: DomCollector,
  kind: DomChangeKind,
  target: Element,
  sample: Element | null,
  attribute?: string,
): void {
  const key = `${kind} ${nodeId(collector, target)} ${attribute ?? sample?.tagName ?? ''}`;
  const existing = collector.groups.get(key);
  if (existing) {
    existing.count++;
    return;
  }
  if (collector.groups.size >= collector.cap) {
    collector.capped = true;
    return;
  }
  collector.groups.set(key, {
    kind,
    target,
    sample,
    count: 1,
    ...(attribute ? { attribute } : {}),
  });
}

/**
 * One added or removed node.
 *
 * A text node coming or going is folded in as a *text* change on its parent
 * rather than as a node appearing: `Hello` becoming `Hi` is one `characterData`
 * mutation under one framework and a text node swapped out under another, and a
 * reader asking what changed is owed the same answer either way.
 */
function foldNode(
  collector: DomCollector,
  kind: DomChangeKind,
  parent: Element,
  node: Node,
): void {
  if (node.nodeType === 3) {
    // Whitespace is how a template indents. It is never the change.
    if (!(node.textContent ?? '').trim()) return;
    fold(collector, 'text', parent, null);
    return;
  }
  if (!(node instanceof Element)) return; // comments, which React uses as markers
  if (isDevFlowNode(node)) return;
  if (UNINTERESTING_TAGS.has(node.tagName)) return;
  fold(collector, kind, parent, node);
}

function foldRecord(collector: DomCollector, record: MutationRecord): void {
  const target = record.target;
  if (isDevFlowNode(target)) return;

  if (record.type === 'attributes') {
    const name = record.attributeName;
    if (!name || !(target instanceof Element)) return;
    fold(collector, 'attribute', target, null, name);
    return;
  }

  if (record.type === 'characterData') {
    const parent = target.parentElement;
    if (!parent) return;
    fold(collector, 'text', parent, null);
    return;
  }

  const parent = target instanceof Element ? target : target.parentElement;
  if (!parent) return;
  for (const node of Array.from(record.addedNodes)) foldNode(collector, 'added', parent, node);
  for (const node of Array.from(record.removedNodes)) foldNode(collector, 'removed', parent, node);
}

/**
 * Fold one delivery of records in, and stop at the cap.
 *
 * The cap is checked before each record rather than after the batch, because
 * the batch is the page's size and not ours: an observer on a page rebuilding a
 * virtualised list delivers thousands of records in one call, and a check that
 * runs afterwards has already paid for all of them.
 */
export function collect(collector: DomCollector, records: readonly MutationRecord[]): void {
  for (const record of records) {
    if (collectorFull(collector)) break;
    collector.seen++;
    foldRecord(collector, record);
  }
  if (collectorFull(collector)) collector.capped = true;
}

function clip(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > DOM_CHANGE_TEXT_CAP ? `${flat.slice(0, DOM_CHANGE_TEXT_CAP)}…` : flat;
}

/**
 * What one node is, in the words a reader recognises it by.
 *
 * The tag and the most identifying thing about it. Not a selector: a node that
 * has been removed has no selector that would find it again, and this is
 * describing what went rather than where to look for it.
 */
function describeNode(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const id = typeof el.id === 'string' && el.id ? `#${el.id}` : '';
  const role = el.getAttribute('role');
  const head = `${tag}${id}${role ? `[role=${role}]` : ''}`;
  const text = clip(el.textContent ?? '');
  return text ? `${head} ${JSON.stringify(text)}` : head;
}

/**
 * What one group says, read against the page as it settled.
 *
 * Settled, not before-and-after, and deliberately. The window closes once, so an
 * attribute written sixty times has one value that is true at the end and
 * fifty-nine that are not; reporting the first would describe a state the step
 * passed through as the state it ended in. `StepDomChanges` says this in the
 * contract, so a later reader does not read `what` as a before.
 */
function describeGroup(group: DomGroup): DomObservation | null {
  const where = generateSelector(group.target);
  if (!where) return null;

  const base = { kind: group.kind, where, count: group.count };

  if (group.kind === 'attribute') {
    const name = group.attribute ?? '';
    const value = group.target.getAttribute(name);
    return {
      ...base,
      attribute: name,
      // An attribute that is gone is not one that is empty, and `disabled=""` is
      // what `disabled` reads as when it is present.
      what: value === null ? `${name} removed` : `${name}=${JSON.stringify(clip(value))}`,
    };
  }

  if (group.kind === 'text') {
    const text = clip(group.target.textContent ?? '');
    return { ...base, ...(text ? { what: JSON.stringify(text) } : {}) };
  }

  return { ...base, ...(group.sample ? { what: describeNode(group.sample) } : {}) };
}

/**
 * Everything one collector saw, described, in the order it was first seen.
 *
 * First-seen and not last: `Map` iterates in insertion order and a group is
 * inserted when it is opened, so the order this returns is the order the
 * changes started happening. `planDomChanges` relies on that being temporal —
 * see its header for why the first structural change after a click is the one
 * most likely to be what the click did.
 */
export function describe(collector: DomCollector): DomObservation[] {
  const out: DomObservation[] = [];
  for (const group of collector.groups.values()) {
    const described = describeGroup(group);
    if (described) out.push(described);
  }
  return out;
}
