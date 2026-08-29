import { describe, expect, it } from 'vitest';
import { arrowHead, isMeaningful, rectOf, type DrawOp } from '../src/ui/viewer/annotate-ops.js';

const op = (over: Partial<DrawOp> = {}): DrawOp => ({
  tool: 'rect',
  colour: '#E5484D',
  width: 4,
  opacity: 1,
  ...over,
});

describe('rectOf', () => {
  it('normalises a drag made in any direction', () => {
    // Dragging up-and-left is as natural as down-and-right, and produced
    // negative dimensions — which `strokeRect` silently draws as nothing.
    const downRight = rectOf(op({ from: { x: 10, y: 20 }, to: { x: 40, y: 60 } }));
    const upLeft = rectOf(op({ from: { x: 40, y: 60 }, to: { x: 10, y: 20 } }));

    expect(downRight).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(upLeft).toEqual(downRight);
  });

  it('survives an operation that was never dragged', () => {
    expect(rectOf(op())).toEqual({ x: 0, y: 0, width: 0, height: 0 });
  });
});

describe('arrowHead', () => {
  it('puts both barbs behind the tip', () => {
    const head = arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 2);

    expect(head.left.x).toBeLessThan(100);
    expect(head.right.x).toBeLessThan(100);
    // Symmetrical about the shaft.
    expect(head.left.y).toBeCloseTo(-head.right.y);
  });

  it('grows with the stroke, but never below a floor', () => {
    // A thick arrow ending in a pinprick reads as a line; a thin one with no
    // floor has no head at all.
    expect(arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 1).length).toBe(15);
    expect(arrowHead({ x: 0, y: 0 }, { x: 100, y: 0 }, 8).length).toBe(40);
  });

  it('follows the direction of the drag', () => {
    const up = arrowHead({ x: 0, y: 100 }, { x: 0, y: 0 }, 2);
    expect(up.left.y).toBeGreaterThan(0);
    expect(up.right.y).toBeGreaterThan(0);
  });
});

describe('isMeaningful', () => {
  it('discards a click that never became a drag', () => {
    // A zero-area shape renders as nothing but would still occupy a slot in the
    // undo stack, so Undo would appear to do nothing.
    expect(isMeaningful(op({ from: { x: 5, y: 5 }, to: { x: 5, y: 5 } }))).toBe(false);
    expect(isMeaningful(op({ from: { x: 5, y: 5 }, to: { x: 6, y: 40 } }))).toBe(false);
    expect(isMeaningful(op({ from: { x: 5, y: 5 }, to: { x: 40, y: 40 } }))).toBe(true);
  });

  it('discards an empty text label', () => {
    expect(isMeaningful(op({ tool: 'text', at: { x: 0, y: 0 }, text: '   ' }))).toBe(false);
    expect(isMeaningful(op({ tool: 'text', at: { x: 0, y: 0 }, text: 'Here' }))).toBe(true);
  });

  it('discards a pen stroke that is a single point', () => {
    expect(isMeaningful(op({ tool: 'pen', points: [{ x: 1, y: 1 }] }))).toBe(false);
    expect(
      isMeaningful(op({ tool: 'pen', points: [{ x: 1, y: 1 }, { x: 2, y: 2 }] })),
    ).toBe(true);
  });

  it('holds a redaction to the same floor as any other rectangle', () => {
    // Nothing special about redact here, and that is the point: a one-pixel
    // "redaction" that hides nothing must not enter the history looking like it
    // did something.
    expect(isMeaningful(op({ tool: 'redact', from: { x: 0, y: 0 }, to: { x: 1, y: 1 } }))).toBe(
      false,
    );
    expect(isMeaningful(op({ tool: 'redact', from: { x: 0, y: 0 }, to: { x: 80, y: 20 } }))).toBe(
      true,
    );
  });
});
