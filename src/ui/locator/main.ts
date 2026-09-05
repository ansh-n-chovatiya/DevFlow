/**
 * The DevTools panel: pick a component on the page, and see where it was written.
 *
 * ## What this file is
 *
 * Wiring, and only wiring. Every decision about what the panel should show is in
 * `dom.ts`, every decision about how a component becomes a path is in
 * `locate.ts`, the card is `ui/components/result-card.ts`, the settings rows are
 * `ui/settings/components.ts` by way of `settings-drawer.ts`, and the Recent
 * list's ordering rule is `history.ts`. What is left here is the part that can
 * only be checked by loading the extension: ids, listeners, and the messages
 * that cross into the page.
 *
 * ## What the merge deleted from it
 *
 * The file this replaces was the largest in either repo, and three of its
 * mechanisms are simply gone rather than ported:
 *
 *   - **The agent injection.** It fetched a built IIFE, `eval`-ed it into the
 *     inspected window, and tracked whether it had already done so. DevFlow's
 *     agent is a manifest content script at `document_start` on `<all_urls>`, so
 *     it is already there, on every page, before anything asks.
 *   - **The 150 ms poll.** With no message channel, a pick was read back out of
 *     a page global on a timer. `START_PICK` is answered with the pick itself,
 *     deferred until the user clicks — so the panel awaits one promise and the
 *     timer, its deadline and its teardown all go with it.
 *   - **The runtime permission prompt.** `<all_urls>` was optional and requested
 *     on first use. It is a static grant now, which is a superset, so there is
 *     nothing to ask for and nothing to degrade to.
 *
 * ## The two views onto one component
 *
 * The card and the status bar carry the same three actions. That is deliberate,
 * not duplication: the panel is one scrolling column, and a long parent tree
 * puts the card's actions out of reach exactly when somebody wants them. The
 * card is the answer; the footer is the answer's actions, pinned. Both call the
 * same three functions.
 */

import { componentEditorUrl, editorTemplate, type EditorLink } from '../../core/locate/editor.js';
import type { HideableCategory } from '../../core/react/classify.js';
import { evalInPage } from '../../chrome/devtools.js';
import {
  createDevtoolsProvider,
  type DevtoolsProvider,
} from '../../features/react/providers/devtools.js';
import { bundleBudget } from '../../features/react/providers/worker.js';
import {
  DEFAULTS,
  load as loadSettings,
  managedKeys,
  save as saveSettings,
  subscribe as subscribeSettings,
  type Settings,
  type SettingKey,
} from '../../features/settings/index.js';
import { sendToWorker } from '../../shared/messages.js';
import type { ComponentSource, PickedComponent, TreeGroup } from '../../shared/types.js';
import {
  ambiguityText,
  pathText,
  resultCard,
  type CompiledPosition,
} from '../components/result-card.js';
import { hydrateIcons } from '../icons.js';
import { applyTheme, asTheme, DEFAULT_THEME, loadTheme } from '../theme.js';
import { showToast } from '../toast.js';
import {
  categoryChip,
  chipModels,
  el,
  hiddenCategories,
  hiddenKey,
  previewBlock,
  previewLines,
  setText,
  statusBarModel,
  STAGE_SEED,
  toggle,
  treeRow,
  visibleRows,
  withoutAmbiguity,
  modifierLabel,
  VIEWS,
  type StageKey,
  type StageState,
  type ViewName,
} from './dom.js';
import {
  loadHistory,
  mergeEntry,
  saveHistory,
  type HistoryEntry,
} from './history.js';
import { locateComponent, StalePickError, type SourcePreview } from './locate.js';
import { DRAWER_IDS, mountSettingsDrawer, type DrawerController } from './settings-drawer.js';

// ── State ────────────────────────────────────────────────────────────────────

interface PanelState {
  view: ViewName;
  /** The chain above the picked component, and its siblings. From the last pick. */
  ancestry: PickedComponent[];
  siblings: PickedComponent[];
  /** Which row the current answer belongs to, so a retry retries *it*. */
  activeGroup: TreeGroup | null;
  activeIndex: number;
  /** The answer on screen. */
  source: ComponentSource | null;
  /** Absent for an answer restored from Recent, which never recorded one. */
  resourcesSearched: number | undefined;
  preview: SourcePreview | null;
  filter: string;
  locatingName: string;
  history: HistoryEntry[];
  settings: Settings;
  managed: ReadonlySet<SettingKey>;
}

