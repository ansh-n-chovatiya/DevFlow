/**
 * The screenshot annotation editor.
 *
 * Prompt 7 is the one screen with no usable design frame — every generated
 * annotation-editor screen carries the wrong product name — so this is built
 * from the prompt text and the audit's complaints about the version it replaces:
 *
 *   - seven tools as wide text buttons in a row, one of them an invented
 *     abbreviation ("Hi-lite"), with the toolbar wrapping so that Undo, Save and
 *     Cancel landed on a detached second row;
 *   - the **Blur** tool — the PII control, the highest-stakes thing in the
 *     product — as the sixth text button, looking exactly like the other six;
 *   - raw iOS system colours unrelated to the theme, including a white swatch
 *     invisible against a white panel;
 *   - no zoom, no fit;
 *   - inline rather than modal, so opening it shoved the page around.
 *
 * All five are addressed: an icon rail with Redact in its own group and its own
 * tint, a properties panel, zoom and fit, and a full-screen `<dialog>`.
 */

import { SCREENSHOT_QUALITY } from '../../shared/constants.js';
import { load as loadSettings } from '../../features/settings/index.js';
import type { Step } from '../../shared/types.js';
import { hydrateIcons, icon, type IconName } from '../icons.js';
import { showToast } from '../toast.js';
import {
  BLOCK_SIZES,
  DEFAULT_BLOCK_SIZE,
  DEFAULT_INK,
  INK,
  WIDTHS,
  isMeaningful,
  renderOp,
  type DrawOp,
  type Point,
  type Tool,
} from './annotate-ops.js';
import { confirm } from './dialogs.js';
import { el, show } from './dom.js';

const dom = {
  dialog: el<HTMLDialogElement>('annotate-dialog'),
  title: el('annotate-title'),
  action: el('annotate-action'),
  cancel: el<HTMLButtonElement>('annotate-cancel'),
  save: el<HTMLButtonElement>('annotate-save'),

  tools: el('annotate-tools'),
  stage: el('annotate-stage'),
  canvas: el<HTMLCanvasElement>('annotate-canvas'),

  inkProps: el('annotate-ink'),
  swatches: el('annotate-swatches'),
  widths: el('annotate-widths'),
  opacity: el<HTMLInputElement>('annotate-opacity'),
  redactProps: el('annotate-redact-props'),
  block: el<HTMLInputElement>('annotate-block'),

  zoomOut: el<HTMLButtonElement>('annotate-zoom-out'),
  zoomIn: el<HTMLButtonElement>('annotate-zoom-in'),
  zoomLabel: el('annotate-zoom'),
  fit: el<HTMLButtonElement>('annotate-fit'),
  undo: el<HTMLButtonElement>('annotate-undo'),
  redo: el<HTMLButtonElement>('annotate-redo'),
};

interface ToolSpec {
  id: Tool;
  icon: IconName;
  label: string;
  hint: string;
  /** Redact is its own group, below a divider. */
  separated?: boolean;
}

const TOOLS: ToolSpec[] = [
  { id: 'select', icon: 'mouse-pointer', label: 'Select', hint: 'V' },
  { id: 'pen', icon: 'pen-tool', label: 'Pen', hint: 'P' },
  { id: 'rect', icon: 'square', label: 'Rectangle', hint: 'R' },
  { id: 'ellipse', icon: 'circle', label: 'Ellipse', hint: 'O' },
  { id: 'arrow', icon: 'arrow-up-right', label: 'Arrow', hint: 'A' },
  { id: 'highlight', icon: 'highlighter', label: 'Highlight', hint: 'H' },
  { id: 'text', icon: 'type', label: 'Text', hint: 'T' },
  {
    id: 'redact',
    icon: 'eye-off',
    label: 'Redact — pixelates the area so it never leaves your machine',
    hint: 'X',
    separated: true,
  },
];

const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3];

interface Session {
  onSave: (screenshot: string) => void;
  base: HTMLImageElement;
  done: DrawOp[];
  undone: DrawOp[];
  active: DrawOp | null;
  tool: Tool;
  colour: string;
  width: number;
  opacity: number;
  blockSize: number;
  zoom: number;
}

let session: Session | null = null;

// ── Drawing ──────────────────────────────────────────────────────────────────

