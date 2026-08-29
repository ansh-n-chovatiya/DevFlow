/**
 * Settings controller.
 *
 * Structural decision E: settings leave the popup. They used to live in a
 * disclosure triangle under the primary recording controls, which is how a
 * developer's server address ended up on the surface a user opens to press
 * Record.
 *
 * This file holds state and behaviour and **creates no DOM nodes at all** —
 * `components.ts` is the only file that may, and `npm run lint:settings-ui`
 * fails the build if that stops being true. What is left here is: read storage,
 * decide, hand `components.ts` a model, and write back. Everything the screen
 * *looks* like is over there; everything it *decides* is in `view.ts`.
 */

import {
  bytesInUse,
  getAllLocal,
  getLocal,
  removeLocal,
  setLocal,
} from '../../chrome/storage.js';
import { downloadFile } from '../../features/export/download.js';
import { checkMcp } from '../../features/mcp/health.js';
import { deliverMachineSettings, type MachineDelivery } from '../../features/mcp/machine.js';
import {
  DEFAULTS,
  FIELDS,
  fieldFor,
  isMachineKey,
  loadOverrides,
  resolve,
  replaceOverrides,
  save,
  subscribe,
  type Field,
  type Overrides,
  type SettingKey,
  type Settings,
} from '../../features/settings/index.js';
import {
  defaultsJson,
  EXPORT_FILENAME,
  exportable,
  parseSettingsFile,
  planImport,
  serialise,
  unknownLines,
  type ImportPlan,
} from '../../features/settings/file.js';
import {
  clearPending,
  PENDING_SETTINGS_KEY,
  readPending,
  writePending,
  type PendingImport,
} from '../../features/settings/pending.js';
import {
  savedFlowKey,
  savedFlowReactKey,
  type FlowMeta,
  type ThemePreference,
} from '../../shared/types.js';
import { formatBytes } from '../format.js';
import { initTheme, saveTheme } from '../theme.js';
import { showToast } from '../toast.js';
import {
  confirmDialog,
  importDialog,
  pickJsonFile,
  settingsPage,
  type RowAction,
  type RowNote,
  type StorageView,
} from './components.js';
import {
  exportedNote,
  importView,
  paneProblem,
  pendingNote,
  unknownPaneNote,
} from './file-view.js';
import {
  addressNote,
  commitProblem,
  defaultLabel,
  EMPTY_QUERY,
  lift,
  machineNote,
  normalise,
  settingsModel,
  type Filter,
} from './view.js';

initTheme();

// ── State ────────────────────────────────────────────────────────────────────

interface Extra {
  /** The one line under a control: a clamp report, a result, a problem. */
  note: RowNote | null;
  action: RowAction | null;
}

const state = {
  settings: DEFAULTS,
  /**
   * The raw sync area — what `resolve` was given, not what it returned.
   *
   * Held beside the resolved settings because the file is the *overrides*, and
   * two of the three things this screen does with it need the sparse object: the
   * export writes it, and the JSON pane shows it. A key from a newer version is
   * only ever in here.
   */
  overrides: {} as Overrides,
  query: EMPTY_QUERY,
  advancedOpen: false,
  activeRail: '',
  recording: false,
  /** An import confirmed while a recording was running, waiting for it to stop. */
  pending: null as PendingImport | null,
  /**
   * The `{}` view. `text` is what is in the editable pane, which stops being
   * `stored` the moment somebody types — and must not be replaced under them by
   * a repaint. `stored` is the same document as the exported file, byte for
   * byte, which is what makes "edit this and apply" and "send me your file" the
   * same operation.
   */
  json: { open: false, text: '', stored: '' },
  savedFlows: [] as FlowMeta[],
  extras: new Map<string, Extra>(),
  storage: {
    used: '—',
    detail: '',
    flows: 'No saved flows.',
    deletable: false,
  } as StorageView,
};

/**
 * The two settings with an action beside them, and the action has to survive a
 * re-render — the page repaints when the value is committed, which is the same
 * gesture that arms the button.
 */
function mcpAction(busy: boolean): RowAction {
  return { label: busy ? 'Checking…' : 'Test connection', icon: 'refresh-cw', busy };
}