const state: PanelState = {
  view: 'idle',
  ancestry: [],
  siblings: [],
  activeGroup: null,
  activeIndex: -1,
  source: null,
  resourcesSearched: undefined,
  preview: null,
  filter: '',
  locatingName: '',
  history: [],
  settings: DEFAULTS,
  managed: new Set<SettingKey>(),
};

const tabId = chrome.devtools.inspectedWindow.tabId;

/**
 * The generation of the current gesture.
 *
 * Two picks can be outstanding at once — the footer's go button and the idle
 * view's button are the same action, and a second `START_PICK` supersedes the
 * first, which is then answered `cancelled`. The same is true of a locate: click
 * one tree row, then another before the first finishes. Both answers arrive;
 * only the newest may touch the screen, and a counter is the whole of what makes
 * that checkable without cancelling anything mid-flight.
 */
let generation = 0;

const provider: DevtoolsProvider = createDevtoolsProvider(bundleBudget(DEFAULTS));
let drawer: DrawerController | null = null;

/**
 * The inspected page's URL, for `BundleProvider.listScripts`.
 *
 * `DevtoolsProvider` ignores it — DevTools has already scoped `getResources()`
 * to the inspected window — but the parameter is part of the frozen interface
 * and passing a placeholder would make this the one call site that breaks the
 * day the panel is handed a different provider. Re-read on navigation, and `''`
 * when the page will not answer, which the provider treats identically.
 */
let pageUrl = '';

async function readPageUrl(): Promise<void> {
  try {
    pageUrl = await evalInPage<string>('location.href');
  } catch {
    pageUrl = '';
  }
}

// ── Views ────────────────────────────────────────────────────────────────────

function show(view: ViewName): void {
  state.view = view;
  for (const name of VIEWS) toggle(el(`view-${name}`), name === view);

  // Only the result view has hoverable rows, and leaving it must not strand a
  // highlight box on a page the user has gone back to reading.
  if (view !== 'result') clearHighlight();

  syncStatusBar();
}

function setStage(stage: StageKey, value: StageState): void {
  el('locating-steps')
    .querySelector<HTMLElement>(`[data-stage="${stage}"]`)
    ?.setAttribute('data-state', value);
}

/** Every tree click re-enters the locating view, so the checklist starts clean. */
function resetStages(): void {
  for (const [stage, value] of Object.entries(STAGE_SEED)) setStage(stage as StageKey, value);
}

function editorLink(): EditorLink {
  return {
    projectRoot: state.settings.projectRoot,
    template: editorTemplate(state.settings.editor, state.settings.customEditorTemplate),
  };
}

function syncStatusBar(): void {
  const source = state.source;
  const model = statusBarModel({
    view: state.view,
    source,
    editorUrl: source ? componentEditorUrl(source, editorLink()) : null,
    path: source ? pathText(source) : null,
    locating: state.locatingName,
  });

  const editor = el<HTMLButtonElement>('editor-btn');
  editor.disabled = model.editor.disabled;
  editor.title = model.editor.title;

  const sources = el<HTMLButtonElement>('sources-btn');
  sources.disabled = model.sources.disabled;
  sources.title = model.sources.title;

  const copy = el<HTMLButtonElement>('copy-btn');
  copy.disabled = model.copy.disabled;
  copy.title = model.copy.title;

  const go = el<HTMLButtonElement>('pick-again-btn');
  go.textContent = model.go.label;
  go.title = model.go.title;
  go.disabled = model.go.disabled;

  setText('status-hint', model.hint);
}

function fail(message: string): void {
  setText('error-msg', message);
  show('error');
}

// ── Picking ──────────────────────────────────────────────────────────────────

