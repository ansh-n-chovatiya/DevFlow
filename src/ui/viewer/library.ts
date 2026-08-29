/**
 * The library: choose a flow, or manage what is stored.
 *
 * It renders `deriveLibraryView` and nothing else. Every question about which
 * state the page is in — loading, empty, filtered to nothing, a recording still
 * running — is answered in library-view.ts and tested there.
 */

import { deleteFlow, readFlow, restoreFlow } from '../../features/flows/store.js';
import { formatBytes } from '../format.js';
import { hydrateIcons } from '../icons.js';
import { showToast } from '../toast.js';
import type { App } from './app.js';
import { confirm } from './dialogs.js';
import { clone, el, find, show } from './dom.js';
import { deriveLibraryView, type FlowRowView, type LibrarySort } from './library-view.js';
import { openExport } from './export-dialog.js';

const dom = {
  view: el('v-library'),
  summary: el('lib-summary'),
  tools: el('lib-tools'),
  search: el<HTMLInputElement>('lib-search'),
  sorts: [...document.querySelectorAll<HTMLButtonElement>('[data-sort]')],

  current: el('lib-current'),
  currentDot: el('current-dot'),
  currentStatus: el('current-status-text'),
  currentErrors: el('current-errors'),
  currentMeta: el('current-meta'),
  currentThumbs: el('current-thumbs'),
  currentOpen: el<HTMLButtonElement>('current-open'),
  currentSave: el<HTMLButtonElement>('current-save'),

  loading: el('lib-loading'),
  list: el<HTMLUListElement>('lib-list'),
  empty: el('lib-empty'),
  nomatch: el('lib-nomatch'),
  nomatchQuery: el('lib-nomatch-query'),
  clearSearch: el<HTMLButtonElement>('lib-clear-search'),

  footer: el('lib-footer'),
  storageText: el('lib-storage-text'),

  settings: el<HTMLButtonElement>('lib-settings'),
};

const STATUS_TEXT = {
  recording: 'Recording',
  paused: 'Paused',
  unsaved: 'Unsaved',
} as const;