/**
 * The retry for a machine-wide setting.
 *
 * These three are the only settings whose delivery can fail while the write
 * succeeds: the server may simply not be running at the moment the value
 * changes. `POST /config` is deliberately not retried in the background — see
 * `pushMachineConfig` — so the retry is a button, next to the row that needs
 * it, and pressing it is how a value set while the server was down gets there.
 */
function pushAction(busy: boolean): RowAction {
  return { label: busy ? 'Sending…' : 'Send to server', icon: 'upload', busy };
}

function actionFor(key: string): RowAction | null {
  if (key === 'mcpServerUrl') return mcpAction(false);
  if (isMachineKey(key)) return pushAction(false);
  return null;
}

function extraFor(key: string): Extra {
  const found = state.extras.get(key);
  if (found) return found;
  const created: Extra = { note: null, action: actionFor(key) };
  state.extras.set(key, created);
  return created;
}

/*
 * Every row that has an action, given one before the first paint.
 *
 * `extraFor` creates an entry the first time something *happens* to a row, and
 * the map is what `renderRow` reads the action out of — so until this loop the
 * page shipped with no "Test connection" button at all. It appeared only after
 * a commit or a clamp on that row, which is to say: almost never, and never for
 * the person opening Settings to check the address for the first time. Nothing
 * threw, and every test passed, because a hidden button is a button the DOM
 * still has.
 *
 * Phase 1's, found in Phase 5 by rendering the page — the same way Phase 4
 * found the search bug. Reads the field table, not a setting; the seed is
 * `actionFor`, which is a pure function of the key.
 */
for (const field of FIELDS as readonly Field[]) {
  if (actionFor(field.key)) extraFor(field.key);
}

function paint(): void {
  const parsed = parseSettingsFile(state.json.text);
  const warned = unknownLines(state.json.text);

  page.render({
    model: settingsModel({
      settings: state.settings,
      query: state.query,
      advancedOpen: state.advancedOpen,
    }),
    extras: state.extras,
    recording: state.recording,
    pending: state.pending ? pendingNote(state.pending.changes) : null,
    storage: state.storage,
    activeRail: state.activeRail,
    json: {
      open: state.json.open,
      defaults: DEFAULTS_JSON,
      text: state.json.text,
      warned,
      unknownNote: unknownPaneNote(warned.length),
      problem: parsed.ok ? null : paneProblem(parsed.error.message),
      dirty: state.json.text !== state.json.stored,
    },
  });
}

/**
 * The left pane, built once.
 *
 * A module-level `const` of the *defaults*, which is the one thing on this
 * screen that genuinely cannot change while it is open — the field table is
 * compiled in. `settings-module-scope.test.ts` is about reading a *setting* at
 * import time; this reads none.
 */
const DEFAULTS_JSON = defaultsJson();

// ── Writing a setting ────────────────────────────────────────────────────────

/**
 * One committed value, saved.
 *
 * Optimistic: the row shows the new value before storage confirms it, and is put
 * back if the write fails. The alternative — waiting for `chrome.storage.sync`
 * before repainting — is a checkbox that lags behind the pointer on a slow sync,
 * which reads as the click not having registered.
 *
 * `theme` goes through `saveTheme` rather than `save`, because the preference is
 * mirrored into `localStorage` to beat first paint (an extension page cannot run
 * an inline script under the default MV3 policy). Writing it with `save` would
 * leave the mirror one version behind and flash the old theme on the next load.
 */
function commit(field: Field, raw: unknown, clamped: RowNote | null): void {
  const key = field.key as SettingKey;
  const value = normalise(field, raw);
  const before = state.settings[key];

  const problem = commitProblem(field, value);
  extraFor(field.key).note = problem ? { text: problem, tone: 'danger' } : clamped;

  state.settings = { ...state.settings, [key]: value };
  paint();

  const written =
    key === 'theme'
      ? saveTheme(value as ThemePreference)
      : save({ [key]: value });

  void written.then((result) => {
    if (!result.ok) {
      // Reflect the truth: the setting did not change, so neither should the UI.
      state.settings = { ...state.settings, [key]: before };
      paint();
      showToast({ message: result.error.message, tone: 'danger' });
      return;
    }

    if (isMachineKey(key)) void deliverMachine([field]);
  });
}