async function startPick(): Promise<void> {
  const mine = ++generation;
  show('picking');

  const result = await sendToWorker({ type: 'START_PICK', tabId });

  // Superseded: a second pick was armed, or the panel moved on. The answer is
  // still true, it is just no longer about anything on screen.
  if (mine !== generation) return;

  if (!result) {
    fail('The extension’s background worker did not answer. Reload the page and try again.');
    return;
  }

  if (result.kind === 'cancelled') {
    // A cancelled pick keeps whatever was already on screen. Losing a resolved
    // answer because the picker was armed by accident is the worse outcome.
    restoreAfterPick();
    /*
     * And it says so. The panel's own Cancel, and Escape pressed while the panel
     * has focus, both bump the generation first and never reach this line — so
     * the two ways in are Escape on the page and `PICK_TIMEOUT_MS` running out
     * two minutes later. Untold, the second is a panel that silently disarmed
     * itself: the view drops back to whatever it was, the page stops answering
     * the crosshair, and nothing anywhere says why.
     */
    showToast({ message: 'Picking stopped — nothing was picked.', tone: 'neutral' });
    return;
  }

  if (result.kind === 'error') {
    fail(result.error);
    return;
  }

  state.ancestry = result.ancestry;
  state.siblings = result.siblings;
  state.filter = '';
  el<HTMLInputElement>('tree-filter').value = '';

  // The picked component is the innermost entry of the ancestor chain.
  await locate('ancestry', state.ancestry.length - 1);
}

async function cancelPick(): Promise<void> {
  generation++;
  await sendToWorker({ type: 'CANCEL_PICK', tabId });
  restoreAfterPick();
}

function restoreAfterPick(): void {
  if (state.source) renderResult();
  else show('idle');
}

// ── Page highlighting ────────────────────────────────────────────────────────

function highlight(group: TreeGroup, index: number): void {
  void sendToWorker({ type: 'HIGHLIGHT_COMPONENT', tabId, group, index });
}

function clearHighlight(): void {
  void sendToWorker({ type: 'HIGHLIGHT_COMPONENT', tabId, group: 'ancestry', index: null });
}

// ── Locating ─────────────────────────────────────────────────────────────────

function componentAt(group: TreeGroup, index: number): PickedComponent | undefined {
  return group === 'sibling' ? state.siblings[index] : state.ancestry[index];
}

async function locate(group: TreeGroup, index: number): Promise<void> {
  const component = componentAt(group, index);
  if (!component) {
    fail('That component is no longer in the picked tree. Pick another one.');
    return;
  }

  const mine = ++generation;

  state.activeGroup = group;
  state.activeIndex = index;
  state.locatingName = component.name;

  setText('locating-name', component.name);
  resetStages();
  show('locating');

  try {
    const outcome = await locateComponent(
      {
        component,
        pageUrl,
        useSourceMaps: state.settings['react.useSourceMaps'],
        concurrency: state.settings['react.resolveConcurrency'],
      },
      {
        provider,
        readSource: async () => {
          const answer = await sendToWorker({
            type: 'READ_COMPONENT_SOURCE',
            tabId,
            group,
            index,
          });
          return answer?.source ?? null;
        },
        onStage: (stage, value) => {
          if (mine === generation) setStage(stage, value);
        },
      },
    );

    if (mine !== generation) return;

    state.source = outcome.source;
    state.resourcesSearched = outcome.resourcesSearched;
    state.preview = outcome.preview;
    remember(outcome.source);
    renderResult();
  } catch (error) {
    if (mine !== generation) return;
    fail(
      error instanceof StalePickError || error instanceof Error
        ? error.message
        : 'The locate failed for a reason it could not describe.',
    );
  }
}

function remember(source: ComponentSource): void {
  const entry: HistoryEntry = {
    component: source.name,
    label: pathText(source) ?? 'No source found',
    source,
    at: Date.now(),
  };
  state.history = mergeEntry(state.history, entry);
  void saveHistory(state.history);
}

// ── Rendering the result ─────────────────────────────────────────────────────

function renderResult(): void {
  const source = state.source;
  if (!source) return;

  renderCard(source);
  renderAmbiguity(source);
  renderPreview();
  renderTrees();

  // `show` syncs the status bar, which owns the footer's copy of the actions.
  show('result');
}

