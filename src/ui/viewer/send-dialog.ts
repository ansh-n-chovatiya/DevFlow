/**
 * One dialog in front of "Send to Claude".
 *
 * The button used to POST the whole recording the moment it was pressed, which
 * is the same mistake the three export buttons made before decision B: the
 * choice existed, it was just made for you. This is the export dialog with the
 * parts that do not apply to a wire removed — no formats, no filename — and the
 * sizes restated in the currency this destination is spent in.
 *
 * It shares `tpl-include` and the `.includes` rules with the export dialog on
 * purpose. Two dialogs that ask the same question should not look like two
 * questions.
 */

import { sendFlow, type SendResult } from '../../features/mcp/send.js';
import { openingOptions, sendDefaults } from '../../features/export/defaults.js';
import { load as loadSettings } from '../../features/settings/index.js';
import { getLocal, setLocal } from '../../chrome/storage.js';
import { banner } from '../settings/components.js';
import { flowHost } from '../../core/flow/index.js';
import type { ExportOptions, FlowReact, Overrides, Step } from '../../shared/types.js';
import { formatBytes, formatTokenCount, formatTokens } from '../format.js';
import { setIcon } from '../icons.js';
import { showToast } from '../toast.js';
import { clone, el, find, show } from './dom.js';
import { driftFromDefaults, type IncludeRow } from './export-view.js';
import { deriveSendView, type SendView } from './send-view.js';

const dom = {
  dialog: el<HTMLDialogElement>('send-dialog'),
  subtitle: el('send-subtitle'),
  close: el<HTMLButtonElement>('send-close'),
  includes: el('send-includes'),
  defaults: el('send-defaults'),
  note: el('send-note'),
  warning: el('send-warning'),
  context: el('send-context'),
  total: el('send-total'),
  cancel: el<HTMLButtonElement>('send-cancel'),
  run: el<HTMLButtonElement>('send-run'),
  runIcon: el('send-run-icon'),
  runLabel: el('send-run-label'),
};

interface Session {
  steps: Step[];
  name: string;
  id: string | undefined;
  options: ExportOptions;
  busy: boolean;
  /** An archived flow's frozen table. Absent for the live recording, whose
   *  table `sendFlow` reads back itself after its final resolve pass. */
  react: FlowReact | undefined;
  /** When the flow was recorded, so a re-send is not dated to the re-send. */
  recordedAt: number | undefined;
  /** An archived flow's stamp; `undefined` for the live recording, whose stamp
   *  `sendFlow` reads from storage. */
  settings: Overrides | undefined;
  /** What `export.send*` says this dialog opens on — see the export dialog. */
  configured: ExportOptions;
}

let session: Session | null = null;

/** What `export.send*` said when this dialog's memory was written. */
const AGAINST_KEY = 'sendOptionsAgainst';

function paint(): void {
  if (!session) return;

  const view = deriveSendView({
    steps: session.steps,
    options: session.options,
    react: session.react,
    // Both feed the context estimate, which is the walkthrough rendered rather
    // than guessed: the stamp supplies the body and console caps it is rendered
    // under, and the name is its title line.
    settings: session.settings,
    name: session.name,
    busy: session.busy,
  });

  const host = flowHost(session.steps);
  dom.subtitle.textContent = [
    `${session.steps.length} ${session.steps.length === 1 ? 'step' : 'steps'}`,
    host,
  ]
    .filter(Boolean)
    .join(' · ');

  dom.includes.replaceChildren(...view.includes.map((row) => buildInclude(row, view)));
  paintDefaults();

  show(dom.note, view.note !== null);
  dom.note.textContent = view.note ?? '';

  show(dom.warning, view.warnBodies);

  dom.context.textContent = `~${formatTokens(view.context)} tokens of context`;
  dom.total.textContent = `Upload ${formatBytes(view.total)}`;

  dom.run.disabled = !view.canSend;
  dom.runLabel.textContent = view.busy ? 'Sending…' : 'Send';
  setIcon(dom.runIcon, view.busy ? 'loader-circle' : 'sparkles');
  dom.cancel.disabled = view.busy;
}

/**
 * "Not your defaults", and the way back — the export dialog's own, verbatim.
 *
 * Same primitive, same wording function, same action. The two dialogs ask the
 * same question about the same four switches, and answering it two ways in two
 * places is precisely the drift the shared primitives exist to stop.
 */