// ── The machine-wide settings ────────────────────────────────────────────────

/**
 * Hand the three machine-wide settings to the server, and say what happened.
 *
 * Storage is not delivery for these. `mcp.port`, `mcp.maxFlows` and
 * `mcp.maxFlowBytes` govern a Node process on the other side of an HTTP
 * boundary, and every step between the write and the effect can fail on its
 * own: the server may not be running, its environment may outrank the file, and
 * the port cannot move under a socket that is already bound. A row that went
 * green on the storage write alone would be claiming all three had gone well
 * without having checked any of them.
 *
 * The address used is the one held *now*, before the port setting is allowed to
 * move it. That ordering is the whole of it: the server that has to be told
 * about the new port is the one currently answering on the old one, and a push
 * sent to the new address would go to a port nothing is listening on yet.
 */
async function deliverMachine(fields: readonly Field[]): Promise<void> {
  if (fields.length === 0) return;

  // One push whatever the number of rows: the body is the whole machine-wide
  // half of the file, so sending it twice would say the same thing twice. The
  // *reply* is then read once per row, because what it means differs per key —
  // only the port waits for a restart, and only the key an environment variable
  // names has been outranked.
  const values = new Map(fields.map((field) => [field.key, state.settings[field.key as SettingKey]]));

  for (const field of fields) {
    const extra = extraFor(field.key);
    extra.action = pushAction(true);
    extra.note = { text: 'Sending to the server…', tone: 'busy' };
  }
  paint();

  const delivery = await deliverMachineSettings(state.settings);

  // Storage is the truth about the address afterwards, and the JSON pane has to
  // move with it — the port may have taken `mcpServerUrl` along.
  await reload();

  for (const field of fields) {
    const extra = extraFor(field.key);
    extra.action = pushAction(false);
    extra.note = machineNote(
      field,
      values.get(field.key),
      delivery.address,
      delivery.push.ok ? delivery.push.value : null,
    );
  }
  sayWhatHappenedToTheAddress(delivery);
  paint();
}

/**
 * The other side of the port setting, on the other side's own row.
 *
 * A port setting that changes one side and not the other is worse than no
 * port setting at all, so changing it has to surface both. The address is moved
 * to match — and the move is *said*, because a setting that quietly changes a
 * second setting is its own kind of trap. An address that is not this machine's
 * server is left exactly as it is, and that is said too.
 */
function sayWhatHappenedToTheAddress(delivery: MachineDelivery): void {
  if (delivery.alignment.kind === 'moved' && !delivery.saved) {
    // The one case with nothing true to say on the row: the address did not
    // move, so a note claiming it had would be the lie this whole file is
    // against.
    showToast({ message: 'The MCP address could not be updated.', tone: 'danger' });
    return;
  }

  const note = addressNote(delivery.alignment);
  if (note) extraFor('mcpServerUrl').note = note;
}

function resetKeys(keys: readonly SettingKey[]): void {
  if (keys.length === 0) return;

  const patch: Record<string, unknown> = {};
  for (const key of keys) {
    patch[key] = DEFAULTS[key];
    // A clamp report or a connection result is about a value that no longer
    // exists, so it goes with it.
    extraFor(key).note = null;
  }

  state.settings = { ...state.settings, ...patch };
  paint();

  // `theme` again: the mirror has to move with it, and `save` does not touch it.
  if (keys.includes('theme')) void saveTheme(DEFAULTS.theme);

  void save(patch as Partial<Settings>).then((result) => {
    if (!result.ok) {
      showToast({ message: result.error.message, tone: 'danger' });
      void reload();
      return;
    }

    // A reset is a change like any other, and the server has to be told: the
    // file holds only what the user set, so resetting a machine-wide key is
    // what removes it from `config.json` and puts the shipped default back.
    void deliverMachine(keys.filter(isMachineKey).map((key) => fieldFor(key) as Field));
  });
}

/** Every setting the user has moved, in table order — what "Reset all" names. */
function modifiedFields(): Field[] {
  return (FIELDS as readonly Field[]).filter(
    (field) => state.settings[field.key as SettingKey] !== DEFAULTS[field.key as SettingKey],
  );
}

// ── Reading ──────────────────────────────────────────────────────────────────

