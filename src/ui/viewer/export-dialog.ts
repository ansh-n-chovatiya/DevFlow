/**
 * One export dialog — structural decision B.
 *
 * It replaces three toolbar buttons that were the same export in three file
 * formats, the include checkboxes that sat on screen permanently although they
 * only mattered here, and a bare filename prompt. The size estimates are the
 * reason it is a dialog rather than a shorter menu: choosing ZIP over Markdown
 * used to be a guess.
 */

import { exportFlow, suggestFilename } from '../../features/export/download.js';
import {
  exportDefaults,
  exportFormat as configuredFormat,
  openingOptions,
} from '../../features/export/defaults.js';
import { load as loadSettings } from '../../features/settings/index.js';
import { getLocal, setLocal } from '../../chrome/storage.js';
import { banner } from '../settings/components.js';
import { flowHost } from '../../core/flow/index.js';
import type { ExportOptions, FlowReact, Overrides, Step } from '../../shared/types.js';
import { formatBytes } from '../format.js';
import { hydrateIcons, setIcon } from '../icons.js';
import { showToast } from '../toast.js';
import { clone, el, find, show } from './dom.js';
import {
  deriveExportView,
  driftFromDefaults,
  type ExportFormat,
  type FormatCard,
  type IncludeRow,
} from './export-view.js';

const dom = {
  dialog: el<HTMLDialogElement>('export-dialog'),
  subtitle: el('export-subtitle'),
  close: el<HTMLButtonElement>('export-close'),
  formats: el('export-formats'),
  includes: el('export-includes'),
  defaults: el('export-defaults'),
  warning: el('export-warning'),
  filename: el<HTMLInputElement>('export-filename'),
  extension: el('export-ext'),
  progress: el('export-progress'),
  progressFill: el('export-progress-fill'),
  caption: el('export-caption'),
  total: el('export-total'),
  cancel: el<HTMLButtonElement>('export-cancel'),
  run: el<HTMLButtonElement>('export-run'),
  runIcon: el('export-run-icon'),
  runLabel: el('export-run-label'),
};

interface Session {
  steps: Step[];
  title: string;
  format: ExportFormat;
  options: ExportOptions;
  filename: string;
  busy: boolean;
  progress: { done: number; total: number } | null;
  /** The component table, so the Markdown and JSON in the archive carry it. */
  react: FlowReact | undefined;
  /** The flow's settings stamp, so both halves of the archive say what was in
   *  force. `undefined` for a flow archived before stamps existed. */
  settings: Overrides | undefined;
  /**
   * What `export.*` says this dialog should open on, read when it opened.
   *
   * Held for the life of the dialog rather than re-read, so the "not your
   * defaults" line beside the switches is measured against the same answer the
   * switches were set from. Re-reading would let the two disagree if Settings
   * were saved in another tab mid-export, which is a banner that contradicts
   * the controls above it.
   */
  configured: ExportOptions;
  configuredFormat: ExportFormat;
}

let session: Session | null = null;

/**
 * `exportOptionsAgainst` — what `export.*` said when this dialog's memory was
 * written.
 *
 * Stored beside the memory rather than inside it, so a memory written by a
 * build before Phase 4 reads as "nothing recorded", which is exactly what it
 * is. See `features/export/defaults.ts` for what the pair is for.
 */
const AGAINST_KEY = 'exportOptionsAgainst';

function paint(): void {
  if (!session) return;

  const view = deriveExportView({
    steps: session.steps,
    format: session.format,
    options: session.options,
    react: session.react,
    filename: session.filename,
    busy: session.busy,
    progress: session.progress,
  });

  const host = flowHost(session.steps);
  dom.subtitle.textContent = [
    `${session.steps.length} ${session.steps.length === 1 ? 'step' : 'steps'}`,
    host,
  ]
    .filter(Boolean)
    .join(' · ');

  dom.formats.replaceChildren(...view.formats.map(buildFormat));
  dom.includes.replaceChildren(...view.includes.map(buildInclude));
  paintDefaults();

  show(dom.warning, view.warnBodies);

  dom.extension.textContent = view.extension;
  dom.total.textContent = `Total ${formatBytes(view.total)}`;

  dom.run.disabled = !view.canExport;
  dom.runLabel.textContent = view.busy ? 'Packaging…' : 'Export';
  setIcon(dom.runIcon, view.busy ? 'loader-circle' : 'download');
  dom.cancel.disabled = view.busy;
  // The X is the same door as Cancel and Escape, and it was the only one left
  // open: `dialog.close()` called from script fires no `cancel` event, so the
  // guard below never saw it and a second export could start over the first.
  dom.close.disabled = view.busy;

  show(dom.progress, view.caption !== null);
  if (view.caption && session.progress) {
    paintProgress(session.progress);
  }
}

