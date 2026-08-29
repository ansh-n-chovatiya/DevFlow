import { afterEach, describe, expect, it, vi } from 'vitest';
import { reloadAndWait } from '../src/chrome/tabs.js';

/**
 * A minimal `chrome.tabs` that lets a test drive `onUpdated` by hand, which is
 * the only thing `reloadAndWait` is waiting on.
 */
function stubTabs(reload: () => Promise<void> = () => Promise.resolve()) {
  const listeners = new Set<(id: number, info: { status?: string }) => void>();

  const chrome = {
    tabs: {
      reload: vi.fn(reload),
      onUpdated: {
        addListener: (fn: (id: number, info: { status?: string }) => void) => listeners.add(fn),
        removeListener: (fn: (id: number, info: { status?: string }) => void) =>
          listeners.delete(fn),
      },
    },
  };

  (globalThis as { chrome?: unknown }).chrome = chrome;

  return {
    chrome,
    emit(id: number, status: string) {
      for (const fn of [...listeners]) fn(id, { status });
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

afterEach(() => {
  delete (globalThis as { chrome?: unknown }).chrome;
  vi.useRealTimers();
});

describe('reloadAndWait', () => {
  it('resolves once the new document has finished loading', async () => {
    const tabs = stubTabs();
    let settled = false;
    const waiting = reloadAndWait(7, 10_000).then(() => {
      settled = true;
    });

    expect(tabs.chrome.tabs.reload).toHaveBeenCalledWith(7);

    tabs.emit(7, 'loading');
    await Promise.resolve();
    expect(settled).toBe(false);

    tabs.emit(7, 'complete');
    await waiting;
    expect(settled).toBe(true);
  });

  it('ignores a stale complete from a load already in flight', async () => {
    const tabs = stubTabs();
    let settled = false;
    void reloadAndWait(7, 10_000).then(() => {
      settled = true;
    });

    // The tab was mid-load when the popup opened: this `complete` belongs to the
    // outgoing document, and starting a recording on it is the double-navigation
    // step bug this guard exists for.
    tabs.emit(7, 'complete');
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('ignores other tabs', async () => {
    const tabs = stubTabs();
    let settled = false;
    void reloadAndWait(7, 10_000).then(() => {
      settled = true;
    });

    tabs.emit(9, 'loading');
    tabs.emit(9, 'complete');
    await Promise.resolve();
    expect(settled).toBe(false);
  });

  it('gives up after the timeout rather than blocking Start forever', async () => {
    vi.useFakeTimers();
    const tabs = stubTabs();
    let settled = false;
    const waiting = reloadAndWait(7, 5_000).then(() => {
      settled = true;
    });

    tabs.emit(7, 'loading');
    await vi.advanceTimersByTimeAsync(5_000);
    await waiting;
    expect(settled).toBe(true);
  });

  it('unsubscribes once settled, so a later load cannot resolve it twice', async () => {
    const tabs = stubTabs();
    const waiting = reloadAndWait(7, 10_000);

    tabs.emit(7, 'loading');
    tabs.emit(7, 'complete');
    await waiting;

    expect(tabs.listenerCount).toBe(0);
  });

  it('resolves when the reload itself is refused', async () => {
    const tabs = stubTabs(() => Promise.reject(new Error('No tab with id: 7')));
    await expect(reloadAndWait(7, 10_000)).resolves.toBeUndefined();
    expect(tabs.listenerCount).toBe(0);
  });
});