/**
 * Storage, resolved, with the JSON pane kept level with it.
 *
 * The overrides are read rather than just the resolved settings because the
 * export and the pane are both the *sparse* object — see `state.overrides`.
 */
async function reload(): Promise<void> {
  state.overrides = await loadOverrides();
  state.settings = resolve(state.overrides);
  syncJsonPane();
  paint();
}

/**
 * Re-seed the editable pane from storage — unless it has been edited.
 *
 * A setting changed in another tab repaints this one, and a repaint that
 * replaced the text somebody was halfway through typing would lose their work
 * to an event they did not cause and cannot see. So the pane follows storage
 * only while the two still agree; once they do not, `Revert` is how you get
 * back and it is a button the user pressed.
 */
function syncJsonPane(): void {
  const next = serialise(exportable(state.overrides));
  const clean = state.json.text === state.json.stored;
  state.json.stored = next;
  if (clean) state.json.text = next;
}

/** What the pane and the exported file both hold. One document, two exits. */
function currentFile(): string {
  return serialise(exportable(state.overrides));
}

/**
 * Settings are frozen for the duration of a recording, and this screen says
 * so rather than disabling anything. Read from the same two local keys the popup
 * reads, so the two surfaces cannot disagree about whether a recording is on.
 */
async function readRecording(): Promise<void> {
  const stored = await getLocal(['recordingActive']);
  state.recording = stored.ok && stored.value.recordingActive === true;
}

async function refreshStorage(): Promise<void> {
  const used = await bytesInUse();

  const stored = await getLocal(['savedFlowsMeta']);
  state.savedFlows =
    stored.ok && Array.isArray(stored.value.savedFlowsMeta) ? stored.value.savedFlowsMeta : [];

  const steps = state.savedFlows.reduce((total, flow) => total + flow.stepCount, 0);

  state.storage = {
    // `null` is Chrome refusing to measure, not an empty store. Printing "0 B"
    // for it would tell somebody with a full library that they have room to
    // spare, which is the one thing this figure exists to answer.
    used: used === null ? 'Unknown' : formatBytes(used),
    // Per-step is what lets someone predict the cost of the next recording.
    detail:
      used !== null && steps > 0
        ? `About ${formatBytes(Math.round(used / steps))} per step, mostly screenshots.`
        : '',
    flows:
      state.savedFlows.length === 0
        ? 'No saved flows.'
        : `${state.savedFlows.length} saved ${state.savedFlows.length === 1 ? 'flow' : 'flows'}, ${steps} steps in total. The flow you are recording now is not included.`,
    /*
     * Enabled even with an empty index, because the index is not the whole story.
     *
     * The sweep behind this button removes orphaned `savedFlow_*` keys as well as
     * the ones the index names — and orphans are exactly what an empty index
     * cannot see. Disabling on `savedFlows.length === 0` left the only control
     * that can reclaim that space switched off precisely when it was the one
     * thing left to do.
     */
    deletable: state.savedFlows.length > 0 || Boolean(used),
  };
}

// ── Deleting flows ───────────────────────────────────────────────────────────

function askDeleteFlows(): void {
  const count = state.savedFlows.length;

  const dialog = confirmDialog(
    {
      title: 'Delete every saved flow?',
      body:
        count === 0
          ? 'The library is already empty. Any flow data left behind by a failed save will be deleted. This cannot be undone.'
          : count === 1
            ? 'The one saved flow, and its screenshots, will be deleted. This cannot be undone.'
            : `All ${count} saved flows, and their screenshots, will be deleted. This cannot be undone.`,
      confirmLabel: count === 1 ? 'Delete 1 flow' : `Delete ${count} flows`,
      cancelLabel: 'Keep them',
    },
    () => void deleteFlows(),
  );

  document.body.append(dialog);
  dialog.showModal();
}