function renderCard(source: ComponentSource): void {
  const card = resultCard({
    // The warning is hoisted into the panel's own dismissible banner — see
    // `withoutAmbiguity`. Everything else on the card is the card's.
    source: withoutAmbiguity(source),
    link: editorLink(),
    resourcesSearched: state.resourcesSearched,
    /*
     * The panel is the one surface that can tell the two causes of
     * `compiled-only` apart, so it is the one that has to say which.
     *
     * A card that cannot know hedges — "not serving source maps, *or* reading
     * them is switched off" — and offers no control, because either half of
     * that sentence might be the wrong thing to act on. Here the setting is in
     * scope and the switch is in this panel's own drawer, so the answer is
     * definite and the fix is one click rather than a hunt through Settings.
     * The flow review leaves this unset and keeps the hedge, which is correct:
     * it is reading a stored flow and cannot know what the setting was.
     */
    sourceLookupOff: !state.settings['react.useSourceMaps'],
    onCopyPath: (path) => void copyPath(path),
    onOpenEditor: (url) => void openInEditor(url),
    onOpenSources: openInSources,
    onPickAnother: () => void startPick(),
    onEnableSourceLookup: () => void enableSourceLookup(),
  });

  // The card is the selected component, so it gets the same page highlight its
  // row in the tree does.
  card.addEventListener('mouseenter', () => {
    if (state.activeGroup !== null && state.activeIndex >= 0) {
      highlight(state.activeGroup, state.activeIndex);
    }
  });
  card.addEventListener('mouseleave', clearHighlight);

  el('result-card-slot').replaceChildren(card);
}

function renderAmbiguity(source: ComponentSource): void {
  const banner = el('ambiguity-warning');
  const matchCount = source.matchCount ?? 0;

  if (matchCount <= 1) {
    banner.hidden = true;
    return;
  }

  setText('ambiguity-text', ambiguityText(matchCount, state.resourcesSearched));
  // Deliberately unhidden for every ambiguous answer, so a dismissal lasts until
  // the next one rather than for the session: the caveat belongs to this path,
  // and the next path is a different claim about a different file.
  banner.hidden = false;
}

function renderPreview(): void {
  const wrap = el<HTMLDetailsElement>('preview-wrap');
  const code = el('preview-code');
  const preview = state.preview;

  if (!preview) {
    code.replaceChildren();
    wrap.hidden = true;
    return;
  }

  code.replaceChildren(previewBlock(previewLines(preview.content, preview.line)));
  wrap.hidden = false;
}

// ── Trees ────────────────────────────────────────────────────────────────────

function renderTrees(): void {
  const shown =
    renderTree('ancestry', state.ancestry) + renderTree('sibling', state.siblings);

  const anyPicked = state.ancestry.length > 0 || state.siblings.length > 0;
  toggle(el('tree-empty'), anyPicked && shown === 0);

  renderChips();
}

/** Renders one section and answers how many rows survived the filters. */
function renderTree(group: TreeGroup, items: PickedComponent[]): number {
  const section = el(`${group}-section`);
  const list = el(`${group}-list`);
  const hidden = hiddenCategories(state.settings);

  const keepIndex = state.activeGroup === group ? state.activeIndex : -1;
  const rows = visibleRows(items, hidden, keepIndex, state.filter);

  list.replaceChildren(
    ...rows.map((entry, position) =>
      treeRow(
        {
          entry,
          group,
          position: position + 1,
          active: state.activeGroup === group && state.activeIndex === entry.index,
          query: state.filter,
          hidden,
        },
        {
          onEnter: highlight,
          onLeave: clearHighlight,
          onPick: (pickedGroup, index) => void locate(pickedGroup, index),
        },
      ),
    ),
  );

  section.hidden = rows.length === 0;
  return rows.length;
}

function renderChips(): void {
  const hidden = hiddenCategories(state.settings);
  const models = chipModels([...state.ancestry, ...state.siblings], hidden);

  el('category-chips').replaceChildren(
    ...models.map((model) => categoryChip(model, (category) => void toggleCategory(category))),
  );
}