/**
 * The two nodes a progress tick actually changes.
 *
 * The caption carries the counts, so it has to move with the bar — updating
 * only the fill would leave the text frozen at "1 of 200" for the whole
 * package. The wording is duplicated from `deriveExportView` rather than
 * derived, because deriving it is the measure this exists to avoid; the test
 * pins the two together.
 */
function paintProgress(progress: { done: number; total: number }): void {
  const ratio = progress.total === 0 ? 1 : progress.done / progress.total;
  dom.progressFill.style.width = `${Math.round(ratio * 100)}%`;
  dom.caption.textContent = `Packaging screenshot ${progress.done} of ${progress.total}`;
}

/**
 * "Not your defaults", and the way back.
 *
 * `banner` is the Settings screen's own primitive, imported rather than
 * reimplemented — the classes it uses live in the shared stylesheet both
 * surfaces load, so this is the same control here as it is there. A local copy
 * would be a control that looks like a setting in one surface and slightly
 * different in another, which is the drift the primitive exists to prevent.
 */
function paintDefaults(): void {
  if (!session) return;

  const drift = driftFromDefaults(session.options, session.configured, {
    chosen: session.format,
    configured: session.configuredFormat,
  });

  if (drift === null || session.busy) {
    dom.defaults.replaceChildren();
    return;
  }

  dom.defaults.replaceChildren(
    banner('info', drift, {
      action: { label: 'Use my defaults', onClick: () => void useDefaults() },
    }),
  );
}

/**
 * Back to the configured defaults, and forget the deviation.
 *
 * The memory is written, not cleared: `openingOptions` reads "remembered, and
 * what it was remembered against", and a memory equal to the default it was
 * made against is the honest record of what just happened. Clearing the key
 * would work today and stop working the moment the user changes the setting,
 * because the absent memory would then take the *new* default silently rather
 * than being compared to the old one.
 */
async function useDefaults(): Promise<void> {
  const active = session;
  if (!active || active.busy) return;

  active.options = { ...active.configured };
  active.format = active.configuredFormat;
  await setLocal({ exportOptions: active.options, [AGAINST_KEY]: active.configured });
  if (session === active) paint();
}

function buildFormat(card: FormatCard): HTMLElement {
  const node = clone('tpl-format');
  node.setAttribute('aria-checked', String(card.selected));

  find(node, '.format__icon').dataset.icon = card.icon;
  find(node, '.format__name').textContent = card.name;
  find(node, '.format__description').textContent = card.description;
  find(node, '.format__size').textContent = formatBytes(card.bytes);

  const badge = find(node, '.format__badge');
  if (card.recommended) show(badge, true);
  else badge.remove();

  node.addEventListener('click', () => {
    if (!session || session.busy) return;
    session.format = card.id;
    paint();
  });

  hydrateIcons(node);
  return node;
}

