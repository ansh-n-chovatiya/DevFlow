/**
 * One component's source, rendered once for the whole product.
 *
 * ## Why this is a module and not three renderers
 *
 * Three surfaces answer the same question — *where was this component written?*
 * The DevTools panel asks it about a component the user just picked (W2·G), the
 * popup asks it about a component the user just picked with DevTools closed
 * (W2·H), and the flow review asks it about a component a recorded step already
 * touched (W2·K). All three are holding the identical type: `ComponentSource`,
 * which is what a recorded step carries and what `LocateResult.source` is.
 *
 * So the card is built here, in Wave 1, before any of its three callers exists.
 * That ordering is the point. A card built three times is three cards that
 * drift — the panel's grows a match count, the review's grows a dependency
 * marker, the popup's keeps neither — and the merge's stated failure mode is a
 * product that technically works and still reads as two extensions. G, H and K
 * import this. None of them builds a second one.
 *
 * ## Every status, and the sentence that goes with it
 *
 * `ComponentStatus` has nine values and only one of them is `resolved`. The
 * other eight are the normal outcomes of looking for a component in a shipped
 * bundle, and each carries a `detail` sentence explaining which one happened.
 *
 * **Rendering that sentence is most of this module's job.** A card that shows a
 * name and no path reads as "this component has no source", which is both
 * discouraging and wrong; a card that says *most likely a lazy chunk that was
 * never fetched* tells the reader to go load that route and pick again. Both
 * source extensions held that line and so does this. `detail` is written by the
 * resolver, which knows what actually happened; `STATUS_DETAIL` below is only
 * the fallback for a record that reached us without one — an older flow, a
 * hand-built fixture — so that "no sentence" is never a state the card can be in.
 *
 * ## Positions
 *
 * `ComponentSource.line` is `Pos1` and `compiled.line` is `Pos0` (CONTRACTS §1).
 * Nothing here shows a `Pos0` to a person: the compiled pair crosses the bridge
 * through `positionToOneBased` at the one place it is formatted, and it crosses
 * as a pair so it cannot be half-converted. Everything else is already 1-based
 * and is not touched.
 *
 * ## Shape of the API
 *
 * A plain builder returning one element, not a `{ element, update }` pair like
 * `settings/components.ts`'s app bar. The app bar is chrome that outlives its
 * contents; this is the content. When the editor setting changes under it, or a
 * pending resolution finishes, the caller builds a new card and replaces the old
 * one — which is what all three callers were going to do anyway, and it removes
 * a lifecycle that three packages would otherwise each have to get right.
 *
 * Every effect is a callback. This module writes no clipboard, opens no tab and
 * touches no `chrome.*`: the three surfaces have different toasts, different
 * permissions and, in the popup's case, no DevTools API at all.
 */

import { componentEditorUrl, type EditorLink } from '../../core/react/editor.js';
import { positionToOneBased } from '../../core/react/positions.js';
import type { ComponentSource, ComponentStatus } from '../../shared/types.js';
import { icon, type IconName } from '../icons.js';

/**
 * A position in the served bundle, as `ComponentSource` records it.
 *
 * Named so `onOpenSources` has something to spell. Both numbers are `Pos0` and
 * stay that way — DevTools' own Sources API is 0-based too, so the handler wants
 * them exactly as stored.
 */
export type CompiledPosition = NonNullable<ComponentSource['compiled']>;

// ── The words ────────────────────────────────────────────────────────────────

/**
 * How the source was found, in two words. CONTRACTS §4.4 freezes all three.
 *
 * `via` on the model has two values, not three, because `bundle-search` splits
 * on whether the search got all the way back to an original file:
 *
 *   - `dev build` — React attached `_debugSource`, so this is the file the
 *     developer typed, read straight off the fiber. No search happened.
 *   - `source map` — found in a bundle, then mapped back through the bundle's
 *     source map to the original file.
 *   - `compiled` — found in a bundle, and that is as far as it got. The position
 *     shown is a position in minified output.
 *
 * Null when nothing was found at all: a `pending`, `skipped`, `not-found` or
 * `unfetchable` record has no `via`, and labelling one would be claiming a
 * provenance for an answer that does not exist.
 */
export function viaLabel(source: ComponentSource): string | null {
  if (source.via === 'debug-source') return 'dev build';
  if (source.via !== 'bundle-search') return null;
  return source.source ? 'source map' : 'compiled';
}