async function deleteFlows(): Promise<void> {
  const listed: string[] = state.savedFlows.flatMap((flow) => [
    savedFlowKey(flow.id),
    savedFlowReactKey(flow.id),
  ]);

  /*
   * Sweep for orphans as well as for what the index names.
   *
   * Deriving the removal list from `savedFlowsMeta` alone is what made this
   * button unable to do what it says. A save writes the steps first and the index
   * second, so an index write that failed leaves a `savedFlow_<id>` key the index
   * never carried — and since ids are `flow_<ms>` and never recur, nothing will
   * ever overwrite it either. Megabytes, in a 10 MB store, that no screen lists
   * and no button could free.
   *
   * The read costs the whole area, so it happens here, on a button the user
   * pressed and confirmed, rather than on every refresh of this page.
   */
  const all = await getAllLocal();
  const orphans = all.ok
    ? Object.keys(all.value).filter(
        (key) =>
          (key.startsWith('savedFlow_') || key.startsWith('savedFlowReact_')) &&
          !listed.includes(key),
      )
    : [];

  const removed = await removeLocal([...listed, ...orphans]);
  if (!removed.ok) {
    showToast({ message: removed.error.message, tone: 'danger' });
    return;
  }

  // The index is cleared second: if the removal above failed halfway, the flows
  // that survive are still listed rather than becoming unreachable.
  const cleared = await setLocal({ savedFlowsMeta: [] });
  if (!cleared.ok) {
    showToast({ message: cleared.error.message, tone: 'danger' });
    return;
  }

  const count = state.savedFlows.length;
  await refreshStorage();
  paint();
  showToast({ message: `Deleted ${count} ${count === 1 ? 'flow' : 'flows'}.`, tone: 'success' });
}

// ── Resetting everything ─────────────────────────────────────────────────────

function askResetAll(): void {
  const changed = modifiedFields();

  if (changed.length === 0) {
    showToast({ message: 'Every setting is already at its default.' });
    return;
  }

  const dialog = confirmDialog(
    {
      title: 'Reset all settings to defaults?',
      body: `This clears the ${changed.length} ${changed.length === 1 ? 'setting' : 'settings'} you have changed. Recordings already made are not affected.`,
      confirmLabel:
        changed.length === 1 ? 'Reset 1 setting' : `Reset ${changed.length} settings`,
      cancelLabel: 'Cancel',
      changes: changed.map((field) => ({
        name: field.title,
        // The key, for the same reason the row shows one: it is the name the
        // settings file, the search box and every error message use.
        key: field.key,
        from: show(state.settings[field.key as SettingKey]),
        // The dialog moves values *toward* the default, so the default is the
        // incoming half and the current value is the one being given up.
        to: defaultLabel(field).replace(/^default /, ''),
      })),
    },
    () => resetKeys(changed.map((field) => field.key as SettingKey)),
  );

  document.body.append(dialog);
  dialog.showModal();
}

function show(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  if (Array.isArray(value)) return value.length === 0 ? 'none' : value.join(', ');
  if (value === '') return 'empty';
  return String(value);
}

// ── The file ─────────────────────────────────────────────────────────────────

/**
 * The export: the sparse override object, and nothing else.
 *
 * Not the resolved one. "A file that pins all sixty values freezes today's
 * defaults into whoever imports it, forever, and the mistake is invisible until
 * the release where a default improves and they do not get it."
 */
function exportSettings(): void {
  const text = currentFile();
  downloadFile(EXPORT_FILENAME, new Blob([text], { type: 'application/json' }));
  showToast({
    message: exportedNote(EXPORT_FILENAME, Object.keys(exportable(state.overrides)).length),
    tone: 'success',
  });
}

/**
 * The import, steps 1 to 4. Step 5 is `applyImport`, and nothing reaches it
 * without passing through the dialog this opens.
 *
 * One function for both ways in — a picked file and the JSON pane's *Review and
 * apply* — because a second entry point is a second chance for one of them to
 * skip the diff, and the diff is the feature.
 */
function reviewImport(text: string): void {
  const parsed = parseSettingsFile(text);
  if (!parsed.ok) {
    // The line, not the byte offset: the user is looking at the document, and
    // "line 4" is somewhere they can put a caret.
    showToast({ message: parsed.error.message, tone: 'danger' });
    return;
  }

  // Read again rather than trusting `state.overrides`: the plan is a claim about
  // what applying would do, and it is about to be shown to somebody who will
  // decide on the strength of it.
  void loadOverrides().then((area) => {
    const plan = planImport(area, parsed.value);
    const dialog = importDialog(importView(plan, state.recording), {
      onConfirm: () => applyImport(plan, area),
      onCancel: () => undefined,
    });
    document.body.append(dialog);
    dialog.showModal();
  });
}