async function toggleCategory(category: HideableCategory): Promise<void> {
  const key = hiddenKey(category);

  if (state.managed.has(key)) {
    showToast({ message: 'Component filters are managed by your organisation.', tone: 'neutral' });
    return;
  }

  const next = !state.settings[key];
  // Optimistic, and put back by `subscribe` if the write does not land: a chip
  // that lags behind the pointer reads as a click that did not register.
  state.settings = { ...state.settings, [key]: next };
  renderTrees();

  const result = await saveSettings({ [key]: next });
  if (!result.ok) {
    state.settings = { ...state.settings, [key]: !next };
    renderTrees();
    showToast({ message: result.error.message, tone: 'danger' });
  }
}

// ── Actions ──────────────────────────────────────────────────────────────────

/**
 * Read what is mounted on the inspected page and hand it to the local graph —
 * Work Stream 3.3.
 *
 * Every branch below reports something, and the three outcomes are deliberately
 * three sentences rather than one. A page with no React on it, a reading that
 * worked, and a reading that worked but reached no server are three different
 * next moves, and the last is the one that matters: the map was read perfectly
 * well and the MCP server — which Claude Code starts, not the extension — is not
 * running. Told simply "failed", somebody would go and debug the page.
 *
 * There is no view for the map itself, and that is the honest shape of the
 * feature rather than an omission. This panel already renders the component tree
 * around a pick; the map's reader is Claude, through `get_living_architecture`,
 * and building a second tree view here would be a second answer to a question
 * the **Parent tree** and **Siblings** sections already answer for a person.
 */
async function readArchitecture(): Promise<void> {
  const button = el<HTMLButtonElement>('architecture-btn');
  button.disabled = true;
  try {
    const answer = await sendToWorker({ type: 'SNAPSHOT_ARCHITECTURE', tabId });
    if (!answer?.snapshot) {
      showToast({
        message: answer?.error ?? 'That page could not be read.',
        tone: 'neutral',
      });
      return;
    }

    const { components, totalInstances } = answer.snapshot;
    const read = `Read ${components.length} component${components.length === 1 ? '' : 's'} in ${totalInstances} instance${totalInstances === 1 ? '' : 's'}`;

    if (answer.sent) {
      showToast({ message: `${read}. Claude can now call get_living_architecture.`, tone: 'success' });
    } else {
      showToast({ message: `${read}, but it was not sent. ${answer.error ?? ''}`.trim(), tone: 'neutral' });
    }
  } finally {
    button.disabled = false;
  }
}

async function copyPath(path?: string): Promise<void> {
  const text = path ?? (state.source ? pathText(state.source) : null);
  if (!text) return;

  try {
    await navigator.clipboard.writeText(text);
    showToast({ message: 'Path copied', tone: 'success' });
  } catch {
    showToast({ message: 'The browser blocked the clipboard.', tone: 'danger' });
  }
}

async function openInEditor(url?: string): Promise<void> {
  const target = url ?? (state.source ? componentEditorUrl(state.source, editorLink()) : null);
  if (!target) {
    showToast({ message: 'Set a project root in Settings first.', tone: 'neutral' });
    return;
  }

  const answer = await sendToWorker({ type: 'OPEN_EDITOR', url: target });
  if (answer?.ok) showToast({ message: 'Opened in your editor', tone: 'success' });
  else showToast({ message: answer?.error ?? 'The editor did not open.', tone: 'danger' });
}

/**
 * Reveal the compiled position in DevTools' own Sources panel.
 *
 * Both numbers are `Pos0` and are handed over unconverted: `openResource` is
 * 0-based too, which is exactly why `ComponentSource.compiled` does not cross
 * the bridge (CONTRACTS §1).
 *
 * The four-argument form lands on the column as well as the line and is what
 * Chrome has shipped for years; the typings are older than that, and the
 * three-argument fallback is for a browser where the call actually throws.
 */