/** The confidence score for the given source attribution. */
export function confidenceLabel(source: ComponentSource): 'HIGH' | 'MEDIUM' | 'LOW' | null {
  if (source.status === 'ambiguous') return 'LOW';
  if (source.via === 'debug-source') return 'HIGH';
  if (source.via !== 'bundle-search') return null;
  return source.source ? 'MEDIUM' : 'LOW';
}

/** The sentence behind each `via`, as a tooltip. */
const VIA_TITLE: Record<string, string> = {
  'dev build': 'Read directly from the location React recorded on the component.',
  'source map': 'The compiled position, mapped back through the bundle’s source map.',
  compiled: 'A position in the served bundle. No original source was available.',
};

/**
 * The fallback for a record whose `detail` never made it.
 *
 * Keyed so the compiler requires all eight non-`resolved` statuses: adding a
 * tenth `ComponentStatus` without a sentence for it fails the build here, which
 * is the whole reason this is a `Record` over an `Exclude` rather than a lookup
 * with a default string.
 */
export const STATUS_DETAIL: Record<Exclude<ComponentStatus, 'resolved'>, string> = {
  'compiled-only':
    'Found in a bundle, but only its compiled position is known — the original file ' +
    'could not be recovered.',
  ambiguous:
    'The same code matched more than one place in the page’s bundles, so this may ' +
    'not be the right file.',
  'not-found':
    'Not found in any bundle the page had loaded — most likely a lazy chunk that ' +
    'was never fetched.',
  'no-map': 'The bundle it was found in ships no source map, so the original file is unknown.',
  'map-error':
    'Its bundle’s source map could not be read, so the compiled position is the best available.',
  unfetchable: 'None of the page’s script bundles could be read, so its source was never searched.',
  skipped: 'Source resolution is turned off, so this component was never looked up.',
  pending: 'Still resolving — the search for this component’s source has not finished.',
};

/**
 * The sentence to show under the path, or null when there is nothing to explain.
 *
 * `resolved` is the only status that renders no sentence, because it is the only
 * one where the path above it is the whole answer.
 */
export function detailText(source: ComponentSource): string | null {
  if (source.status === 'resolved') return null;
  return source.detail ?? STATUS_DETAIL[source.status];
}

/**
 * The ambiguity warning.
 *
 * `matchCount > 1` means the needle was found in more than one place and the
 * first was taken. That is a warning and not an error — the path is probably
 * right, it just cannot be relied on — which is why it reads as a caveat above
 * the actions rather than replacing them.
 *
 * `resourcesSearched` comes from `LocateResult` and so exists only on the two
 * picking surfaces; the flow review has a `ComponentSource` and no count, and
 * the sentence has to work without it.
 */
export function ambiguityText(matchCount: number, resourcesSearched?: number): string {
  const scope =
    resourcesSearched === undefined
      ? ''
      : ` across ${resourcesSearched} script${resourcesSearched === 1 ? '' : 's'}`;
  return (
    `This code matched ${matchCount} places${scope}, ` +
    'so the path above may not be the one you want.'
  );
}

// ── The path ─────────────────────────────────────────────────────────────────

/** The last segment of a bundle URL, which is the part anyone recognises. */
function bundleFileName(url: string): string {
  try {
    const path = new URL(url).pathname;
    return path.slice(path.lastIndexOf('/') + 1) || url;
  } catch {
    // Not every recorded bundle URL parses — a blob: or a data: URL will not —
    // and showing the raw string beats showing nothing.
    return url;
  }
}

function withPosition(path: string, line?: number, column?: number): string {
  if (line === undefined) return path;
  return column === undefined ? `${path}:${line}` : `${path}:${line}:${column}`;
}

/**
 * The one string the card displays, copies and puts in its tooltip.
 *
 * Display and copy are deliberately the same string. Upstream showed the short
 * bundle filename and copied the full URL, which is more useful right up until
 * someone notices that a button labelled `Copy path` copied something other than
 * the path it was sitting on. The full URL is not lost — it is the origin line
 * under the path, which names the bundle whenever there is one.
 *
 * Null when there is no position at all, which is the ordinary state of a
 * `pending`, `skipped`, `not-found` or `unfetchable` record.
 */
export function pathText(source: ComponentSource): string | null {
  if (source.source) return withPosition(source.source, source.line, source.column);
  if (!source.compiled) return null;

  const position = positionToOneBased(source.compiled);
  return withPosition(bundleFileName(source.compiled.url), position.line, position.column);
}

