import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChainBuffer } from '../src/core/react/chains.js';

const OPTIONS = { size: 4, ttlMs: 5000, timeoutMs: 50 };

afterEach(() => {
  vi.useRealTimers();
});

describe('createChainBuffer', () => {
  it('gives a step the chain for its own event', async () => {
    const buffer = createChainBuffer<string>(OPTIONS);
    buffer.deliver({ eventTime: 100, value: 'Cart', at: 0 });
    buffer.deliver({ eventTime: 200, value: 'Header', at: 0 });

    expect(await buffer.take(200, 0)).toBe('Header');
    expect(await buffer.take(100, 0)).toBe('Cart');
  });

  it('resolves a chain that arrives after the step asked for it', async () => {
    const buffer = createChainBuffer<string>(OPTIONS);
    const pending = buffer.take(100, 0);
    buffer.deliver({ eventTime: 100, value: 'Cart', at: 0 });
    expect(await pending).toBe('Cart');
  });

  it('gives up after the timeout rather than holding the step', async () => {
    vi.useFakeTimers();
    const buffer = createChainBuffer<string>(OPTIONS);
    const pending = buffer.take(100, 0);
    await vi.advanceTimersByTimeAsync(OPTIONS.timeoutMs + 1);
    expect(await pending).toBeNull();
  });

  /*
   * The recorder swallows clicks on a <select> — the `change` step already
   * describes the interaction. The chain for that click is therefore never
   * claimed, and a design that handed out "the most recent chain" would put it
   * on whatever step came next.
   */
  it('never hands an unclaimed chain to a later, unrelated step', async () => {
    const buffer = createChainBuffer<string>(OPTIONS);
    buffer.deliver({ eventTime: 100, value: 'SelectDropdown', at: 0 });

    expect(await buffer.take(999, 0)).toBeNull();
    expect(buffer.pending()).toBe(1);
  });

  /*
   * An input step is written 800 ms after the keystroke that caused it, and more
   * chains arrive in between. It must claim the event that armed its debounce.
   */
  it('serves a debounced step the chain from its own keystroke', async () => {
    const buffer = createChainBuffer<string>(OPTIONS);
    buffer.deliver({ eventTime: 10, value: 'EmailField', at: 0 });
    buffer.deliver({ eventTime: 20, value: 'PasswordField', at: 0 });
    buffer.deliver({ eventTime: 30, value: 'SubmitButton', at: 0 });

    expect(await buffer.take(10, 800)).toBe('EmailField');
  });

  it('drops a chain older than its TTL rather than dating a step wrongly', async () => {
    const buffer = createChainBuffer<string>(OPTIONS);
    buffer.deliver({ eventTime: 100, value: 'Cart', at: 0 });
    expect(await buffer.take(100, OPTIONS.ttlMs + 1)).toBeNull();
  });

  it('expires stale chains as new ones arrive, so nothing accumulates', () => {
    const buffer = createChainBuffer<string>(OPTIONS);
    buffer.deliver({ eventTime: 1, value: 'Old', at: 0 });
    buffer.deliver({ eventTime: 2, value: 'Fresh', at: OPTIONS.ttlMs + 1 });
    expect(buffer.pending()).toBe(1);
  });

  it('keeps the newest chains when it overflows', async () => {
    const buffer = createChainBuffer<string>(OPTIONS);
    for (let i = 1; i <= OPTIONS.size + 2; i++) {
      buffer.deliver({ eventTime: i, value: `C${i}`, at: 0 });
    }
    expect(buffer.pending()).toBe(OPTIONS.size);
    expect(await buffer.take(1, 0)).toBeNull();
    expect(await buffer.take(OPTIONS.size + 2, 0)).toBe(`C${OPTIONS.size + 2}`);
  });

  it('clears everything when a recording stops', async () => {
    vi.useFakeTimers();
    const buffer = createChainBuffer<string>(OPTIONS);
    buffer.deliver({ eventTime: 1, value: 'Cart', at: 0 });
    const pending = buffer.take(2, 0);

    buffer.clear();

    expect(buffer.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(OPTIONS.timeoutMs + 1);
    expect(await pending).toBeNull();
  });
});

/**
 * `event.timeStamp` is the key, and one gesture can produce two steps that both
 * ask for it — a `click` and the `change` it triggers. A single waiter slot let
 * the second overwrite the first, which then timed out with no components.
 */
describe('two steps waiting on one event', () => {
  it('serves both, in the order they asked', async () => {
    const buffer = createChainBuffer<string>({ size: 8, ttlMs: 5000, timeoutMs: 200 });

    const first = buffer.take(42, Date.now());
    const second = buffer.take(42, Date.now());

    buffer.deliver({ eventTime: 42, value: 'a', at: Date.now() });
    buffer.deliver({ eventTime: 42, value: 'b', at: Date.now() });

    expect(await first).toBe('a');
    expect(await second).toBe('b');
  });

  it('still times out the waiter nobody delivered to', async () => {
    const buffer = createChainBuffer<string>({ size: 8, ttlMs: 5000, timeoutMs: 20 });

    const first = buffer.take(7, Date.now());
    const second = buffer.take(7, Date.now());
    buffer.deliver({ eventTime: 7, value: 'only', at: Date.now() });

    expect(await first).toBe('only');
    expect(await second).toBeNull();
  });
});
