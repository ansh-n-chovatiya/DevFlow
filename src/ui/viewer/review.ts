/**
 * The review screen: read back what was recorded, correct it, hand it to an AI.
 *
 * The composition is ported from the design system's review frame — rail with
 * elapsed times and error marks, cards that lead with the human-readable action,
 * replay data behind disclosures. Every decision about *what* to show is in
 * review-view.ts; this file knows how to put it on screen and how to turn an
 * edit into a write.
 */

import { compactBody } from '../../core/schema/index.js';
import { statusClass, withImportedScreenshot } from '../../core/flow/index.js';
import { ACCEPT, firstImage, importScreenshot } from '../../features/screenshots/import.js';
import { getLocal } from '../../chrome/storage.js';
import { deleteFlow, renameFlow } from '../../features/flows/store.js';
import { sendToWorker } from '../../shared/messages.js';
import type { ConsoleEntry, NetworkCall, Step } from '../../shared/types.js';
import { hydrateIcons } from '../icons.js';
import { showToast } from '../toast.js';
import type { App, UndoEntry } from './app.js';
import { openAnnotate } from './annotate.js';
import { load as loadSettings } from '../../features/settings/index.js';
import { confirm } from './dialogs.js';
import { clone, el, find, show } from './dom.js';
import { openExport } from './export-dialog.js';
import { openSend } from './send-dialog.js';
import { deriveReviewView, firstVisibleIndex, type StepCardView, type StepFilter } from './review-view.js';
import { LIBRARY } from './route.js';

const dom = {
  view: el('v-review'),

  back: el<HTMLButtonElement>('rv-back'),
  name: el('rv-name'),
  rename: el<HTMLButtonElement>('rv-rename'),
  live: el('rv-live'),
  meta: el('rv-meta'),

  shortcuts: el<HTMLButtonElement>('rv-shortcuts'),
  shortcutsDialog: el<HTMLDialogElement>('shortcuts-dialog'),
  exportButton: el<HTMLButtonElement>('rv-export'),
  send: el<HTMLButtonElement>('rv-send'),
  more: el<HTMLButtonElement>('rv-more'),
  menu: el('rv-menu'),
  save: el<HTMLButtonElement>('rv-save'),
  delete: el<HTMLButtonElement>('rv-delete'),

  rail: el('rv-rail'),
  railCount: el('rail-count'),
  railList: el<HTMLOListElement>('rail-list'),
  railFilters: el('rail-filters'),

  loading: el('rv-loading'),
  list: el('rv-list'),
  empty: el('rv-empty'),
  nomatch: el('rv-nomatch'),
  nomatchBody: el('rv-nomatch-body'),
  clearFilter: el<HTMLButtonElement>('rv-clear-filter'),
  missing: el('rv-missing'),

  shotFile: el<HTMLInputElement>('shot-file'),

  zoomDialog: el<HTMLDialogElement>('zoom-dialog'),
  zoomImage: el<HTMLImageElement>('zoom-image'),
  zoomClose: el<HTMLButtonElement>('zoom-close'),
};

/** Middle-truncated, so a long path keeps both its host and its last segment. */
function middleTruncate(text: string, max = 90): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max - 1) / 2);
  return `${text.slice(0, head)}…${text.slice(text.length - (max - head - 1))}`;
}

function shortPath(url: string): string {
  try {
    const parsed = new URL(url);
    return middleTruncate(parsed.pathname + parsed.search, 70);
  } catch {
    return middleTruncate(url, 70);
  }
}

async function copy(text: string, what: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast({ message: `${what} copied.`, tone: 'success', durationMs: 2500 });
  } catch {
    // Chrome refuses the clipboard when the document is not focused, which is
    // not something the user did wrong and not something to fail silently over.
    showToast({ message: `Chrome wouldn’t copy that. Select it and press Ctrl+C.`, tone: 'danger' });
  }
}

/**
 * Hands an editor link to the worker, which is the only context that can open
 * one — an extension page cannot navigate itself to a custom scheme.
 *
 * A silent failure here would look exactly like an editor that is not
 * installed, so both the refusal and the missing-worker case say something.
 */
async function openInEditor(url: string): Promise<void> {
  const response = await sendToWorker({ type: 'OPEN_EDITOR', url });

  if (response?.ok) return;
  showToast({
    message: response?.error ?? 'Chrome wouldn’t open that link.',
    tone: 'danger',
  });
}

