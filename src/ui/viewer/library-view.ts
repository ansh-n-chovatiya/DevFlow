/**
 * What the library should show, derived from what is stored.
 *
 * Pure: no `chrome.*`, no DOM, no clock of its own. Every decision about which
 * state the library is in lives here and is covered by tests/library-view.test.ts,
 * so the controller is left with nothing but rendering.
 */

import { countFailures, flowHost } from '../../core/flow/index.js';
import type { FlowMeta, RecordingState, Step, StepType } from '../../shared/types.js';
import { formatDateTime, formatRelative } from '../format.js';

/**
 * How the list is ordered.
 *
 * The design frame offered `All / Recent / Largest`, which is one filter and two
 * sorts wearing the same control — "All" of what, against a list that is already
 * all of them? These are three orderings, and the control does one thing.
 */
export type LibrarySort = 'recent' | 'largest' | 'name';

export interface LibraryInput {
  /** `null` while the index is still being read. */
  flows: FlowMeta[] | null;
  /** The recording in progress. `null` while it is still being read. */
  current: { steps: Step[]; recording: RecordingState } | null;
  /**
   * `null` when usage has not been measured yet — or when the measurement was
   * refused. Both are "we do not know", and the footer hides for both. A
   * failure used to arrive here as `0`, which is a figure, so the footer showed
   * "0 B stored" beneath a library of eight flows.
   */
  usedBytes: number | null;
  query: string;
  sort: LibrarySort;
  now: number;
}

export interface CurrentFlowView {
  /** `IN PROGRESS` while the recorder is running; `UNSAVED` once it has stopped. */
  status: 'recording' | 'paused' | 'unsaved';
  stepCount: number;
  host: string;
  when: string;
  /** Data URLs, oldest first, capped at THUMBNAIL_LIMIT. */
  thumbnails: string[];
  /** Steps with images beyond the ones shown. */
  extra: number;
  failures: number;
}

export interface FlowRowView {
  id: string;
  name: string;
  thumbnail: string | null;
  stepCount: number;
  /** `null` for a flow saved before the index carried a host. */
  host: string | null;
  when: string;
  size: number | null;
  /** Step-type counts, largest first, for the row's chips. */
  counts: { type: StepType; count: number }[];
  failures: number;
}

/** A figure, not a proportion — `unlimitedStorage` leaves no denominator. */
export interface LibraryStorageView {
  usedBytes: number;
}

/** Which block fills the page. Exactly one, always. */
export type LibraryBody = 'loading' | 'empty' | 'no-matches' | 'list';

export interface LibraryView {
  body: LibraryBody;
  /** One line under the title: how many flows, and what they cost. */
  summary: string;
  current: CurrentFlowView | null;
  flows: FlowRowView[];
  storage: LibraryStorageView | null;
  /** The search box is pointless with nothing to search. */
  searchable: boolean;
}

/** How many screenshot thumbnails the current-flow card shows before counting. */
export const THUMBNAIL_LIMIT = 4;

function storageView(usedBytes: number | null): LibraryStorageView | null {
  return usedBytes == null ? null : { usedBytes };
}

/** `just now` while that is still true, an exact moment once it is not. */
function whenLabel(timestamp: number, now: number): string {
  return formatRelative(now - timestamp) ?? formatDateTime(timestamp, now);
}

function currentView(input: LibraryInput): CurrentFlowView | null {
  const { current, now } = input;
  if (!current || current.steps.length === 0) return null;

  const withImages = current.steps.filter((step) => Boolean(step.screenshot));
  const thumbnails = withImages.slice(0, THUMBNAIL_LIMIT).map((step) => step.screenshot as string);
  const last = current.steps[current.steps.length - 1];

  return {
    status:
      current.recording === 'recording'
        ? 'recording'
        : current.recording === 'paused'
          ? 'paused'
          : 'unsaved',
    stepCount: current.steps.length,
    host: flowHost(current.steps),
    when: whenLabel(last.timestamp, now),
    thumbnails,
    extra: Math.max(0, withImages.length - thumbnails.length),
    failures: countFailures(current.steps),
  };
}

function rowView(meta: FlowMeta, now: number): FlowRowView {
  const counts = Object.entries(meta.counts ?? {})
    .map(([type, count]) => ({ type: type as StepType, count }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count);

  return {
    id: meta.id,
    name: meta.name,
    thumbnail: meta.thumbnail ?? null,
    stepCount: meta.stepCount,
    host: meta.host || null,
    when: whenLabel(meta.createdAt, now),
    size: meta.bytes ?? null,
    counts,
    failures: meta.errorCount ?? 0,
  };
}

/** Name and host only. Searching step text would mean loading every flow. */
function matches(meta: FlowMeta, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;

  return (
    meta.name.toLowerCase().includes(needle) || (meta.host ?? '').toLowerCase().includes(needle)
  );
}

const SORTS: Record<LibrarySort, (a: FlowMeta, b: FlowMeta) => number> = {
  recent: (a, b) => b.createdAt - a.createdAt,
  // A flow saved before the index carried sizes sorts last rather than first:
  // treating "unknown" as zero would bury the flows a user is looking for when
  // they open a size ordering, which is always to find something to delete.
  largest: (a, b) => (b.bytes ?? -1) - (a.bytes ?? -1),
  name: (a, b) => a.name.localeCompare(b.name),
};

/** Saved flows only. Storage is the footer's job — it counts the unsaved one too. */
function summaryLine(flows: FlowMeta[]): string {
  if (flows.length === 0) return 'Nothing saved yet';

  const steps = flows.reduce((total, flow) => total + flow.stepCount, 0);
  return `${flows.length} ${flows.length === 1 ? 'flow' : 'flows'} · ${steps} ${steps === 1 ? 'step' : 'steps'}`;
}

export function deriveLibraryView(input: LibraryInput): LibraryView {
  const { flows, query, sort, now, usedBytes } = input;

  if (flows === null || input.current === null) {
    return {
      body: 'loading',
      summary: '',
      current: null,
      flows: [],
      storage: null,
      searchable: false,
    };
  }

  const current = currentView(input);
  const visible = flows.filter((flow) => matches(flow, query)).sort(SORTS[sort]);

  // An unsaved recording is something to show, so the page is only truly empty
  // when there is neither a library nor a recording waiting in it.
  const body: LibraryBody =
    flows.length === 0 && current === null
      ? 'empty'
      : visible.length === 0 && flows.length > 0
        ? 'no-matches'
        : 'list';

  return {
    body,
    summary: summaryLine(flows),
    current,
    flows: visible.map((flow) => rowView(flow, now)),
    storage: storageView(usedBytes),
    searchable: flows.length > 0,
  };
}