function context(): CanvasRenderingContext2D | null {
  return dom.canvas.getContext('2d');
}

function redraw(): void {
  const ctx = context();
  if (!session || !ctx || !dom.canvas.width) return;

  ctx.clearRect(0, 0, dom.canvas.width, dom.canvas.height);
  if (session.base.complete && session.base.naturalWidth) ctx.drawImage(session.base, 0, 0);

  for (const op of session.done) renderOp(ctx, op);
  if (session.active) renderOp(ctx, session.active);
}

/** Screen coordinates to image coordinates, whatever the zoom is. */
function pointAt(event: PointerEvent): Point {
  const rect = dom.canvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * (dom.canvas.width / rect.width),
    y: (event.clientY - rect.top) * (dom.canvas.height / rect.height),
  };
}

function applyZoom(): void {
  if (!session) return;

  dom.canvas.style.width = `${Math.round(dom.canvas.width * session.zoom)}px`;
  dom.canvas.style.height = 'auto';
  dom.zoomLabel.textContent = `${Math.round(session.zoom * 100)}%`;
}

/** The zoom at which the whole screenshot is visible in the stage. */
function fitZoom(): number {
  const available = dom.stage.parentElement?.clientWidth ?? dom.canvas.width;
  if (!dom.canvas.width) return 1;
  return Math.min(1, (available - 48) / dom.canvas.width);
}

// ── Chrome ───────────────────────────────────────────────────────────────────

function paintTools(): void {
  if (!session) return;

  dom.tools.replaceChildren();

  for (const spec of TOOLS) {
    if (spec.separated) {
      const divider = document.createElement('hr');
      divider.className = 'divider';
      dom.tools.append(divider);
    }

    const button = document.createElement('button');
    button.type = 'button';
    button.className = spec.id === 'redact' ? 'tool tool--redact' : 'tool';
    button.setAttribute('aria-pressed', String(spec.id === session.tool));
    button.setAttribute('aria-label', spec.label);
    button.title = `${spec.label}  ·  ${spec.hint}`;
    button.append(icon(spec.icon));
    button.addEventListener('click', () => selectTool(spec.id));

    dom.tools.append(button);
  }
}

function paintProps(): void {
  if (!session) return;

  const redacting = session.tool === 'redact';
  show(dom.inkProps, !redacting);
  show(dom.redactProps, redacting);

  for (const swatch of dom.swatches.querySelectorAll<HTMLElement>('.swatch')) {
    swatch.setAttribute('aria-checked', String(swatch.dataset.ink === session.colour));
  }
  for (const option of dom.widths.querySelectorAll<HTMLElement>('.segmented__option')) {
    option.setAttribute('aria-pressed', String(Number(option.dataset.width) === session.width));
  }
}

function paintHistory(): void {
  if (!session) return;
  dom.undo.disabled = session.done.length === 0;
  dom.redo.disabled = session.undone.length === 0;
}

function selectTool(tool: Tool): void {
  if (!session) return;
  session.tool = tool;
  dom.canvas.dataset.tool = tool;
  paintTools();
  paintProps();
}

function buildSwatches(): void {
  dom.swatches.replaceChildren(
    ...INK.map((entry) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'swatch';
      button.dataset.ink = entry.value;
      button.setAttribute('role', 'radio');
      button.setAttribute('aria-label', entry.name);
      button.title = entry.name;
      // Set here rather than in CSS: this ink is baked into an exported image
      // and must not follow the theme. See annotate-ops.ts.
      button.style.background = entry.value;
      button.addEventListener('click', () => {
        if (!session) return;
        session.colour = entry.value;
        paintProps();
      });
      return button;
    }),
  );
}

function buildWidths(): void {
  dom.widths.replaceChildren(
    ...WIDTHS.map((width) => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'segmented__option';
      button.dataset.width = String(width);
      button.setAttribute('aria-label', `${width} pixel stroke`);

      // The preview is the stroke itself. "S / M / L" told you the order and
      // nothing about the result.
      const preview = document.createElement('span');
      preview.className = 'width-preview';
      preview.style.height = `${width}px`;
      button.append(preview);

      button.addEventListener('click', () => {
        if (!session) return;
        session.width = width;
        paintProps();
      });

      return button;
    }),
  );
}

// ── Text tool ────────────────────────────────────────────────────────────────