function openInSources(compiled?: CompiledPosition): void {
  const target = compiled ?? state.source?.compiled;
  if (!target) return;

  const withColumn = chrome.devtools.panels.openResource as unknown as (
    url: string,
    line: number,
    column: number,
    callback?: () => void,
  ) => void;

  try {
    withColumn(target.url, target.line, target.column, () => {
      const error = chrome.runtime.lastError;
      if (error) showToast({ message: `Sources did not open: ${error.message}`, tone: 'danger' });
    });
  } catch {
    chrome.devtools.panels.openResource(target.url, target.line, () => {
      void chrome.runtime.lastError;
    });
  }
}

/**
 * The card's `skipped` advice, taken.
 *
 * The switch it names is in the panel's own drawer, so this flips it in place
 * and re-locates the component that is on screen — leaving for the options page
 * would answer the question in a tab the answer is not in. Managed and
 * already-on both open the drawer instead: one is a value this panel may not
 * write, the other is a card that predates the setting, and in both cases the
 * honest thing is to show the reader the switch rather than claim to have moved
 * it.
 */
async function enableSourceLookup(): Promise<void> {
  const key: SettingKey = 'react.useSourceMaps';

  if (state.managed.has(key)) {
    drawer?.open();
    showToast({ message: 'Source lookup is managed by your organisation.', tone: 'neutral' });
    return;
  }

  if (state.settings[key]) {
    drawer?.open();
    return;
  }

  const result = await saveSettings({ [key]: true });
  if (!result.ok) {
    showToast({ message: result.error.message, tone: 'danger' });
    return;
  }

  showToast({ message: 'Source lookup turned on', tone: 'success' });

  /*
   * Adopted here rather than waited for.
   *
   * `subscribe` only hears about the write through `storage.onChanged`, and it
   * then re-reads the whole store before calling back — so the locate started
   * on the next line would have read the *old* value and come back saying
   * source lookup is switched off, one line under a toast saying it had just
   * been turned on. The write has already landed; this is the same settings
   * object the subscription is about to deliver.
   */
  adopt({ ...state.settings, [key]: true });

  // The point of the control is the answer, not the setting: the component that
  // could not be looked up is still on screen, and it can be now.
  if (state.activeGroup !== null && state.activeIndex >= 0) {
    void locate(state.activeGroup, state.activeIndex);
  }
}

/**
 * The first-run strip, shown while there is nothing to open a file with.
 *
 * Its whole state is `projectRoot === ''` plus a dismissal that lasts as long as
 * the panel does. Nothing is stored: a strip that survives its own condition is
 * an onboarding flag somebody has to reset, and this one has no condition left
 * to describe the moment the setting is set.
 */
let setupHintDismissed = false;

function syncSetupHint(): void {
  toggle(el('setup-hint'), !setupHintDismissed && state.settings.projectRoot.trim() === '');
}

function retry(): void {
  if (state.activeGroup !== null && state.activeIndex >= 0) {
    void locate(state.activeGroup, state.activeIndex);
    return;
  }

  // Nothing has been located, so the failure was the pick itself — a page with
  // no React under the cursor, or a worker that did not answer — and the only
  // thing there is to retry is arming the picker again. Falling through to the
  // idle view left the panel's primary action looking like a button that did
  // nothing: the error vanished and no picker was armed.
  void startPick();
}

function reset(): void {
  generation++;
  state.ancestry = [];
  state.siblings = [];
  state.activeGroup = null;
  state.activeIndex = -1;
  state.source = null;
  state.resourcesSearched = undefined;
  state.preview = null;
  state.filter = '';
  state.locatingName = '';
  el<HTMLInputElement>('tree-filter').value = '';
  show('idle');
}

// ── Recent ───────────────────────────────────────────────────────────────────