/**
 * Import step five: apply, with an Undo that restores the previous override object
 * wholesale.
 *
 * `previous` is the area the diff was computed against, so Undo puts back
 * exactly the configuration the user was shown — including any key this build
 * does not recognise, and including the *absence* of one the file added. That is
 * what "wholesale" has to mean for the offer to be honest.
 *
 * The freeze comes first: during a recording nothing is applied at all. The confirmed
 * plan is parked, and the service worker applies it when the recording stops —
 * see `features/settings/pending.ts`, and the transition it hangs off in
 * `background/index.ts`.
 */
function applyImport(plan: ImportPlan, previous: Overrides): void {
  if (state.recording) {
    void writePending({ overrides: plan.overrides, changes: plan.changes.length }).then(
      (written) => {
        if (!written.ok) {
          showToast({ message: written.error.message, tone: 'danger' });
          return;
        }
        void refreshPending().then(paint);
        showToast({ message: 'Saved. It will be applied when this recording stops.' });
      },
    );
    return;
  }

  void replaceOverrides(plan.overrides, { keepUnknown: true }).then((written) => {
    if (!written.ok) {
      showToast({ message: written.error.message, tone: 'danger' });
      return;
    }

    void reload().then(() => deliverMachineIfChanged(previous, plan.overrides));
    showToast({
      message:
        plan.changes.length === 1
          ? '1 setting imported.'
          : `${plan.changes.length} settings imported.`,
      tone: 'success',
      undo: () => {
        // No `keepUnknown`: an Undo is an exact restore, and a key the file
        // added has to go with it — and the server has to hear about the
        // restore for the same reason it heard about the import.
        void replaceOverrides(previous).then(() =>
          reload().then(() => deliverMachineIfChanged(plan.overrides, previous)),
        );
      },
    });
  });
}

/**
 * An imported file can move the port, and then it has both sides to answer for.
 *
 * The import is a change like any other, and the three machine-wide settings do
 * not take effect by being stored. A file that names a port and is applied
 * without telling the server leaves the extension posting to a port nothing
 * binds — which is precisely the state the port setting exists to make
 * impossible, arrived at by the one path that does not go through a row.
 *
 * Only when the machine-wide half actually changed: an import that touched none
 * of the three has nothing to deliver, and posting anyway would overwrite a
 * hand-edited `config.json` for no reason.
 */
function deliverMachineIfChanged(before: Overrides, after: Overrides): void {
  const moved = (FIELDS as readonly Field[]).filter(
    (field) =>
      field.machine === true &&
      JSON.stringify((before as Record<string, unknown>)[field.key]) !==
        JSON.stringify((after as Record<string, unknown>)[field.key]),
  );
  void deliverMachine(moved);
}

async function refreshPending(): Promise<void> {
  state.pending = await readPending();
}

function cancelPending(): void {
  void clearPending().then(() => {
    state.pending = null;
    paint();
    showToast({ message: 'The waiting settings file was discarded.' });
  });
}

// ── The MCP connection test ──────────────────────────────────────────────────

/** The action beside a row: a health check, or a push of the machine settings. */
function rowAction(field: Field): void {
  if (isMachineKey(field.key)) void deliverMachine([field]);
  else testConnection(field);
}

function testConnection(field: Field): void {
  if (field.key !== 'mcpServerUrl') return;

  const extra = extraFor(field.key);
  extra.action = mcpAction(true);
  extra.note = { text: 'Checking…', tone: 'busy' };
  paint();

  void checkMcp(state.settings.mcpServerUrl, state.settings['mcp.healthTimeoutMs']).then((health) => {
    extra.action = mcpAction(false);
    extra.note = health.ok
      ? { text: `Connected · ${health.value.service} (${health.value.mode})`, tone: 'success' }
      : { text: health.error.message, tone: 'danger' };
    paint();
  });
}

// ── Wiring ───────────────────────────────────────────────────────────────────