function placeText(at: Point, event: PointerEvent): void {
  if (!session) return;

  const wrap = dom.stage;
  const bounds = wrap.getBoundingClientRect();

  const input = document.createElement('input');
  input.className = 'editor__text';
  input.style.left = `${event.clientX - bounds.left}px`;
  input.style.top = `${event.clientY - bounds.top}px`;
  wrap.append(input);
  input.focus();

  let done = false;
  const finish = (commit: boolean): void => {
    if (done) return;
    done = true;

    const text = input.value.trim();
    input.remove();
    if (!commit || !text || !session) return;

    push({
      tool: 'text',
      colour: session.colour,
      width: session.width,
      opacity: session.opacity,
      at,
      text,
      fontSize: Math.max(14, session.width * 6),
    });
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (keyEvent) => {
    keyEvent.stopPropagation();
    if (keyEvent.key === 'Enter') finish(true);
    if (keyEvent.key === 'Escape') finish(false);
  });
}

function push(op: DrawOp): void {
  if (!session || !isMeaningful(op)) return;

  session.done.push(op);
  // A new mark ends the redo branch, as it does in every editor.
  session.undone = [];
  paintHistory();
  redraw();
}

// ── Pointer ──────────────────────────────────────────────────────────────────

dom.canvas.addEventListener('pointerdown', (event) => {
  if (!session || session.tool === 'select') return;
  event.preventDefault();

  const at = pointAt(event);

  if (session.tool === 'text') {
    placeText(at, event);
    return;
  }

  dom.canvas.setPointerCapture(event.pointerId);

  session.active =
    session.tool === 'pen'
      ? {
          tool: 'pen',
          colour: session.colour,
          width: session.width,
          opacity: session.opacity,
          points: [at],
        }
      : {
          tool: session.tool,
          colour: session.colour,
          width: session.width,
          opacity: session.opacity,
          from: at,
          to: at,
          blockSize: session.blockSize,
        };
});

dom.canvas.addEventListener('pointermove', (event) => {
  if (!session?.active) return;

  const at = pointAt(event);
  if (session.active.tool === 'pen') session.active.points?.push(at);
  else session.active.to = at;

  redraw();
});

function endStroke(): void {
  if (!session?.active) return;
  const op = session.active;
  session.active = null;
  push(op);
  redraw();
}

dom.canvas.addEventListener('pointerup', endStroke);
dom.canvas.addEventListener('pointercancel', endStroke);

// ── Controls ─────────────────────────────────────────────────────────────────

dom.opacity.addEventListener('input', () => {
  if (session) session.opacity = Number(dom.opacity.value) / 100;
});

dom.block.addEventListener('input', () => {
  if (session) session.blockSize = Number(dom.block.value);
});

dom.undo.addEventListener('click', () => {
  const op = session?.done.pop();
  if (!session || !op) return;
  session.undone.push(op);
  paintHistory();
  redraw();
});

dom.redo.addEventListener('click', () => {
  const op = session?.undone.pop();
  if (!session || !op) return;
  session.done.push(op);
  paintHistory();
  redraw();
});

function stepZoom(direction: 1 | -1): void {
  if (!session) return;

  const { zoom } = session;
  const nearest = ZOOM_STEPS.reduce((best, value) =>
    Math.abs(value - zoom) < Math.abs(best - zoom) ? value : best,
  );
  const next = ZOOM_STEPS[ZOOM_STEPS.indexOf(nearest) + direction];
  if (next === undefined) return;

  session.zoom = next;
  applyZoom();
}

dom.zoomIn.addEventListener('click', () => stepZoom(1));
dom.zoomOut.addEventListener('click', () => stepZoom(-1));
dom.fit.addEventListener('click', () => {
  if (!session) return;
  session.zoom = fitZoom();
  applyZoom();
});

dom.cancel.addEventListener('click', () => void close());
dom.save.addEventListener('click', () => save());

/** Escape goes through the same unsaved-changes question as Cancel. */
dom.dialog.addEventListener('cancel', (event) => {
  event.preventDefault();
  void close();
});

dom.dialog.addEventListener('keydown', (event) => {
  if (!session) return;

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save();
    return;
  }

  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    (event.shiftKey ? dom.redo : dom.undo).click();
    return;
  }

  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if ((event.target as HTMLElement).tagName === 'INPUT') return;

  const tool = TOOLS.find((spec) => spec.hint.toLowerCase() === event.key.toLowerCase());
  if (tool) {
    event.preventDefault();
    selectTool(tool.id);
  }
});