function renderHistory(): void {
  const list = el('history-list');

  list.replaceChildren(
    ...state.history.map((entry) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tree-item';
      row.title = `Show ${entry.component} again`;

      const name = document.createElement('span');
      name.className = 'tree-name';
      name.textContent = entry.component;

      const label = document.createElement('span');
      label.className = 'tree-badge';
      label.textContent = entry.label;
      label.title = entry.label;

      row.append(name, label);
      row.addEventListener('click', () => {
        state.source = entry.source;
        /*
         * The restored answer belongs to no row of the tree on screen.
         *
         * Left pointing at the last locate, the trees kept a different
         * component's row marked active, hovering the restored card drew the
         * page highlight around that other component, and `Retry` would have
         * re-located it — three views of one selection disagreeing about which
         * component is selected.
         */
        state.activeGroup = null;
        state.activeIndex = -1;
        // A stored entry never recorded how many bundles were read, and the
        // ambiguity sentence works without it.
        state.resourcesSearched = undefined;
        // Neither is the preview kept: it is up to a megabyte of somebody's
        // source per entry, and the drawer holds twelve.
        state.preview = null;
        closeDrawers();
        renderResult();
      });

      return row;
    }),
  );

  toggle(el('history-empty'), state.history.length === 0);
}

/**
 * The one place the Recent drawer opens and shuts.
 *
 * `hidden` and the opener's `aria-expanded` are the same fact told twice, and
 * five call sites each setting `hidden` on its own is how the second one falls
 * behind: a screen reader would keep announcing a collapsed button over an open
 * drawer.
 */
function setHistoryOpen(open: boolean): void {
  el('history-drawer').hidden = !open;
  el('history-btn').setAttribute('aria-expanded', String(open));
  if (open) renderHistory();
}

function openHistory(): void {
  drawer?.close();
  setHistoryOpen(el('history-drawer').hidden);
}

function closeDrawers(): void {
  drawer?.close();
  setHistoryOpen(false);
}

/** Either drawer covers `main` outright, so it also owns the keyboard. */
function anyDrawerOpen(): boolean {
  return drawer?.isOpen() === true || !el('history-drawer').hidden;
}

// ── Theme ────────────────────────────────────────────────────────────────────

/**
 * `system` means DevTools' theme here, and only here (CONTRACTS §3.5).
 *
 * A DevTools panel inherits the theme the user chose for DevTools, which is
 * independent of the operating system — so a panel obeying `prefers-color-scheme`
 * sits inside a dark DevTools window wearing the light palette. An explicit
 * `light` or `dark` still wins outright: the setting is the product's own and it
 * is not a suggestion.
 *
 * Written here rather than through `initTheme()` because that helper takes no
 * `systemAs` argument, and `themeName` is available synchronously — which also
 * means the first paint is right instead of being corrected a moment later.
 */
function devtoolsTheme(): 'light' | 'dark' {
  return chrome.devtools.panels.themeName === 'dark' ? 'dark' : 'light';
}

function initPanelTheme(): void {
  applyTheme(DEFAULT_THEME, devtoolsTheme());
  void loadTheme().then((theme) => applyTheme(theme, devtoolsTheme()));

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync' || !('theme' in changes)) return;
    applyTheme(asTheme(changes.theme?.newValue), devtoolsTheme());
  });
}

// ── Wiring ───────────────────────────────────────────────────────────────────