function paintDefaults(): void {
  if (!session) return;

  const drift = driftFromDefaults(session.options, session.configured);

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

async function useDefaults(): Promise<void> {
  const active = session;
  if (!active || active.busy) return;

  active.options = { ...active.configured };
  await setLocal({ sendOptions: active.options, [AGAINST_KEY]: active.configured });
  if (session === active) paint();
}

/**
 * What each part costs once it is over there.
 *
 * Screenshots are the one that surprises people: they are the biggest upload by
 * far and the cheapest to keep, because the server writes them to disk and
 * Claude only pays for the ones it opens.
 */
const NOTE: Record<keyof ExportOptions, string> = {
  images: 'Saved to disk; read on demand',
  network: 'Read with the steps',
  logs: 'Read with the steps',
  // Kept to the length of the other three: it sits beside the longest label,
  // and the value it describes is already in that label.
  react: 'Read with the steps',
};

/**
 * The row's second line: what this part is, and — for screenshots — what it
 * costs to read.
 *
 * The image figure was a third line in the footer, under the upload and the
 * context. Three stacked mono lines read as a paragraph rather than a summary,
 * and they left the buttons beside them floating against the middle of a block
 * they had nothing to do with.
 *
 * It belongs here anyway. Every other per-part number in this dialog is on the
 * part's own row — `3.6 MB`, `312 KB` — and this is the same kind of fact about
 * the same part, next to the switch the person is actually deciding about. The
 * footer goes back to being the total and the actions.
 */
function noteFor(row: IncludeRow, view: SendView): string {
  if (row.id !== 'images' || view.vision === null) return NOTE[row.id];
  // Not gated on the switch, like the size beside it: a row has to say what
  // turning it on would cost, or the switch is a decision made blind.
  return `Saved to disk · ~${formatTokenCount(view.vision.tokens)} if opened`;
}

function buildInclude(row: IncludeRow, view: SendView): HTMLElement {
  const node = clone<HTMLLabelElement>('tpl-include');

  node.dataset.ignored = String(row.ignored !== null);

  const input = find<HTMLInputElement>(node, '.include__input');
  input.checked = row.checked;
  input.disabled = row.ignored !== null || (session?.busy ?? false);

  find(node, '.include__label').textContent = row.label;
  // The ignored reason wins when there is one: "no React was recorded" is the
  // answer to the question the note would otherwise be answering.
  const note = find(node, '.include__note');
  note.textContent = row.ignored ?? noteFor(row, view);
  // The note is one line and truncates; the title is what a narrow dialog owes
  // whoever wants the rest of the sentence.
  note.title = note.textContent;
  find(node, '.include__size').textContent = row.ignored ? '—' : formatBytes(row.bytes);

  input.addEventListener('change', () => {
    if (!session) return;
    session.options = { ...session.options, [row.id]: input.checked };
    // The choice and the defaults it was made against, in one write — see the
    // export dialog.
    void setLocal({ sendOptions: session.options, [AGAINST_KEY]: session.configured });
    paint();
  });

  return node;
}

// ── Wiring ───────────────────────────────────────────────────────────────────

dom.close.addEventListener('click', () => dom.dialog.close());
dom.cancel.addEventListener('click', () => dom.dialog.close());
dom.run.addEventListener('click', () => void run());

/**
 * Escape must not cancel an upload in flight.
 *
 * `fetch` carries on after the dialog closes, and the server would store a flow
 * whose id nothing on screen is waiting to report.
 */
dom.dialog.addEventListener('cancel', (event) => {
  if (session?.busy) event.preventDefault();
});

async function run(): Promise<void> {
  if (!session || session.busy) return;

  session.busy = true;
  paint();

  const sent = await sendFlow(
    session.name,
    session.steps,
    session.id,
    session.options,
    session.react,
    session.recordedAt,
    session.settings,
  );

  session.busy = false;
  paint();

  if (!sent.ok) {
    showToast({ message: sent.error.message, tone: 'danger', durationMs: 8000 });
    return;
  }

  dom.dialog.close();
  report(sent.value);
}

function report(result: SendResult): void {
  showToast({
    message: result.prompt
      ? 'Flow sent. The prompt is on your clipboard — paste it into Claude.'
      : `Flow sent as ${result.id}. Chrome refused the clipboard, so ask Claude for that id.`,
    tone: 'success',
    durationMs: 8000,
  });
}

export interface OpenSendOptions {
  steps: Step[];
  name: string;
  /** The saved flow's id, so a re-send overwrites rather than piling up. */
  id?: string;
  /** An archived flow's frozen component table; omitted for the recording. */
  react?: FlowReact | null;
  /** The flow's own recording time. The server prints it and orders by it. */
  recordedAt?: number | null;
  /** An archived flow's settings stamp. Absent for the live recording. */
  settings?: Overrides | null;
}

export function openSend({ steps, name, id, react, recordedAt, settings }: OpenSendOptions): void {
  if (steps.length === 0) {
    showToast({ message: 'There is nothing to send yet.' });
    return;
  }

  void (async () => {
    const [stored, settingsNow] = await Promise.all([
      getLocal(['sendOptions', AGAINST_KEY]),
      loadSettings(),
    ]);
    const configured = sendDefaults(settingsNow);

    session = {
      steps,
      name,
      id,
      configured,
      options: openingOptions(
        configured,
        stored.ok ? stored.value.sendOptions : undefined,
        stored.ok ? stored.value.sendOptionsAgainst : undefined,
      ),
      busy: false,
      react: react ?? undefined,
      recordedAt: recordedAt ?? undefined,
      settings: settings ?? undefined,
    };

    paint();
    dom.dialog.showModal();
  })();
}
