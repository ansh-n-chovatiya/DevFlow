/**
 * The annotation model, and how one is drawn.
 *
 * Separated from the editor's chrome so the geometry — which is the part that
 * can be wrong in ways nobody notices — is pure and tested, and the canvas
 * plumbing is left with nothing to decide.
 */

export type Tool = 'select' | 'pen' | 'rect' | 'ellipse' | 'arrow' | 'highlight' | 'text' | 'redact';

export interface Point {
  x: number;
  y: number;
}

export interface DrawOp {
  tool: Exclude<Tool, 'select'>;
  colour: string;
  width: number;
  opacity: number;
  /** `pen` only. */
  points?: Point[];
  /** Everything dragged: rect, ellipse, arrow, highlight, redact. */
  from?: Point;
  to?: Point;
  /** `text` only. */
  at?: Point;
  text?: string;
  fontSize?: number;
  /** `redact` only — the size of one pixelation block, in image pixels. */
  blockSize?: number;
}

/**
 * The annotation palette.
 *
 * Deliberately *not* design tokens. This ink is baked into a JPEG that leaves
 * the machine and is looked at years later, on top of somebody else's page — it
 * has to stay legible regardless of which theme was active when it was drawn,
 * and it cannot change when the theme does. The values are drawn from the
 * system's data colours so the two still look like one product.
 */
export const INK = [
  { name: 'Red', value: '#E5484D' },
  { name: 'Amber', value: '#D9A441' },
  { name: 'Teal', value: '#2BB3A3' },
  { name: 'Green', value: '#3FB984' },
  { name: 'Blue', value: '#6EA8FF' },
  { name: 'Violet', value: '#A68CF0' },
  { name: 'White', value: '#FFFFFF' },
  { name: 'Black', value: '#101415' },
] as const;

export const DEFAULT_INK = INK[0].value;

/** Stroke widths, as actual pixel values rather than S/M/L initials. */
export const WIDTHS = [2, 4, 8] as const;

/** How coarse the redaction is. Larger blocks are less reversible. */
export const BLOCK_SIZES = [8, 16, 32] as const;
export const DEFAULT_BLOCK_SIZE = 16;

/** A drag in either direction, as a rectangle with positive dimensions. */
export function rectOf(op: DrawOp): { x: number; y: number; width: number; height: number } {
  const from = op.from ?? { x: 0, y: 0 };
  const to = op.to ?? from;

  return {
    x: Math.min(from.x, to.x),
    y: Math.min(from.y, to.y),
    width: Math.abs(to.x - from.x),
    height: Math.abs(to.y - from.y),
  };
}

/**
 * The two barbs of an arrowhead.
 *
 * The head grows with the stroke so a thick arrow does not end in a pinprick,
 * with a floor so a thin one is still an arrow rather than a line.
 */
export function arrowHead(
  from: Point,
  to: Point,
  width: number,
): { left: Point; right: Point; length: number } {
  const length = Math.max(15, width * 5);
  const angle = Math.atan2(to.y - from.y, to.x - from.x);
  const spread = Math.PI / 6;

  return {
    length,
    left: {
      x: to.x - length * Math.cos(angle - spread),
      y: to.y - length * Math.sin(angle - spread),
    },
    right: {
      x: to.x - length * Math.cos(angle + spread),
      y: to.y - length * Math.sin(angle + spread),
    },
  };
}

/**
 * Is this operation worth keeping?
 *
 * A click that does not become a drag produces a zero-area rectangle, which
 * renders as nothing and is invisible in the undo stack — so it never enters it.
 */
export function isMeaningful(op: DrawOp): boolean {
  if (op.tool === 'text') return Boolean(op.text?.trim());
  if (op.tool === 'pen') return (op.points?.length ?? 0) >= 2;

  const rect = rectOf(op);
  return rect.width >= 2 && rect.height >= 2;
}

/** Draw one operation onto a context that already holds the base image. */
export function renderOp(ctx: CanvasRenderingContext2D, op: DrawOp): void {
  ctx.save();
  ctx.globalAlpha = op.opacity;
  ctx.strokeStyle = op.colour;
  ctx.fillStyle = op.colour;
  ctx.lineWidth = op.width;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const rect = rectOf(op);

  switch (op.tool) {
    case 'pen': {
      const points = op.points ?? [];
      if (points.length >= 2) {
        ctx.beginPath();
        ctx.moveTo(points[0].x, points[0].y);
        for (const point of points.slice(1)) ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
      break;
    }

    case 'rect':
      ctx.strokeRect(rect.x, rect.y, rect.width, rect.height);
      break;

    case 'ellipse':
      ctx.beginPath();
      ctx.ellipse(
        rect.x + rect.width / 2,
        rect.y + rect.height / 2,
        rect.width / 2,
        rect.height / 2,
        0,
        0,
        Math.PI * 2,
      );
      ctx.stroke();
      break;

    case 'arrow': {
      const from = op.from ?? { x: 0, y: 0 };
      const to = op.to ?? from;
      const head = arrowHead(from, to, op.width);

      ctx.beginPath();
      ctx.moveTo(from.x, from.y);
      ctx.lineTo(to.x, to.y);
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(head.left.x, head.left.y);
      ctx.moveTo(to.x, to.y);
      ctx.lineTo(head.right.x, head.right.y);
      ctx.stroke();
      break;
    }

    case 'highlight':
      // Multiply so the text underneath still reads, which a flat fill at any
      // opacity does not once the ink is dark.
      ctx.globalAlpha = op.opacity * 0.4;
      ctx.globalCompositeOperation = 'multiply';
      ctx.fillRect(rect.x, rect.y, rect.width, rect.height);
      break;

    case 'text':
      ctx.font = `600 ${op.fontSize ?? 18}px 'IBM Plex Sans', system-ui, sans-serif`;
      ctx.textBaseline = 'top';
      // A label lands on whatever the page was showing, so it carries its own
      // contrast rather than hoping the pixels behind it are kind.
      ctx.shadowColor = 'rgb(0 0 0 / 65%)';
      ctx.shadowBlur = 4;
      ctx.fillText(op.text ?? '', op.at?.x ?? 0, op.at?.y ?? 0);
      break;

    case 'redact':
      pixelate(ctx, rect, op.blockSize ?? DEFAULT_BLOCK_SIZE);
      break;
  }

  ctx.restore();
}

/**
 * Destroy a region by scaling it down and back up with smoothing off.
 *
 * This is the highest-stakes operation in the product: it is what stops a
 * password or a customer's address reaching an AI. It rewrites pixels rather
 * than covering them, so the original is not recoverable from the exported JPEG.
 */
function pixelate(
  ctx: CanvasRenderingContext2D,
  rect: { x: number; y: number; width: number; height: number },
  blockSize: number,
): void {
  if (rect.width < 2 || rect.height < 2) return;

  const columns = Math.max(1, Math.round(rect.width / blockSize));
  const rows = Math.max(1, Math.round(rect.height / blockSize));

  const scratch = document.createElement('canvas');
  scratch.width = columns;
  scratch.height = rows;

  const scratchCtx = scratch.getContext('2d');
  if (!scratchCtx) return;

  scratchCtx.drawImage(ctx.canvas, rect.x, rect.y, rect.width, rect.height, 0, 0, columns, rows);

  ctx.globalAlpha = 1;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scratch, 0, 0, columns, rows, rect.x, rect.y, rect.width, rect.height);
}