const page = settingsPage(document.body, {
  /**
   * `openOptionsPage` opens settings in a tab of its own, so there is usually no
   * history to go back to and a plain `history.back()` would do nothing at all.
   * The library is the destination that always exists; going back is only right
   * when the user actually navigated here from somewhere.
   */
  onBack: () => {
    if (history.length > 1) history.back();
    else location.href = chrome.runtime.getURL('viewer.html');
  },

  onQuery: (raw) => {
    const { text, filters } = lift(raw, state.query.filters);
    state.query = { text, filters };
    paint();
  },

  onRemoveFilter: (filter: Filter) => {
    state.query = {
      ...state.query,
      filters: state.query.filters.filter((entry) => entry !== filter),
    };
    paint();
  },

  onClearSearch: () => {
    state.query = EMPTY_QUERY;
    paint();
  },

  onResetShown: () => {
    const model = settingsModel({
      settings: state.settings,
      query: state.query,
      advancedOpen: state.advancedOpen,
    });
    resetKeys(model.shownModified);
  },

  onCommit: commit,

  onReset: (field) => resetKeys([field.key as SettingKey]),

  onCopyKey: (field) => {
    void navigator.clipboard
      .writeText(field.key)
      .then(() => showToast({ message: `Copied ${field.key}`, tone: 'success' }))
      // Clipboard access can be refused, and a copy that silently did nothing is
      // worse than one that says it did not happen — the user walks away with a
      // stale key on the clipboard.
      .catch(() => showToast({ message: 'Could not copy to the clipboard.', tone: 'danger' }));
  },

  onAction: rowAction,

  onRail: (id) => {
    state.activeRail = id;
    // Advanced opens when its rail row is used: a rail entry that scrolls to a
    // closed disclosure is a link to a sentence about what you cannot see.
    if (id === 'advanced') state.advancedOpen = true;
    paint();
    document.getElementById(`group-${id}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' });
  },

  onAdvanced: () => {
    state.advancedOpen = !state.advancedOpen;
    paint();
  },

  /*
   * the `{}` toggle, and the two panes.
   *
   * Opening re-seeds the pane from storage — but only when it is clean, which
   * it always is on the first open and is not if the user closed it mid-edit
   * and came back. Losing an unapplied edit to a toggle press would be losing
   * it to a gesture that reads as "show me that again".
   */
  onJson: () => {
    state.json.open = !state.json.open;
    if (state.json.open) syncJsonPane();
    paint();
  },

  onJsonInput: (text) => {
    state.json.text = text;
    paint();
  },

  onJsonRevert: () => {
    state.json.text = state.json.stored;
    paint();
  },

  // Step 1's other half: *or paste into the JSON pane*. Identical five steps.
  onJsonApply: () => reviewImport(state.json.text),

  onImport: () => pickJsonFile((file) => void file.text().then(reviewImport)),
  onExport: exportSettings,
  onCancelPending: cancelPending,
  onResetAll: askResetAll,
  onDeleteFlows: askDeleteFlows,
  onOpenFlow: () => {
    location.href = chrome.runtime.getURL('viewer.html');
  },
});

// ── Start ────────────────────────────────────────────────────────────────────

/*
 * `load()` rather than a read plus a pile of fallback literals.
 *
 * The old shape passed its own defaults to `getSync` at the call site, which
 * meant this screen was one of the places a default lived — and the screen
 * showing 60 while the recorder used 55 is not a bug anyone would notice.
 * `resolve()` is the only validator now, so an unreadable area, a value from a
 * newer version and a hand-edited number all arrive here already usable.
 */
void (async () => {
  state.overrides = await loadOverrides();
  state.settings = resolve(state.overrides);
  syncJsonPane();
  await readRecording();
  await refreshPending();
  await refreshStorage();
  paint();
})();

/*
 * Another tab, the popup, or the recorder changing a setting repaints this one.
 *
 * Through `reload()` rather than taking the resolved settings the subscription
 * hands over, because this screen also holds the *sparse* object — the JSON
 * pane and the export are both that, and a pane still showing the overrides
 * from before another tab's edit is a document somebody could export and send.
 */
subscribe(() => void reload());

// The recording banner, the parked import, and the storage figures a finished
// recording changes.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  const watched = ['recordingActive', 'savedFlowsMeta', PENDING_SETTINGS_KEY];
  if (!watched.some((key) => key in changes)) return;

  void (async () => {
    await readRecording();
    await refreshPending();
    await refreshStorage();
    paint();
  })();
});