export function mountReview(app: App, onSaveCurrent: () => void): { paint: () => void } {
  // ── App bar ────────────────────────────────────────────────────────────

  dom.back.addEventListener('click', () => app.navigate(LIBRARY));
  for (const button of document.querySelectorAll<HTMLButtonElement>('[data-back]')) {
    button.addEventListener('click', () => app.navigate(LIBRARY));
  }

  dom.shortcuts.addEventListener('click', () => dom.shortcutsDialog.showModal());

  dom.exportButton.addEventListener('click', () => {
    const { flow } = app.state;
    if (flow) {
      openExport({
        steps: flow.steps,
        title: flow.name,
        react: flow.react,
        settings: flow.settings,
      });
    }
  });

  // The dialog does the sending, so what the flow costs is on screen before it
  // is spent rather than after.
  dom.send.addEventListener('click', () => {
    const { flow } = app.state;
    if (!flow) return;

    void (async () => {
      /*
       * The live recording is sent under the id auto-export already gave it.
       *
       * With auto-send on, stopping a recording POSTs it as `flow-<ms>` with
       * everything included. Pressing Send then minted a *second* id and sent
       * the same recording again, pruned to the dialog's defaults — so the
       * server held two near-identical flows whose `errorCount` contradicted
       * each other, one saying two steps failed and the other saying none, with
       * nothing to say which was authoritative. Reusing the id makes the second
       * send an update of the first.
       */
      let id = flow.id ?? undefined;
      if (flow.id === null) {
        const stored = await getLocal('lastMcpFlowId');
        if (stored.ok && stored.value.lastMcpFlowId) id = stored.value.lastMcpFlowId;
      }

      openSend({
        steps: flow.steps,
        name: flow.name,
        id,
        // The live recording's table is re-read at send time, after the last
        // resolve pass; an archived one is already frozen, so it travels here.
        react: flow.id === null ? undefined : flow.react,
        // So a flow recorded last week is not filed under today.
        recordedAt: flow.createdAt,
        // The same split as `react`: an archived flow's stamp travels here; the
        // live recording's is still in storage and is read at send time.
        settings: flow.settings,
      });
    })();
  });

  dom.more.addEventListener('click', () => {
    const open = dom.menu.classList.contains('hidden');
    show(dom.menu, open);
    dom.more.setAttribute('aria-expanded', String(open));
  });

  document.addEventListener('click', (event) => {
    if (!(event.target as Element).closest('.menu')) closeMenu();
  });

  function closeMenu(): void {
    show(dom.menu, false);
    dom.more.setAttribute('aria-expanded', 'false');
  }

  dom.save.addEventListener('click', () => {
    closeMenu();
    onSaveCurrent();
  });

  dom.delete.addEventListener('click', () => {
    closeMenu();
    void removeFlow();
  });

  dom.rename.addEventListener('click', () => startRename());

  async function removeFlow(): Promise<void> {
    const { flow } = app.state;
    if (!flow?.id) return;

    const agreed = await confirm({
      title: `Delete “${flow.name}”?`,
      body: `Its ${flow.steps.length} ${flow.steps.length === 1 ? 'step' : 'steps'} and screenshots will be removed from this device.`,
      confirmLabel: 'Delete flow',
    });
    if (!agreed) return;

    const removed = await deleteFlow(flow.id);
    if (!removed.ok) {
      showToast({ message: removed.error.message, tone: 'danger' });
      return;
    }

    app.navigate(LIBRARY);
    showToast({ message: `Deleted “${flow.name}”.` });
  }

  /** The flow name, edited where it sits rather than in a dialog. */
  function startRename(): void {
    const { flow } = app.state;
    if (!flow?.id) return;

    const input = document.createElement('input');
    input.className = 'flowhead__input';
    input.value = flow.name;
    dom.name.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;

      const name = input.value.trim();
      input.replaceWith(dom.name);

      if (!commit || !name || name === flow.name) return;

      flow.name = name;
      dom.name.textContent = name;
      void renameFlow(flow.id as string, name).then((written) => {
        if (!written.ok) showToast({ message: written.error.message, tone: 'danger' });
        else void app.reload();
      });
    };

    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
  }

  /**
   * Change which steps are listed, from a chip, from Escape, or from the
   * empty state's way out.
   *
   * The scroll is the point of having it in one place. A filter that removes
   * steps makes the page shorter, and the browser answers by clamping the
   * scroll position — which lands you somewhere arbitrary in a list you have
   * just changed. Going back to the top is the same movement made deliberately,
   * and to somewhere that means something: the first step that matched.
   */
  function setFilter(id: StepFilter): void {
    if (app.state.filter === id) return;

    app.state.filter = id;
    // The active step is what Delete and `e` act on, and it is an index into the
    // *whole* list. Leaving it pointing at a step the new filter hides meant
    // pressing Delete removed something that was not on screen — with nothing
    // highlighted to say what was about to go — and the toast then named a step
    // the user could not see. Re-seated rather than merely cleared, so the
    // highlight always sits on a card the user can actually see.
    const { flow } = app.state;
    app.state.activeIndex = flow ? firstVisibleIndex(flow.steps, id) : null;
    app.paint();
    window.scrollTo({ top: 0 });
  }

  // ── Replacing a screenshot ─────────────────────────────────────────────

  /**
   * Which step the file picker is filling in.
   *
   * The picker is one element for the whole screen — thirty cards carrying
   * thirty inputs is thirty file dialogs to keep straight — so the card that
   * opened it is remembered here and read back in the `change` handler.
   */
  let pickingFor: number | null = null;

  /**
   * Put a user-supplied image on a step.
   *
   * The old step is captured before the write and offered back through the
   * toast: replacing a screenshot destroys the captured one, and an action that
   * destroys evidence with no way back is one people are right to hesitate over.
   */
  async function useImage(index: number, file: File): Promise<void> {
    const { flow } = app.state;
    const before = flow?.steps[index];
    if (!flow || !before) return;

    // The live quality: importing is something the user is doing now, to a
    // recording that is already made. See `importScreenshot`.
    const imported = await importScreenshot(file, (await loadSettings())['screenshots.quality']);
    if (!imported.ok) {
      showToast({ message: imported.error.message, tone: 'danger', durationMs: 6000 });
      return;
    }

    let replaced: Step | null = null;
    await editSteps((steps) => {
      replaced = withImportedScreenshot(steps[index], imported.value);
      steps[index] = replaced;
      return steps;
    });

    showToast({
      message: `Screenshot replaced on step ${index + 1}.`,
      tone: 'success',
      undo: () => {
        void editSteps((steps) => {
          // Found by identity, not by the position the step held when it was
          // replaced. The toast lives for six seconds, and a deletion in that
          // window shifts every later step down — so writing the old step back
          // to its old index overwrote a different step and lost it outright.
          const at = replaced ? steps.indexOf(replaced) : -1;
          if (at !== -1) steps[at] = before;
          return steps;
        });
      },
    });
  }

  /** Open the picker on behalf of one step. */
  function pickImage(index: number): void {
    pickingFor = index;
    // Set from the constant rather than trusted from the markup, so the picker
    // and `validateImageFile` cannot drift into disagreeing about what is
    // allowed.
    dom.shotFile.accept = ACCEPT;
    // Cleared first so choosing the same file twice in a row still fires
    // `change` — otherwise a failed import cannot be retried with the same file.
    dom.shotFile.value = '';
    dom.shotFile.click();
  }

  dom.shotFile.addEventListener('change', () => {
    const index = pickingFor;
    const file = dom.shotFile.files?.[0];
    pickingFor = null;
    if (index !== null && file) void useImage(index, file);
  });

  /**
   * Drag a file onto a card, or paste one into it.
   *
   * Both are wired per card rather than on the document: the target has to be
   * the step the image belongs to, and a page-level handler would have to guess
   * which one that is.
   */
  function acceptDrops(target: HTMLElement, index: number): void {
    const mark = (dropping: boolean): void => {
      target.dataset.dropping = String(dropping);
    };

    target.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types.includes('Files')) return;
      // Without this the browser navigates to the dropped file.
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      mark(true);
    });

    target.addEventListener('dragleave', () => mark(false));

    target.addEventListener('drop', (event) => {
      event.preventDefault();
      mark(false);

      const files = [...(event.dataTransfer?.files ?? [])];
      const image = firstImage(files) as File | null;

      if (!image) {
        showToast({ message: 'Drop an image file to use it as this screenshot.' });
        return;
      }
      void useImage(index, image);
    });
  }

  /**
   * Paste an image onto the focused card.
   *
   * The reason this feature exists is someone taking a screenshot by hand, and
   * the system shortcut for that puts the image on the clipboard — so making
   * them save it to disk first, then find it in a picker, would be asking them
   * to put it down and pick it up again.
   */
  function acceptPaste(card: HTMLElement, index: number): void {
    card.addEventListener('paste', (event) => {
      const files = [...(event.clipboardData?.files ?? [])];
      const image = firstImage(files) as File | null;
      if (!image) return;

      // Only now, so pasting text into the notes field is left alone.
      event.preventDefault();
      void useImage(index, image);
    });
  }

  // ── Steps ──────────────────────────────────────────────────────────────

  function setActive(index: number | null): void {
    app.state.activeIndex = index;
    // Moving the highlight is not a reason to rebuild thirty cards and re-decode
    // their screenshots, which is visible as a flash on a long flow.
    markActive();

    if (index === null) return;
    document
      .querySelector(`.step[data-index="${index}"]`)
      ?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  /**
   * `repaint` is false for an edit that changes one card's own text — the DOM is
   * already correct, and rebuilding the list under a textarea the user has just
   * left would throw away the scroll position for nothing.
   */
  async function editSteps(mutate: (steps: Step[]) => Step[], repaint = true): Promise<void> {
    const { flow } = app.state;
    if (!flow) return;

    flow.steps = mutate(flow.steps.slice());
    if (repaint) app.paint();
    await app.commit(flow.steps);
  }

  function deleteStep(index: number): void {
    const { flow } = app.state;
    const step = flow?.steps[index];
    if (!flow || !step) return;

    // The step that followed this one is remembered so the undo can find its
    // place again. The bare index is the position at deletion time, and any
    // deletion at a lower index since then has moved it.
    const entry = { index, step, before: flow.steps[index + 1] ?? null };
    app.state.undo.push(entry);

    void editSteps((steps) => {
      steps.splice(index, 1);
      return steps;
    });

    showToast({
      message: `Step ${index + 1} deleted.`,
      // This toast's own deletion, not whichever was most recent: deleting two
      // steps and undoing the older toast must not restore the newer step.
      undo: () => undoDelete(entry),
    });
  }

  function undoDelete(entry?: UndoEntry): void {
    const { undo } = app.state;
    const target = entry ?? undo[undo.length - 1];
    if (!target) return;

    const at = undo.indexOf(target);
    if (at === -1) return;
    undo.splice(at, 1);

    void editSteps((steps) => {
      // Re-anchored on the step this one used to sit in front of. Splicing at
      // the remembered index put a step back in the wrong place as soon as an
      // earlier step had been deleted too — undoing the older of two deletions
      // reordered the flow, and the export then renumbered that wrong order into
      // "step 5 is the thing that happened last".
      const anchor = target.before ? steps.indexOf(target.before) : -1;
      const where = anchor !== -1 ? anchor : Math.min(target.index, steps.length);
      steps.splice(where, 0, target.step);
      return steps;
    });
  }

  function buildDetailBody(container: HTMLElement, build: () => void): void {
    // Built on first open. Thirty steps' worth of request panels rendered up
    // front is what made the old viewer slow to show anything at all.
    let built = false;
    const details = container.closest('details');
    details?.addEventListener('toggle', () => {
      if (!details.open || built) return;
      built = true;
      build();
    });
  }

  function buildBodyPanel(
    headers: Record<string, string>,
    body: string | null,
    meta?: { truncated?: boolean; bytes?: number },
  ): HTMLElement {
    const panel = document.createElement('div');
    panel.className = 'call__panel';

    const entries = Object.entries(headers ?? {});
    if (entries.length === 0 && !body) {
      const empty = document.createElement('p');
      empty.className = 'meta';
      empty.textContent = 'Nothing captured.';
      panel.append(empty);
      return panel;
    }

    if (entries.length > 0) {
      const label = document.createElement('p');
      label.className = 'label';
      label.textContent = 'Headers';

      const grid = document.createElement('div');
      grid.className = 'headers';
      for (const [key, value] of entries) {
        const keyCell = document.createElement('span');
        keyCell.className = 'headers__key';
        keyCell.textContent = key;

        const valueCell = document.createElement('span');
        valueCell.className = 'headers__value';
        valueCell.textContent = value;

        grid.append(keyCell, valueCell);
      }

      panel.append(label, grid);
    }

    if (body) {
      const label = document.createElement('p');
      label.className = 'label';
      label.textContent = 'Body';

      const compact = compactBody(body, meta) ?? body;
      const pre = document.createElement('pre');
      pre.className = 'body';
      pre.textContent = compact;

      panel.append(label);

      // A compacted body is an inferred schema, not the payload. Saying which
      // one is on screen matters when the answer decides whether a bug is real.
      if (compact !== body) {
        const toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'btn btn--ghost btn--compact';
        toggle.textContent = 'Show raw';

        let raw = false;
        toggle.addEventListener('click', () => {
          raw = !raw;
          pre.textContent = raw ? body : compact;
          toggle.textContent = raw ? 'Show schema' : 'Show raw';
        });

        panel.append(toggle);
      }

      panel.append(pre);
    }

    return panel;
  }

  function buildCall(call: NetworkCall): HTMLElement {
    const node = clone('tpl-call');
    const method = (call.method || 'GET').toUpperCase();
    const band = statusClass(call.status);

    const methodChip = find(node, '.call__method');
    methodChip.dataset.method = method;
    methodChip.textContent = method;

    const url = find(node, '.call__url');
    url.textContent = shortPath(call.url ?? '');
    url.title = call.url ?? '';

    const status = find(node, '.call__status');
    status.dataset.status = band;
    status.textContent = call.status === null ? 'ERR' : String(call.status);

    find(node, '.call__ms').textContent = `${call.durationMs || 0}ms`;

    const panels = find(node, '.call__panels');
    const request = buildBodyPanel(call.requestHeaders, call.requestBody, {
      truncated: call.requestBodyTruncated,
      bytes: call.requestBodyBytes,
    });
    request.dataset.panel = 'request';
    const response = buildBodyPanel(call.responseHeaders, call.responseBody, {
      truncated: call.responseBodyTruncated,
      bytes: call.responseBodyBytes,
    });
    response.dataset.panel = 'response';
    // The response is what someone opened the row to read.
    response.dataset.active = 'true';
    panels.append(request, response);

    const tabs = [...node.querySelectorAll<HTMLButtonElement>('.call__tab')];
    const activate = (which: string): void => {
      for (const tab of tabs) tab.setAttribute('aria-selected', String(tab.dataset.panel === which));
      for (const panel of [request, response]) {
        panel.dataset.active = String(panel.dataset.panel === which);
      }
    };
    activate('response');
    for (const tab of tabs) tab.addEventListener('click', () => activate(tab.dataset.panel ?? ''));

    find(node, '.call__row').addEventListener('click', () => {
      const open = node.dataset.open !== 'true';
      node.dataset.open = String(open);
      show(panels, open);
    });

    hydrateIcons(node);
    return node;
  }

  function buildLog(entry: ConsoleEntry): HTMLElement {
    const node = clone('tpl-log');
    node.dataset.level = entry.level;

    const level = find(node, '.log__level');
    level.dataset.level = entry.level;
    level.textContent = entry.level;

    find(node, '.log__text').textContent = entry.args.join(' ');
    find(node, '.log__time').textContent = entry.timestamp
      ? new Date(entry.timestamp).toLocaleTimeString()
      : '';

    return node;
  }

  function buildCard(card: StepCardView, step: Step): HTMLElement {
    const node = clone('tpl-step');
    node.dataset.index = String(card.index);
    node.dataset.failed = String(card.failed);
    node.dataset.active = String(card.active);

    find(node, '.step__num').textContent = String(card.number);

    const type = find(node, '.step__type');
    type.dataset.step = card.type;
    type.textContent = card.type;

    const action = find(node, '.step__action');
    action.textContent = card.action;
    action.title = 'Click to edit';
    action.addEventListener('click', () => startTitleEdit(action, card.index, card.action));

    const delta = find(node, '.step__delta');
    if (card.delta) delta.textContent = card.delta;
    else delta.remove();

    const title = find(node, '.step__title');
    if (card.title) title.textContent = card.title;
    else title.remove();

    // ── URL ────────────────────────────────────────────────────────────
    const urlRow = find(node, '.step__url');
    if (card.urlReason === null) {
      urlRow.remove();
    } else {
      find(urlRow, '.step__url-label').textContent =
        card.urlReason === 'started' ? 'Started at' : 'Page changed';
      const text = find(urlRow, '.step__url-text');
      text.textContent = middleTruncate(card.url);
      text.title = card.url;
      find(urlRow, '[data-action="copy-url"]').addEventListener('click', () => {
        void copy(card.url, 'URL');
      });
    }

    const value = find(node, '.step__value');
    if (card.value) find(value, '.step__value-text').textContent = card.value;
    else value.remove();

    // ── Component ──────────────────────────────────────────────────────
    const react = find(node, '.step__react');
    if (card.component) {
      // `Button · in CheckoutButton` — the same wording the Markdown uses, so
      // the card and the export never read as two different claims.
      find(react, '.step__react-name').textContent = card.component.within
        ? `${card.component.name} · in ${card.component.within}`
        : card.component.name;
      const tag = find(react, '.step__react-tag');
      if (card.component.dependency) tag.textContent = 'dependency';
      else tag.remove();
    } else {
      react.remove();
    }

    // ── Screenshot ─────────────────────────────────────────────────────
    const shot = find(node, '.shot');
    const empty = find(node, '.shot-empty');

    // Exactly one of the two: the picture, or the offer of one.
    if (card.screenshot) {
      empty.remove();

      const image = find<HTMLImageElement>(shot, '.shot__image');
      image.src = card.screenshot;
      image.alt = card.screenshotImported
        ? `Screenshot added by hand for step ${card.number}`
        : `Screenshot for step ${card.number}`;

      // Present or absent, never hidden — a chip that says nothing is a chip
      // that should not be in the DOM.
      if (!card.screenshotImported) find(shot, '.shot__badge').remove();

      find(shot, '[data-action="zoom"]').addEventListener('click', () => {
        dom.zoomImage.src = card.screenshot as string;
        dom.zoomImage.alt = image.alt;
        dom.zoomDialog.showModal();
      });

      acceptDrops(shot, card.index);
    } else {
      shot.remove();
      // The reason, before the offer. A user looking at a flow with no pictures
      // is asking "is this broken?", and the answer is one sentence the
      // recorder already wrote down.
      if (card.screenshotOmitted) {
        find(empty, '.shot-empty__body').textContent =
          `${card.screenshotOmitted} Drop an image here, paste one, or click to choose a file.`;
      }
      empty.addEventListener('click', () => pickImage(card.index));
      acceptDrops(empty, card.index);
    }

    // Wired whether or not there is a picture yet — a step that never got one
    // is the main reason this exists.
    acceptPaste(node, card.index);

    find(node, '[data-action="replace-shot"]').addEventListener('click', () =>
      pickImage(card.index),
    );

    const annotate = find(node, '[data-action="annotate"]');
    if (card.screenshot ?? step.screenshotOriginal) {
      annotate.addEventListener('click', () => {
        openAnnotate({
          step,
          number: card.number,
          onSave: (screenshot) => {
            void editSteps((steps) => {
              const current = steps[card.index];
              steps[card.index] = {
                ...current,
                screenshot,
                // The clean capture is preserved, never replaced. The editor
                // opens on `screenshotOriginal ?? screenshot`, so leaving this
                // as the recorder's untouched frame meant a second editing
                // session started from the *un-redacted* image — and saving it
                // threw away the redaction drawn in the first. A step redacted
                // to hide an email then shipped that email to Claude.
                screenshotOriginal: current.screenshotOriginal ?? current.screenshot ?? null,
              };
              return steps;
            });
          },
        });
      });
    } else {
      annotate.remove();
    }

    find(node, '[data-action="delete"]').addEventListener('click', () => deleteStep(card.index));

    // ── Selectors ──────────────────────────────────────────────────────
    const selectors = find(node, '.detail--selectors');
    if (card.selectors) {
      const { css, xpath } = card.selectors;
      const [cssRow, xpathRow] = [...selectors.querySelectorAll<HTMLElement>('.selector')];

      find(cssRow, '.selector__value').textContent = css;
      find(cssRow, '[data-action="copy-css"]').addEventListener('click', () => {
        void copy(css, 'CSS selector');
      });

      const xpathValue = find(xpathRow, '.selector__value');
      xpathValue.textContent = xpath;
      // Clamped to two lines, expandable in place. In the build being replaced
      // this ran to three lines and was the largest thing on the card.
      xpathValue.addEventListener('click', () => {
        xpathValue.dataset.expanded = xpathValue.dataset.expanded === 'true' ? 'false' : 'true';
      });
      find(xpathRow, '[data-action="copy-xpath"]').addEventListener('click', () => {
        void copy(xpath, 'XPath');
      });
    } else {
      selectors.remove();
    }

    // ── Where that component lives ─────────────────────────────────────
    const reactDetail = find(node, '.detail--react');
    if (card.component) {
      const { source, detail: why } = card.component;

      const status = find(reactDetail, '.react__status');
      // The chip states the doubt, so an unresolved component never sits under
      // a heading that implies it has an answer.
      if (why) status.textContent = 'unresolved';
      else status.remove();

      const sourceRow = find(reactDetail, '.selector');
      if (source) {
        find(sourceRow, '.react__source').textContent = source;
        find(sourceRow, '[data-action="copy-source"]').addEventListener('click', () => {
          void copy(source, 'source path');
        });

        // The button is removed rather than disabled: with no project root set
        // there is nothing wrong to fix in the moment, and a permanently greyed
        // control on every step reads as a broken feature.
        const open = find(sourceRow, '[data-action="open-source"]');
        const editorUrl = card.component.editorUrl;
        if (editorUrl) {
          open.addEventListener('click', () => void openInEditor(editorUrl));
        } else {
          open.remove();
        }
      } else {
        sourceRow.remove();
      }

      const reason = find(reactDetail, '.react__detail');
      if (why) reason.textContent = why;
      else reason.remove();
    } else {
      reactDetail.remove();
    }

    // ── Network and console ────────────────────────────────────────────
    const network = find(node, '.detail--network');
    if (card.network) {
      find(network, '.detail__count').textContent = String(card.network.count);
      const worst = find(network, '.detail__worst');
      if (card.network.worst && card.network.worst !== '2xx') {
        worst.dataset.status = card.network.worst;
        worst.textContent = card.network.worst;
      } else {
        worst.remove();
      }

      const body = find(network, '.detail__body');
      buildDetailBody(body, () => {
        body.append(...(step.networkCalls ?? []).map(buildCall));
      });
    } else {
      network.remove();
    }

    const console_ = find(node, '.detail--console');
    if (card.console) {
      find(console_, '.detail__count').textContent = String(card.console.count);
      const worst = find(console_, '.detail__worst');
      if (card.console.worst === 'error' || card.console.worst === 'warn') {
        worst.dataset.level = card.console.worst;
        worst.textContent = card.console.worst;
      } else {
        worst.remove();
      }

      const body = find(console_, '.detail__body');
      buildDetailBody(body, () => {
        body.append(...(step.consoleLogs ?? []).map(buildLog));
      });
    } else {
      console_.remove();
    }

    // ── Notes ──────────────────────────────────────────────────────────
    const notes = find<HTMLTextAreaElement>(node, '.step__notes');
    notes.value = card.notes;
    notes.addEventListener('blur', () => {
      // Compared against what is stored right now, not against `card`. These
      // edits pass `repaint: false`, so `card` is the view model from the last
      // full paint and never catches up — a second edit that returned the field
      // to the value it had at paint time was read as "nothing changed" and
      // silently dropped. Clearing a note containing a card number left the
      // textarea empty on screen while storage, every export and every send
      // still carried it.
      const stored = app.state.flow?.steps[card.index]?.notes ?? '';
      if (notes.value === stored) return;
      void editSteps((steps) => {
        steps[card.index] = { ...steps[card.index], notes: notes.value };
        return steps;
      }, false);
    });

    node.addEventListener('focusin', () => {
      app.state.activeIndex = card.index;
      markActive();
    });

    hydrateIcons(node);
    return node;
  }

  function startTitleEdit(action: HTMLElement, index: number, fallback: string): void {
    const input = document.createElement('input');
    input.className = 'step__action-input';
    // Seeded from the live step, not from the caller's paint-time copy — which
    // after a rename is the title the user has already replaced.
    const current = app.state.flow?.steps[index]?.action ?? fallback;
    input.value = current;
    action.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    const finish = (commit: boolean): void => {
      if (done) return;
      done = true;

      const next = input.value.trim();
      input.replaceWith(action);

      // Against the stored action, for the same reason as the note above: after
      // a rename the caller still passes the title from the last paint, so
      // re-opening the editor seeded it with the *old* text and a small
      // correction typed there silently reverted the rename.
      const stored = app.state.flow?.steps[index]?.action ?? current;
      if (!commit || !next || next === stored) return;
      action.textContent = next;
      void editSteps((steps) => {
        steps[index] = { ...steps[index], action: next };
        return steps;
      }, false);
    };

    input.addEventListener('blur', () => finish(true));
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        input.blur();
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        finish(false);
      }
    });
  }

  /** Move the highlight without rebuilding thirty cards and their images. */
  function markActive(): void {
    const { activeIndex } = app.state;

    for (const card of document.querySelectorAll<HTMLElement>('.step[data-index]')) {
      card.dataset.active = String(Number(card.dataset.index) === activeIndex);
    }
    for (const row of dom.railList.querySelectorAll<HTMLElement>('.rail-row')) {
      row.dataset.active = String(Number(row.dataset.index) === activeIndex);
    }
  }

  // ── Keyboard ───────────────────────────────────────────────────────────

  document.addEventListener('keydown', (event) => {
    if (app.state.route.view !== 'review') return;

    // A modal owns the keyboard while it is open. Without this, J and K move the
    // selection on the page behind the annotation editor, and Escape clears the
    // filter on the way out of a dialog.
    if (document.querySelector('dialog[open]')) return;

    const target = event.target as HTMLElement;
    const typing =
      target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !typing) {
      event.preventDefault();
      undoDelete();
      return;
    }

    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'e') {
      event.preventDefault();
      const { flow } = app.state;
      if (flow) {
      openExport({
        steps: flow.steps,
        title: flow.name,
        react: flow.react,
        settings: flow.settings,
      });
    }
      return;
    }

    if (typing || event.ctrlKey || event.metaKey || event.altKey) return;

    const shown = [...document.querySelectorAll<HTMLElement>('.step[data-index]')].map((card) =>
      Number(card.dataset.index),
    );
    const at = app.state.activeIndex === null ? -1 : shown.indexOf(app.state.activeIndex);

    if (event.key === 'j' || event.key === 'J') {
      event.preventDefault();
      setActive(shown[Math.min(at + 1, shown.length - 1)] ?? null);
      return;
    }

    if (event.key === 'k' || event.key === 'K') {
      event.preventDefault();
      setActive(shown[Math.max(at - 1, 0)] ?? null);
      return;
    }

    // Delete, never Backspace — Backspace is muscle memory for "back".
    if (event.key === 'Delete' && app.state.activeIndex !== null) {
      event.preventDefault();
      deleteStep(app.state.activeIndex);
      return;
    }

    if ((event.key === 'e' || event.key === 'E') && app.state.activeIndex !== null) {
      event.preventDefault();
      document
        .querySelector<HTMLButtonElement>(
          `.step[data-index="${app.state.activeIndex}"] [data-action="annotate"]`,
        )
        ?.click();
      return;
    }

    if (event.key === 'Escape' && app.state.filter !== 'all') setFilter('all');
  });

  dom.zoomClose.addEventListener('click', () => dom.zoomDialog.close());
  dom.clearFilter.addEventListener('click', () => setFilter('all'));

  // ── Painting ───────────────────────────────────────────────────────────

  function paint(): void {
    const view = deriveReviewView({
      flow: app.state.flow,
      missing: app.state.missing,
      filter: app.state.filter,
      activeIndex: app.state.activeIndex,
      recording: app.state.current?.recording ?? 'idle',
      now: Date.now(),
      editor: app.state.editor,
    });

    if (view.header) {
      dom.name.textContent = view.header.name;
      show(dom.rename, view.header.renameable);

      const parts = [`${view.header.stepCount} ${view.header.stepCount === 1 ? 'step' : 'steps'}`];
      if (view.header.host) parts.push(view.header.host);
      if (view.header.when) parts.push(view.header.when);
      if (view.header.components) parts.push(view.header.components);
      dom.meta.textContent = parts.join(' · ');
    } else {
      dom.name.textContent = '';
      dom.meta.textContent = '';
      show(dom.rename, false);
    }

    show(dom.live, view.live);

    dom.exportButton.disabled = !view.canExport;
    dom.send.disabled = !view.canExport;
    dom.save.disabled = !view.canSave;
    dom.delete.disabled = !view.canDelete;

    show(dom.loading, view.body === 'loading');
    show(dom.list, view.body === 'steps');
    show(dom.empty, view.body === 'empty');
    show(dom.nomatch, view.body === 'no-matches');
    show(dom.missing, view.body === 'missing');
    show(dom.rail, view.body === 'steps' || view.body === 'no-matches');

    dom.railCount.textContent = view.header ? `(${view.header.stepCount})` : '';

    // ── Filters ────────────────────────────────────────────────────────
    dom.railFilters.replaceChildren(
      ...view.filters.map((chip) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'filter';
        button.dataset.filter = chip.id;
        button.setAttribute('aria-pressed', String(chip.active));
        button.disabled = chip.disabled;
        button.textContent = chip.count > 0 ? `${chip.label} ${chip.count}` : chip.label;
        button.addEventListener('click', () => setFilter(chip.id));
        return button;
      }),
    );

    if (view.body === 'no-matches') {
      const label = view.filters.find((chip) => chip.active)?.label ?? '';
      dom.nomatchBody.textContent = `Nothing in this flow matches “${label}”.`;
    }

    // ── Rail ───────────────────────────────────────────────────────────
    dom.railList.replaceChildren(
      ...view.rail.map((row) => {
        const node = clone('tpl-rail-row');
        node.dataset.index = String(row.index);
        node.dataset.type = row.type;
        node.dataset.active = String(row.active);

        find(node, '.rail-row__num').textContent = String(row.number);
        find(node, '.rail-row__icon').dataset.icon = row.icon;
        find(node, '.rail-row__label').textContent = row.label;
        find(node, '.rail-row__delta').textContent = row.delta ?? '';

        const fail = find(node, '.rail-row__fail');
        if (!row.failed) fail.remove();

        const button = find(node, '.rail-row__button');
        button.setAttribute('title', row.label);
        button.addEventListener('click', () => setActive(row.index));

        hydrateIcons(node);
        return node;
      }),
    );

    // ── Cards ──────────────────────────────────────────────────────────
    const steps = app.state.flow?.steps ?? [];
    dom.list.replaceChildren(...view.steps.map((card) => buildCard(card, steps[card.index])));
  }

  return { paint };
}

export function showReview(visible: boolean): void {
  show(dom.view, visible);
}
