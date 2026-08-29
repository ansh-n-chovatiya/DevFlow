/**
 * The state the viewer's two views share, and what they may ask of each other.
 *
 * An interface rather than a module of mutable exports: `main.ts` owns the
 * state and implements this, the view controllers receive it. That is the seam
 * that keeps `library.ts` from reaching into the review screen's step list, and
 * it is what the old 1,500-line viewer had none of.
 */

import type { EditorLink } from '../../core/react/editor.js';
import type { FlowMeta, RecordingState, Step } from '../../shared/types.js';
import type { LibrarySort } from './library-view.js';
import type { ReviewFlow, StepFilter } from './review-view.js';
import type { Route } from './route.js';

/**
 * A deletion that can still be taken back.
 *
 * `before` is the step this one sat in front of, and is what the undo re-anchors
 * on: `index` alone is the position at deletion time, which a later deletion at
 * a lower index silently invalidates.
 */
export interface UndoEntry {
  index: number;
  step: Step;
  before: Step | null;
}

export interface ViewerState {
  route: Route;

  /** The library index. `null` until it has been read. */
  flows: FlowMeta[] | null;
  /** The recording in progress. `null` until it has been read. */
  current: { steps: Step[]; recording: RecordingState } | null;
  usedBytes: number | null;

  query: string;
  sort: LibrarySort;

  /** The flow open in the review screen. `null` while it is being read. */
  flow: ReviewFlow | null;
  /** The route named a flow that is not in storage. */
  missing: boolean;
  filter: StepFilter;
  activeIndex: number | null;
  /** Deletions that Ctrl+Z can still take back, oldest first. */
  undo: UndoEntry[];
  /**
   * The settings behind "Open in editor". `null` until they have been read, and
   * whenever there is no project root to resolve a path against.
   */
  editor: EditorLink | null;
}

export interface App {
  readonly state: ViewerState;
  /** Change the route, which reloads whatever the new view needs. */
  navigate(route: Route): void;
  /** Re-derive and repaint from the state as it stands. */
  paint(): void;
  /** Re-read everything the current route needs, then paint. */
  reload(): Promise<void>;
  /** Write the open flow's steps back to wherever they came from. */
  commit(steps: Step[]): Promise<void>;
}
