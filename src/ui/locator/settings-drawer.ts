/**
 * The panel's settings drawer: the second view onto the one store.
 *
 * The options page (`settings.html`, `open_in_tab`) is the source of truth and
 * holds every setting there is. This is the other view — the handful a locate
 * actually depends on, inside the panel, so that "pick a component, then change
 * your editor" stays one gesture instead of becoming a tab switch in the middle
 * of it.
 *
 * ## What it is not
 *
 * It is not a second settings screen, and there is nothing in this file that
 * could make it one. Every node it puts on screen comes from `settingsDrawer` in
 * `ui/settings/components.ts` — the same primitive file the options page is
 * built from, the same `settingRow`, the same model — and `npm run
 * lint:settings-ui` is the reason that is a rule rather than a habit. What is
 * left here is what a controller is: read, decide, hand over a model, write
 * back.
 *
 * It is not a second store either. `save()` writes the same sparse dotted keys
 * to the same `chrome.storage.sync` area the page writes, and `subscribe()`
 * brings a change made anywhere else straight back into this list. Two stores
 * would drift; one store and two views cannot.
 *
 * ## The markup it expects
 *
 * The drawer's own chrome — the `<aside>`, its heading, its close button — is
 * the panel's markup, in `src/panel.html`. This file finds four ids and touches
 * nothing else:
 *
 *   - `#settings-drawer` — the aside, opened and closed by its `hidden` property
 *   - `#settings-rows`   — an empty container; everything inside it is built here
 *   - `#settings-close`  — dismisses the drawer
 *   - `#settings-btn`    — the panel's opener
 *
 * Only the second is new. The panel's original drawer hand-wrote a label and an
 * input per setting, plus a `#category-settings` box for the category toggles;
 * none of those survive, because a row the panel drew itself is a row that can
 * disagree with the page's, and the whole point of one store is that they
 * cannot.
 */

import {
  DEFAULTS,
  loadManaged,
  loadOverrides,
  migrateLegacySettings,
  resolve,
  save,
  subscribe,
  type Field,
  type SettingKey,
} from '../../features/settings/index.js';
import { settingsDrawer, type RowAction, type RowNote } from '../settings/components.js';
import { commitProblem, drawerModel, normalise } from '../settings/view.js';

/**
 * The four ids this file reads out of `src/panel.html`.
 *
 * Exported so the panel's own module can address the same elements without a
 * second copy of the strings, and so a rename is a compile error in both places
 * rather than a drawer that silently never opens.
 */
export const DRAWER_IDS = {
  drawer: 'settings-drawer',
  rows: 'settings-rows',
  close: 'settings-close',
  open: 'settings-btn',
} as const;

/** What the panel holds onto: opening, closing, and letting go. */
export interface DrawerController {
  open: () => void;
  close: () => void;
  toggle: () => void;
  isOpen: () => boolean;
  /** Drops the storage subscription. The panel is a page that gets torn down. */
  destroy: () => void;
}

interface Extra {
  note: RowNote | null;
  action: RowAction | null;
}

/**
 * Wire the drawer up, or answer `null` when the panel is not showing one.
 *
 * `null` rather than a throw: the drawer is one region of a panel whose job is
 * picking components, and a missing container should cost the settings, not the
 * picker. The panel logs it; nothing else stops.
 */
export function mountSettingsDrawer(root: Document = document): DrawerController | null {
  const aside = root.getElementById(DRAWER_IDS.drawer);
  const rows = root.getElementById(DRAWER_IDS.rows);
  if (!aside || !rows) return null;

  const state = {
    settings: DEFAULTS,
    managed: new Set<string>() as ReadonlySet<string>,
    extras: new Map<string, Extra>(),
  };

  const view = settingsDrawer(rows, {
    onCommit: (field, value, clamped) => commit(field, value, clamped),
    onReset: (field) => commit(field, DEFAULTS[field.key as SettingKey], null),
    onCopyKey: (field) => void navigator.clipboard?.writeText(field.key),
    // No setting the drawer shows has an action beside it — the two that do are
    // the MCP address and the machine-wide numbers, and neither has anything to
    // do with a pick. The handler exists because `RowHandlers` is one shape for
    // both views, and a view that had to declare its own would be the second
    // vocabulary this whole arrangement is against.
    onAction: () => {},
    onOpenSettings: () => {
      void chrome.runtime.openOptionsPage();
    },
  });

  function extraFor(key: string): Extra {
    const found = state.extras.get(key);
    if (found) return found;
    const created: Extra = { note: null, action: null };
    state.extras.set(key, created);
    return created;
  }

  function paint(): void {
    view.render({ model: drawerModel(state.settings, state.managed), extras: state.extras });
  }

  /**
   * One committed value, saved — optimistically, and put back if the write
   * fails.
   *
   * The same shape the options page uses, for the same reason: waiting for
   * `chrome.storage.sync` before repainting is a checkbox that lags behind the
   * pointer, which reads as the click not having registered. A drawer four
   * inches from the thing being picked is the last place that is affordable.
   */
  function commit(field: Field, raw: unknown, clamped: RowNote | null): void {
    const key = field.key as SettingKey;
    const value = normalise(field, raw);
    const before = state.settings[key];

    const problem = commitProblem(field, value);
    extraFor(field.key).note = problem ? { text: problem, tone: 'danger' } : clamped;

    state.settings = { ...state.settings, [key]: value };
    paint();

    void save({ [key]: value }).then((result) => {
      if (result.ok) return;
      // Reflect the truth: the setting did not change, so neither should the UI.
      state.settings = { ...state.settings, [key]: before };
      extraFor(field.key).note = { text: result.error.message, tone: 'danger' };
      paint();
    });
  }

  async function reload(): Promise<void> {
    const [overrides, managed] = await Promise.all([loadOverrides(), loadManaged()]);
    state.managed = new Set(Object.keys(managed));
    state.settings = resolve(overrides, managed);
    paint();
  }

  /**
   * The opener says whether the thing it opens is open.
   *
   * Written from here rather than from the click handler because the panel opens
   * this drawer from two other places — the first-run strip's `Set project root`
   * and the card's source-lookup advice — and a state kept only where the button
   * is pressed is a state that is wrong every other way in.
   */
  const setExpanded = (open: boolean): void => {
    root.getElementById(DRAWER_IDS.open)?.setAttribute('aria-expanded', String(open));
  };

  const close = (): void => {
    aside.hidden = true;
    setExpanded(false);
  };

  const open = (): void => {
    aside.hidden = false;
    setExpanded(true);
    // Storage is the truth and the drawer has been shut: a value changed on the
    // options page while this panel sat idle should be on screen the moment it
    // opens, not one repaint later.
    void reload();
  };

  root.getElementById(DRAWER_IDS.close)?.addEventListener('click', close);
  root.getElementById(DRAWER_IDS.open)?.addEventListener('click', () => {
    if (aside.hidden) open();
    else close();
  });

  const unsubscribe = subscribe((settings) => {
    state.settings = settings;
    paint();
  });

  /*
   * The migration runs here too, and that is deliberate rather than defensive.
   *
   * Somebody upgrading from the sibling extension opens the panel, because the
   * panel is what they had; they may never open the options page at all. The
   * worker runs it on install and the options page runs it on load, and all
   * three are the same idempotent call — the second and third find nothing left
   * to bring forward and return an empty list.
   */
  void migrateLegacySettings().then(() => reload());

  return {
    open,
    close,
    toggle: () => (aside.hidden ? open() : close()),
    isOpen: () => !aside.hidden,
    destroy: unsubscribe,
  };
}
