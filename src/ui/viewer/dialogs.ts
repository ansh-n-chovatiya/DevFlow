/**
 * The two questions the viewer asks: "are you sure?" and "call it what?".
 *
 * Both are `<dialog>`, so Escape, focus trapping and the top layer are the
 * platform's job. Both resolve rather than taking a callback, because every
 * caller is already inside an async action and a promise keeps the decision on
 * the line where it is made.
 */

import { el } from './dom.js';

export interface ConfirmOptions {
  title: string;
  body: string;
  /** The destructive verb, repeated on the button. Never "OK". */
  confirmLabel: string;
  /** Neutral confirmations exist too — renaming does not need a crimson button. */
  tone?: 'danger' | 'primary';
}

export function confirm({ title, body, confirmLabel, tone = 'danger' }: ConfirmOptions): Promise<boolean> {
  const dialog = el<HTMLDialogElement>('confirm-dialog');
  const ok = el<HTMLButtonElement>('confirm-ok');

  el('confirm-title').textContent = title;
  el('confirm-body').textContent = body;
  ok.textContent = confirmLabel;
  ok.className = `btn btn--${tone}`;

  return new Promise((resolve) => {
    // Cleared before every open. `returnValue` is only written when a *button*
    // closes the dialog, so dismissing with Escape leaves whatever the last
    // answer was — and these dialogs are shared elements. Having once confirmed
    // a deletion, pressing Escape on the next one read as "yes" and deleted the
    // flow the user had just decided to keep.
    dialog.returnValue = '';
    dialog.addEventListener(
      'close',
      () => resolve(dialog.returnValue === 'ok'),
      { once: true },
    );
    dialog.showModal();
  });
}

export interface NameOptions {
  title: string;
  label: string;
  value: string;
  confirmLabel: string;
}

/** Resolves to the trimmed name, or `null` if the dialog was dismissed. */
export function askName({ title, label, value, confirmLabel }: NameOptions): Promise<string | null> {
  const dialog = el<HTMLDialogElement>('name-dialog');
  const input = el<HTMLInputElement>('name-input');

  el('name-title').textContent = title;
  el('name-label').textContent = label;
  el('name-ok').textContent = confirmLabel;
  input.value = value;

  return new Promise((resolve) => {
    // See `confirm` — a dismissed dialog must not inherit the last answer.
    dialog.returnValue = '';
    dialog.addEventListener(
      'close',
      () => {
        const name = input.value.trim();
        resolve(dialog.returnValue === 'ok' && name ? name : null);
      },
      { once: true },
    );

    dialog.showModal();
    input.select();
  });
}
