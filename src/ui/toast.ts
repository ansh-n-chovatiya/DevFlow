/**
 * Toasts: something finished, and here is the chance to take it back.
 *
 * Shared so that "Flow deleted" behaves identically wherever it is raised. The
 * countdown hairline is not decoration — an Undo with no visible deadline is a
 * promise the UI cannot keep.
 */

import { icon, type IconName } from './icons.js';

/** How long a toast stays before dismissing itself. */
export const TOAST_MS = 6000;

export interface ToastOptions {
  message: string;
  tone?: 'neutral' | 'success' | 'danger';
  /** Adding this turns the toast into an offer, so it gets the countdown. */
  undo?: () => void;
  durationMs?: number;
}

const TONE_ICON: Record<NonNullable<ToastOptions['tone']>, IconName> = {
  neutral: 'info',
  success: 'circle-check',
  danger: 'circle-x',
};

function container(): HTMLElement {
  const existing = document.getElementById('toasts');
  if (existing) return existing;

  const created = document.createElement('div');
  created.className = 'toasts';
  created.id = 'toasts';
  document.body.append(created);
  return created;
}

export function showToast({
  message,
  tone = 'neutral',
  undo,
  durationMs = TOAST_MS,
}: ToastOptions): void {
  const toast = document.createElement('div');
  toast.className = `toast toast--${tone}`;
  toast.setAttribute('role', 'status');

  const glyph = icon(TONE_ICON[tone], 'icon toast__icon');

  const text = document.createElement('span');
  text.className = 'toast__message';
  text.textContent = message;

  toast.append(glyph, text);

  /**
   * The auto-dismiss timeout is deliberately not cancelled when the user
   * dismisses first: removing an already-detached node does nothing, so the
   * stray timer costs one no-op and saves a mutable handle.
   */
  const dismiss = (): void => toast.remove();

  if (undo) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'btn btn--ghost btn--compact';
    button.textContent = 'Undo';
    button.addEventListener('click', () => {
      undo();
      dismiss();
    });
    toast.append(button);

    const progress = document.createElement('div');
    progress.className = 'toast__progress';
    // The keyframes carry the shape; only the deadline belongs to the instance.
    progress.style.animationDuration = `${durationMs}ms`;
    toast.append(progress);
  } else {
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'btn btn--ghost btn--icon btn--compact';
    close.setAttribute('aria-label', 'Dismiss');
    close.append(icon('x'));
    close.addEventListener('click', dismiss);
    toast.append(close);
  }

  container().append(toast);
  setTimeout(dismiss, durationMs);
}