// ── DOM ──────────────────────────────────────────────────────────────────────

/**
 * The one place an element is made, as in `settings/components.ts`. Every class
 * name in the card passes through here, so "what does this card render" is a
 * grep rather than a read.
 */
function make<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function actionButton(
  name: IconName,
  label: string,
  className: string,
  onClick: () => void,
): HTMLButtonElement {
  const button = make('button', className);
  button.type = 'button';
  button.append(icon(name), make('span', undefined, label));
  button.addEventListener('click', onClick);
  return button;
}

export interface ResultCardOptions {
  /** The component to render. The same shape a step carries and a locate returns. */
  readonly source: ComponentSource;
  /**
   * The two settings a path needs to become an editor link, or null when there
   * is nothing to link with.
   *
   * Null — and a null result from `componentEditorUrl` — is the common case and
   * not a failure: most people have no project root configured, and a component
   * that only resolved to a bundle has no original file to open. The card shows
   * the path either way; the link is the extra.
   */
  readonly link?: EditorLink | null;
  /** From `LocateResult`, when the caller has one. Sharpens the ambiguity warning. */
  readonly resourcesSearched?: number;
  /**
   * Hand the path to the clipboard, and say so.
   *
   * Not done here: each surface has its own toast placement and its own idea of
   * what "copied" should look like, and a DOM builder that awaits a permission
   * prompt is a DOM builder that cannot be tested synchronously.
   */
  readonly onCopyPath?: (path: string) => void;
  /** Open the built editor URL. Only ever called with a non-null, validated URL. */
  readonly onOpenEditor?: (url: string) => void;
  /**
   * Reveal the compiled position in DevTools' Sources panel.
   *
   * Optional because the affordance is not universally available: the popup can
   * hold a component with a perfectly good compiled position and still have no
   * DevTools window to reveal it in. Omitting the handler is how a surface says
   * so — the button is not rendered rather than rendered and inert.
   */
  readonly onOpenSources?: (compiled: CompiledPosition) => void;
  /**
   * Start another pick gesture on the page.
   */
  readonly onPickAnother?: () => void;
}

/**
 * Build the card.
 *
 * Order is an argument, not a layout accident: the name says which component,
 * the path is the answer, the origin and the detail sentence qualify it, and the
 * ambiguity warning sits immediately above the actions because it is the caveat
 * that has to be read *before* opening a file it may be wrong about.
 */
export function resultCard(options: ResultCardOptions): HTMLElement {
  const { source } = options;

  const card = make('article', 'result-card');
  // The status is on the element rather than in a class so a surface can style
  // or query one outcome without this module owning a name for every one of nine.
  card.dataset.status = source.status;

  card.append(head(source));

  const path = pathText(source);
  if (path) card.append(pathLine(path, options.onCopyPath));

  if (source.compiled) {
    // Which bundle it was found in. Always worth saying: with an original source
    // it is the evidence, and without one it is the only place to look.
    const origin = make('p', 'result-card__origin mono', source.compiled.url);
    origin.title = source.compiled.url;
    card.append(origin);
  }

  const detail = detailText(source);
  if (detail) card.append(make('p', 'result-card__detail', detail));

  const matchCount = source.matchCount ?? 0;
  if (matchCount > 1) card.append(ambiguity(matchCount, options.resourcesSearched));

  const actions = actionRow(options);
  if (actions) card.append(actions);

  return card;
}

function head(source: ComponentSource): HTMLElement {
  const row = make('div', 'result-card__head');
  row.append(icon('atom', 'icon result-card__mark'));
  row.append(make('h3', 'result-card__name', source.name));

  if (source.dependency) {
    /*
     * Not the user's code. Worth a marker rather than a footnote: the difference
     * between `src/checkout/Button.tsx` and a file under node_modules is the
     * difference between a file to edit and a file to stop reading.
     *
     * The literal directory name, because it is a directory name — a product
     * noun here would need a glossary entry it does not have (CONTRACTS §4.1).
     */
    row.append(make('span', 'result-card__dep mono', 'node_modules'));
  }

  if (source.status === 'pending') {
    // A spinner rather than a `via` badge: there is no provenance yet, and the
    // card exists precisely so a step can show its component before the
    // background pass has finished resolving it.
    const spinner = make('span', 'spinner result-card__spinner');
    spinner.setAttribute('aria-hidden', 'true');
    row.append(spinner);
    return row;
  }

  const label = viaLabel(source);
  if (label) {
    // The shared chip, untinted: a chip only takes a data colour when it is
    // given a `data-tint`, and provenance is the same kind of fact on every card.
    const via = make('span', 'chip result-card__via', label);
    via.title = VIA_TITLE[label] ?? '';
    row.append(via);
  }

  const confidence = confidenceLabel(source);
  if (confidence) {
    const confChip = make('span', 'chip result-card__confidence', `Confidence: ${confidence}`);
    if (confidence === 'HIGH') confChip.setAttribute('data-tint', 'green');
    else if (confidence === 'MEDIUM') confChip.setAttribute('data-tint', 'yellow');
    else confChip.setAttribute('data-tint', 'red');
    row.append(confChip);
  }

  return row;
}