function buildInclude(row: IncludeRow): HTMLElement {
  const node = clone<HTMLLabelElement>('tpl-include');
  node.dataset.ignored = String(row.ignored !== null);

  const input = find<HTMLInputElement>(node, '.include__input');
  input.checked = row.checked;
  input.disabled = row.ignored !== null;

  find(node, '.include__label').textContent = row.label;
  const note = find(node, '.include__note');
  note.textContent = row.ignored ?? '';
  // One line, truncated; the full reason a checkbox is disabled stays reachable.
  note.title = note.textContent;
  find(node, '.include__size').textContent = row.ignored ? '—' : formatBytes(row.bytes);

  input.addEventListener('change', () => {
    if (!session) return;
    session.options = { ...session.options, [row.id]: input.checked };
    // The choice *and* the defaults it was made against, in one write. Two
    // writes would leave a window in which the memory claims to have been made
    // against something it was not, and the pair is only meaningful together.
    void setLocal({ exportOptions: session.options, [AGAINST_KEY]: session.configured });
    paint();
  });

  return node;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

dom.close.addEventListener('click', () => dom.dialog.close());
dom.cancel.addEventListener('click', () => dom.dialog.close());

dom.filename.addEventListener('input', () => {
  if (!session) return;
  session.filename = dom.filename.value;
});

dom.run.addEventListener('click', () => void run());

/**
 * Escape must not cancel a running export.
 *
 * The dialog is the only thing reporting progress, and the download itself
 * cannot be called back once the archive is being assembled — so closing early
 * would leave a file arriving with nothing on screen to explain it.
 */
dom.dialog.addEventListener('cancel', (event) => {
  if (session?.busy) event.preventDefault();
});

async function run(): Promise<void> {
  /*
   * The session this run belongs to, held locally for the whole of it.
   *
   * `openExport` replaces the module-level `session` outright, so a flow opened
   * while an archive is still being packaged makes every `session.` below refer
   * to the wrong flow: A's export would close B's dialog mid-package and toast
   * A's filename while B was still building. Every mutation after an await is
   * therefore against `active`, and skipped once it is no longer on screen.
   */
  const active = session;
  if (!active || active.busy) return;

  const view = deriveExportView({ ...active });
  active.busy = true;
  active.progress = { done: 0, total: 0 };
  paint();

  const written = await exportFlow({
    steps: active.steps,
    title: active.title,
    format: active.format,
    options: active.options,
    filename: view.filename,
    react: active.react,
    settings: active.settings,
    onProgress: (done, total) => {
      if (session !== active) return;
      active.progress = { done, total };
      // The bar only, not a repaint.
      //
      // `paint()` runs `deriveExportView`, which re-measures the flow — a
      // `JSON.stringify` of every step, every network call and every console
      // entry — and rebuilds all seven rows. Doing that once per packed
      // screenshot was hundreds of full measures of a multi-megabyte array
      // between the yields `buildZip` makes precisely so the bar can move, so
      // the work meant to keep the tab responsive was what froze it.
      paintProgress(active.progress);
    },
  });

  active.busy = false;
  active.progress = null;
  if (session !== active) return;
  paint();

  if (!written.ok) {
    showToast({ message: written.error.message, tone: 'danger' });
    return;
  }

  dom.dialog.close();
  showToast({ message: `Saved ${written.value}.`, tone: 'success' });
}

export interface OpenExportOptions {
  steps: Step[];
  title: string;
  /** The flow's component table, absent when the page was not React. */
  react?: FlowReact | null;
  /** The flow's settings stamp. Absent on a flow archived before stamps. */
  settings?: Overrides | null;
}

export function openExport({ steps, title, react, settings }: OpenExportOptions): void {
  if (steps.length === 0) {
    showToast({ message: 'There is nothing to export yet.' });
    return;
  }

  void (async () => {
    /*
     * The configured default and the dialog's memory, together.
     *
     * Both are read, neither wins outright, and `openingOptions` decides per
     * switch by asking which of the two was stated more recently — see
     * `features/export/defaults.ts`. Read here rather than at module scope for
     * the reason `settings-module-scope.test.ts` exists: a default resolved once
     * when the viewer loaded would be the value the user had before they opened
     * Settings in the next tab.
     */
    const [stored, settingsNow] = await Promise.all([
      getLocal(['exportOptions', AGAINST_KEY]),
      loadSettings(),
    ]);
    const configured = exportDefaults(settingsNow);
    const remembered = stored.ok ? stored.value.exportOptions : undefined;
    const against = stored.ok ? stored.value.exportOptionsAgainst : undefined;

    session = {
      steps,
      title,
      react: react ?? undefined,
      settings: settings ?? undefined,
      // Per-export, not remembered: the shipped dialog opened on ZIP every time
      // and nothing stored a format, so there is no memory here for a default to
      // be weighed against. `export.format` is now what it opens on.
      format: configuredFormat(settingsNow),
      configuredFormat: configuredFormat(settingsNow),
      configured,
      options: openingOptions(configured, remembered, against),
      filename: suggestFilename(steps),
      busy: false,
      progress: null,
    };

    dom.filename.value = session.filename;
    paint();
    dom.dialog.showModal();
  })();
}