function wire(): void {
  el('pick-btn').addEventListener('click', () => void startPick());
  el('error-pick-btn').addEventListener('click', () => void startPick());
  el('cancel-pick-btn').addEventListener('click', () => void cancelPick());
  el('retry-btn').addEventListener('click', retry);

  // One button, two jobs — see `goButton` in dom.ts.
  el('pick-again-btn').addEventListener('click', () => {
    if (state.view === 'picking') void cancelPick();
    else void startPick();
  });

  el('editor-btn').addEventListener('click', () => void openInEditor());
  el('sources-btn').addEventListener('click', () => openInSources());
  el('copy-btn').addEventListener('click', () => void copyPath());

  el('ambiguity-dismiss').addEventListener('click', () => {
    el('ambiguity-warning').hidden = true;
  });

  el('setup-hint-open').addEventListener('click', () => {
    setHistoryOpen(false);
    drawer?.open();
  });
  el('setup-hint-dismiss').addEventListener('click', () => {
    setupHintDismissed = true;
    syncSetupHint();
  });

  el<HTMLInputElement>('tree-filter').addEventListener('input', (event) => {
    state.filter = (event.target as HTMLInputElement).value;
    renderTrees();
  });

  // The settings drawer wires its own opener; this only keeps the two drawers
  // from being open at once, which no single controller can see.
  el(DRAWER_IDS.open).addEventListener('click', () => {
    setHistoryOpen(false);
  });
  el('history-btn').addEventListener('click', openHistory);
  el('architecture-btn').addEventListener('click', () => void readArchitecture());
  el('history-close').addEventListener('click', () => {
    setHistoryOpen(false);
  });
  el('history-clear').addEventListener('click', () => {
    state.history = [];
    void saveHistory(state.history);
    renderHistory();
  });

  document.addEventListener('keydown', onKeyDown);

  // The pointer leaving the panel means no row is hovered any more.
  el('main').addEventListener('mouseleave', clearHighlight);

  /*
   * A reload invalidates everything the panel is holding: the agent's function
   * arrays belong to a document that is gone, and every cached bundle text
   * belongs to the build that served it. Without this, every tree row fails with
   * "no longer on the page" and every search runs against the previous deploy.
   */
  chrome.devtools.network.onNavigated.addListener(() => {
    provider.clear();
    void readPageUrl();
    reset();
  });

  // A pick armed by a panel that is closing would leave the page under a
  // crosshair with its clicks swallowed. The worker's port-disconnect handler is
  // the guarantee; this is the fast path when the panel gets a moment to speak.
  window.addEventListener('pagehide', () => {
    void sendToWorker({ type: 'CANCEL_PICK', tabId });
  });
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    const drawerOpen = anyDrawerOpen();
    closeDrawers();
    // The page agent only sees Escape while the page has focus, so a panel that
    // has it has to cancel for itself.
    if (!drawerOpen && state.view === 'picking') void cancelPick();
    return;
  }

  /*
   * A drawer covers the whole of `main`, so nothing behind it is a target.
   *
   * Without this, `P` armed the picker underneath an open Settings drawer — the
   * page went into pick mode, the panel stayed on the drawer, and the click that
   * followed was swallowed by a picker the user could not see they had started.
   * Escape is handled above precisely because it is the way *out* of a drawer.
   */
  if (anyDrawerOpen()) return;

  // ⌘K / Ctrl-K focuses the filter. Handled before the typing guard below, so it
  // still works when the caret is already in the field.
  if ((event.key === 'k' || event.key === 'K') && (event.metaKey || event.ctrlKey) && !event.altKey) {
    if (state.view !== 'result') return;
    event.preventDefault();
    el<HTMLInputElement>('tree-filter').select();
    return;
  }

  // Don't hijack typing in the filter or in a settings row.
  const tag = (event.target as HTMLElement | null)?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;

  if ((event.key === 'p' || event.key === 'P') && !event.metaKey && !event.ctrlKey && !event.altKey) {
    event.preventDefault();
    void startPick();
  }
}

/**
 * Adopt whatever settings say, now and whenever they change.
 *
 * The provider is retargeted rather than rebuilt, because its bundle cache is
 * what makes the second locate on a page nearly free — the same four bundles as
 * the first — and someone nudging a concurrency number in the drawer should not
 * throw it away.
 */
function adopt(settings: Settings): void {
  state.settings = settings;
  provider.retarget(bundleBudget(settings));

  // Setting a project root in the drawer is the strip's own condition going
  // away, so it goes away here rather than on the next repaint of the view.
  syncSetupHint();

  if (state.view === 'result' && state.source) {
    // The editor, the project root and the five category flags all change what
    // is on screen without anything being picked again.
    renderCard(state.source);
    renderTrees();
  }
  syncStatusBar();
}

async function init(): Promise<void> {
  initPanelTheme();
  hydrateIcons();
  wire();

  setText('filter-kbd-mod', modifierLabel(navigator.userAgent));

  drawer = mountSettingsDrawer();
  if (!drawer) console.warn('DevFlow: the settings drawer has no container to mount into.');

  subscribeSettings(adopt);

  const [settings, managed, history] = await Promise.all([
    loadSettings(),
    managedKeys(),
    loadHistory(),
  ]);

  state.managed = managed;
  state.history = history;
  adopt(settings);

  // Not awaited with the rest: the panel is usable before the inspected page
  // says what it is showing, and only a locate needs the answer.
  void readPageUrl();

  show('idle');
}

void init();