async function close(): Promise<void> {
  if (session && session.done.length > 0) {
    const agreed = await confirm({
      title: 'Discard annotations?',
      body: 'Your markup on this screenshot will be lost.',
      confirmLabel: 'Discard',
    });
    if (!agreed) return;
  }

  session = null;
  dom.dialog.close();
}

function save(): void {
  if (!session) return;

  session.active = null;
  redraw();

  const { onSave } = session;
  try {
    // Re-encoded as JPEG at the capture quality: the annotated image replaces
    // the one in storage, and a PNG of a full page would multiply its size
    // against a 10 MB ceiling.
    //
    // The *live* `screenshots.quality`, not the recording's frozen one:
    // annotating is something the user is doing now, to a picture that already
    // exists. The freeze governs what a recording captured, and this is not
    // capture. Read when the editor opened — see `quality` below — so a save
    // cannot block on storage.
    onSave(dom.canvas.toDataURL('image/jpeg', quality / 100));
  } catch {
    showToast({ message: 'Chrome wouldn’t save that image.', tone: 'danger' });
    return;
  }

  session = null;
  dom.dialog.close();
  showToast({ message: 'Screenshot updated.', tone: 'success', durationMs: 3000 });
}

// ── Opening ──────────────────────────────────────────────────────────────────

export interface OpenAnnotateOptions {
  step: Step;
  number: number;
  onSave: (screenshot: string) => void;
}

/**
 * The JPEG quality a save re-encodes at.
 *
 * The compiled-in default until the read below lands, which is the same answer
 * every other surface starts from: a `let` re-read each time the editor opens,
 * never a value copied out of it at module scope.
 */
let quality = SCREENSHOT_QUALITY;

export function openAnnotate({ step, number, onSave }: OpenAnnotateOptions): void {
  // Refreshed per open rather than subscribed to: the editor is modal and short
  // lived, and a quality that changed while a box was being drawn would only be
  // a surprise.
  void loadSettings().then((settings) => {
    quality = settings['screenshots.quality'];
  });

  /*
   * The image as it stands, not the pristine capture.
   *
   * Re-opening on `screenshotOriginal` avoided stacking markup, but it also
   * discarded it: a step redacted in one session came back un-redacted in the
   * next, and saving an arrow on top of it wrote the readable image back — so a
   * hidden email address reappeared and was exported and sent on. Annotations
   * are flattened into the JPEG rather than kept as operations, so there is no
   * third option that both re-renders cleanly and preserves the redaction.
   * Markup that stacks is a cosmetic cost; a redaction that silently comes undone
   * is not. `screenshotOriginal` stays untouched as the pristine capture.
   */
  const source = step.screenshot ?? step.screenshotOriginal;
  if (!source) {
    showToast({ message: 'This step has no screenshot to annotate.' });
    return;
  }

  const base = new Image();

  session = {
    onSave,
    base,
    done: [],
    undone: [],
    active: null,
    tool: 'pen',
    colour: DEFAULT_INK,
    width: WIDTHS[1],
    opacity: 1,
    blockSize: DEFAULT_BLOCK_SIZE,
    zoom: 1,
  };

  dom.title.textContent = `Annotate step ${number}`;
  dom.action.textContent = step.action || step.type;
  dom.opacity.value = '100';
  dom.block.value = String(DEFAULT_BLOCK_SIZE);
  dom.block.min = String(BLOCK_SIZES[0]);
  dom.block.max = String(BLOCK_SIZES[BLOCK_SIZES.length - 1]);

  buildSwatches();
  buildWidths();
  selectTool('pen');
  paintHistory();
  hydrateIcons(dom.dialog);

  base.onload = () => {
    dom.canvas.width = base.naturalWidth;
    dom.canvas.height = base.naturalHeight;
    if (session) session.zoom = fitZoom();
    applyZoom();
    redraw();
  };

  base.onerror = () => {
    showToast({ message: 'That screenshot could not be opened.', tone: 'danger' });
    session = null;
    dom.dialog.close();
  };

  base.src = source;
  dom.dialog.showModal();
}