/**
 * The path, as the copy affordance.
 *
 * A button when there is somewhere to copy to, a paragraph when there is not.
 * The alternative — always a button, inert without a handler — is a control that
 * looks pressable and does nothing, which is worse than a line of text; and a
 * disabled button would take the path out of the selection the reader could
 * otherwise drag across.
 */
function pathLine(path: string, onCopyPath?: (path: string) => void): HTMLElement {
  if (!onCopyPath) {
    const line = make('p', 'result-card__path result-card__path--static');
    line.append(make('span', 'result-card__path-text mono', path));
    line.title = path;
    return line;
  }

  const button = make('button', 'result-card__path');
  button.type = 'button';
  // Frozen in CONTRACTS §4.4, and both attributes carry it: the tooltip is what
  // a mouse finds and the label is what a screen reader reads, and the path
  // itself is the button's text content, so neither can name it.
  button.title = 'Copy path';
  button.setAttribute('aria-label', 'Copy path');
  button.append(
    make('span', 'result-card__path-text mono', path),
    icon('copy', 'icon result-card__path-icon'),
  );
  button.addEventListener('click', () => onCopyPath(path));
  return button;
}

function ambiguity(matchCount: number, resourcesSearched?: number): HTMLElement {
  const banner = make('div', 'banner banner--warn result-card__ambiguity');
  banner.append(icon('triangle-alert', 'icon banner__icon'));
  banner.append(make('p', 'banner__body', ambiguityText(matchCount, resourcesSearched)));
  return banner;
}

/** Null when no action is available, so the card does not grow an empty row. */
function actionRow(options: ResultCardOptions): HTMLElement | null {
  const row = make('div', 'result-card__actions');

  const editorUrl = componentEditorUrl(options.source, options.link ?? null);
  const onOpenEditor = options.onOpenEditor;
  if (onOpenEditor) {
    if (editorUrl) {
      row.append(
        actionButton('arrow-up-right', 'Open in Editor', 'btn btn--primary btn--compact', () =>
          onOpenEditor(editorUrl),
        ),
      );
    } else {
      const btn = actionButton('arrow-up-right', 'Open in Editor', 'btn btn--primary btn--compact', () => {});
      btn.disabled = true;
      btn.title = options.source.source
        ? 'Set a project root in Settings to enable editor links.'
        : 'No original source resolved, so there is no file to open.';
      row.append(btn);
    }
  }

  const compiled = options.source.compiled;
  const onOpenSources = options.onOpenSources;
  if (compiled && onOpenSources) {
    row.append(
      actionButton('code', 'Open in Sources', 'btn btn--secondary btn--compact', () =>
        onOpenSources(compiled),
      ),
    );
  }

  /*
   * No copy button here.
   *
   * `onCopyPath` already turns the path line above into a button — the path is
   * its text, `Copy path` is its label, and the copy icon sits at the end of the
   * very string it copies. A second control in this row said `Copy` with nothing
   * beside it to say copy *what*, fired the identical handler with the identical
   * argument, and pushed the two `Open in` actions along to make room. The row
   * is for going somewhere; copying is an operation on the line it belongs to.
   */
  const onPickAnother = options.onPickAnother;
  if (onPickAnother) {
    // `Pick another`, frozen in CONTRACTS §4.4 and spelled that way by the
    // panel's own button. Title case here was one card disagreeing with the
    // status bar six pixels below it about the name of the same action.
    row.append(
      actionButton('crosshair', 'Pick another', 'btn btn--secondary btn--compact', onPickAnother),
    );
  }

  return row.childElementCount > 0 ? row : null;
}