export function mountLibrary(app: App, onSaveCurrent: () => void): { paint: () => void } {
  // ── Wiring ─────────────────────────────────────────────────────────────

  /**
   * Navigated in this tab rather than through `openOptionsPage`, which would
   * open a second one. Both pages are extension pages, so this is an ordinary
   * link — and it gives the settings page's Back button real history to return
   * along, landing the user back on the flow they were looking at.
   */
  dom.settings.addEventListener('click', () => {
    location.href = chrome.runtime.getURL('settings.html');
  });

  dom.search.addEventListener('input', () => {
    app.state.query = dom.search.value;
    app.paint();
  });

  dom.clearSearch.addEventListener('click', () => {
    dom.search.value = '';
    app.state.query = '';
    app.paint();
    dom.search.focus();
  });

  for (const button of dom.sorts) {
    button.addEventListener('click', () => {
      app.state.sort = button.dataset.sort as LibrarySort;
      app.paint();
    });
  }

  dom.currentOpen.addEventListener('click', () => app.navigate({ view: 'review', id: null }));
  dom.currentSave.addEventListener('click', onSaveCurrent);

  // ── Rendering ──────────────────────────────────────────────────────────

  function buildRow(row: FlowRowView): HTMLElement {
    const node = clone('tpl-flow-row');
    node.dataset.id = row.id;

    const image = find<HTMLImageElement>(node, '.flow-row__thumb:not(.flow-row__thumb--blank)');
    const blank = find(node, '.flow-row__thumb--blank');
    if (row.thumbnail) {
      image.src = row.thumbnail;
      blank.remove();
    } else {
      image.remove();
    }

    find(node, '.flow-row__name').textContent = row.name;

    const parts = [`${row.stepCount} ${row.stepCount === 1 ? 'step' : 'steps'}`];
    if (row.host) parts.push(row.host);
    parts.push(row.when);
    if (row.size !== null) parts.push(formatBytes(row.size));
    find(node, '.flow-row__meta').textContent = parts.join(' · ');

    const chips = find(node, '.flow-row__chips');
    for (const entry of row.counts) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.step = entry.type;
      chip.textContent = `${entry.count} ${entry.type}`;
      chips.append(chip);
    }
    if (row.failures > 0) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.dataset.level = 'error';
      chip.textContent = `${row.failures} ${row.failures === 1 ? 'error' : 'errors'}`;
      chips.append(chip);
    }

    find(node, '.flow-row__open').addEventListener('click', () => {
      app.navigate({ view: 'review', id: row.id });
    });

    find(node, '[data-action="export"]').addEventListener('click', () => {
      void exportRow(row);
    });

    find(node, '[data-action="delete"]').addEventListener('click', () => {
      void removeRow(row);
    });

    hydrateIcons(node);
    return node;
  }

  async function exportRow(row: FlowRowView): Promise<void> {
    const flow = await readFlow(row.id);
    if (!flow.ok || !flow.value) {
      showToast({ message: 'That flow could not be read.', tone: 'danger' });
      return;
    }

    openExport({
      steps: flow.value.steps,
      title: flow.value.name,
      react: flow.value.react,
      settings: flow.value.meta?.settings,
    });
  }

  async function removeRow(row: FlowRowView): Promise<void> {
    const agreed = await confirm({
      title: `Delete “${row.name}”?`,
      body: `Its ${row.stepCount} ${row.stepCount === 1 ? 'step' : 'steps'} and screenshots will be removed from this device.`,
      confirmLabel: 'Delete flow',
    });
    if (!agreed) return;

    const removed = await deleteFlow(row.id);
    if (!removed.ok) {
      showToast({ message: removed.error.message, tone: 'danger' });
      return;
    }

    await app.reload();

    // No steps means this row was a ghost: a delete that failed halfway removed
    // them and left the index entry behind, and what has just been swept up is
    // the entry alone. There is nothing to put back, so nothing is offered —
    // an undo that restores an unopenable row is a promise that breaks itself.
    if (removed.value.steps.length === 0) {
      showToast({ message: `Removed “${row.name}”.` });
      return;
    }

    // Undoable rather than merely confirmed: the flow's bytes are already back
    // in the quota, and putting them where they were is a write we can make.
    showToast({
      message: `Deleted “${row.name}”.`,
      undo: () => {
        void (async () => {
          const back = await restoreFlow(removed.value.meta, removed.value.steps, removed.value.react);
          if (!back.ok) {
            showToast({ message: back.error.message, tone: 'danger' });
            return;
          }
          await app.reload();
        })();
      },
    });
  }

  function paint(): void {
    const view = deriveLibraryView({
      flows: app.state.flows,
      current: app.state.current,
      usedBytes: app.state.usedBytes,
      query: app.state.query,
      sort: app.state.sort,
      now: Date.now(),
    });

    dom.summary.textContent = view.summary;
    show(dom.tools, view.searchable);

    for (const button of dom.sorts) {
      button.setAttribute('aria-pressed', String(button.dataset.sort === app.state.sort));
    }

    show(dom.current, view.current !== null);
    if (view.current) {
      const { current } = view;
      dom.currentStatus.textContent = STATUS_TEXT[current.status];
      show(dom.currentDot, current.status !== 'unsaved');
      dom.currentDot.classList.toggle('rec-dot--paused', current.status === 'paused');

      const parts = [`${current.stepCount} ${current.stepCount === 1 ? 'step' : 'steps'}`];
      if (current.host) parts.push(current.host);
      parts.push(current.when);
      dom.currentMeta.textContent = parts.join(' · ');

      show(dom.currentErrors, current.failures > 0);
      dom.currentErrors.textContent = `${current.failures} ${current.failures === 1 ? 'error' : 'errors'}`;

      dom.currentThumbs.replaceChildren();
      for (const src of current.thumbnails) {
        const image = document.createElement('img');
        image.className = 'thumbs__item';
        image.src = src;
        image.alt = '';
        dom.currentThumbs.append(image);
      }
      if (current.extra > 0) {
        const chip = document.createElement('span');
        chip.className = 'chip chip--count';
        chip.textContent = `+${current.extra}`;
        dom.currentThumbs.append(chip);
      }

      // A recording still running has nothing final to archive.
      dom.currentSave.disabled = current.status !== 'unsaved';
    }

    show(dom.loading, view.body === 'loading');
    show(dom.list, view.body === 'list');
    show(dom.empty, view.body === 'empty');
    show(dom.nomatch, view.body === 'no-matches');
    dom.nomatchQuery.textContent = app.state.query.trim();

    if (view.body === 'list') {
      dom.list.replaceChildren(...view.flows.map(buildRow));
    }

    show(dom.footer, view.storage !== null);
    if (view.storage) {
      dom.storageText.textContent = `${formatBytes(view.storage.usedBytes)} stored`;
    }
  }

  return { paint };
}

export function showLibrary(visible: boolean): void {
  show(dom.view, visible);
}
