/**
 * Turning a resolved source path into a link that opens the file.
 *
 * One editor table and one URL builder, where there were two. They disagreed
 * about the only thing that mattered:
 *
 *   **D1 · `{line1}` is the line as stored.** `EditorTarget` accepts `Pos1` and
 *   nothing else. One copy took 0-based positions and added one while filling
 *   the template; the other converted once at the source-map edge and filled the
 *   number as it stood. Same placeholder, same file name, opposite meanings —
 *   and copying either version into the other opened every file one line off,
 *   silently, forever. `lookupOriginal` hands back `Pos0` now and `toOneBased`
 *   is applied once, at whichever surface is about to show or link the number.
 *   Handing a `Pos0` to this is a compile error, which is the guarantee a
 *   `base: 0 | 1` argument could never have given.
 *
 *   **The template is validated, not just filled.** The URL is handed to
 *   `chrome.tabs.create`, so a template that produced `https://…` would make a
 *   settings field into a way to open arbitrary pages. The other copy filled the
 *   template and returned whatever came out; `isEditorScheme` is the check that
 *   replaces that.
 *
 * The managed-policy layer that lets an administrator push an editor and project
 * root org-wide is not lost with the second copy — it comes back in
 * `features/settings/` (D7), which is where reading `chrome.storage.managed` is
 * allowed. It could never have lived here: `core/` is bundled into a Node
 * process with no `chrome` object at all.
 *
 * Pure — no DOM, no Chrome.
 */

import { pos1, type Pos1 } from './positions.js';
import type { ComponentSource } from '../../shared/types.js';

/** `{path}` is absolute; `{line}`/`{col}` are 0-based, `{line1}`/`{col1}` are 1-based. */
export interface EditorDefinition {
  label: string;
  template: string;
}

/**
 * The editors, in the order the settings screen offers them.
 *
 * This was two tables, hand-kept in step and in the same order so that someone
 * running both extensions did not have to learn two lists. They still matched
 * entry for entry when the merge took them, which is why nothing in this file
 * reconciles anything — it is one of the two copies, kept, and the other
 * deleted.
 */
export const EDITORS: Record<string, EditorDefinition> = {
  vscode: { label: 'VS Code', template: 'vscode://file/{path}:{line1}:{col1}' },
  'vscode-insiders': {
    label: 'VS Code Insiders',
    template: 'vscode-insiders://file/{path}:{line1}:{col1}',
  },
  cursor: { label: 'Cursor', template: 'cursor://file/{path}:{line1}:{col1}' },
  windsurf: { label: 'Windsurf', template: 'windsurf://file/{path}:{line1}:{col1}' },
  webstorm: {
    label: 'WebStorm / JetBrains',
    template: 'jetbrains://web-storm/navigate/reference?path={path}:{line1}:{col1}',
  },
  sublime: {
    label: 'Sublime Text',
    template: 'subl://open?url=file://{path}&line={line1}&column={col1}',
  },
  zed: { label: 'Zed', template: 'zed://file/{path}:{line1}:{col1}' },
  custom: { label: 'Custom…', template: '' },
};

/**
 * Resolves a recorded source path against the configured project root.
 *
 * A leading slash cannot be trusted to mean "filesystem absolute": Vite emits
 * server-root-relative paths like `/src/App.tsx`, which are project-relative.
 * So a path counts as already-absolute only when it sits under the project
 * root; everything else is joined onto it.
 *
 * Without a root there is nothing to resolve against, and guessing would send
 * an editor to a file on the wrong machine — so a relative path returns null
 * and the viewer offers no link at all.
 */
export function toAbsolutePath(projectRoot: string, source: string): string | null {
  const root = projectRoot.trim().replace(/[\\/]+$/, '');
  if (!root) return source.startsWith('/') ? source : null;
  if (source === root || source.startsWith(`${root}/`)) return source;
  return `${root}/${source.replace(/^\/+/, '')}`;
}

/** The template a chosen editor uses, or the user's own when `custom`. */
export function editorTemplate(editor: string, customTemplate: string): string {
  return editor === 'custom' ? customTemplate.trim() : (EDITORS[editor]?.template ?? '');
}

/**
 * A scheme that hands the URL to a program on this machine, rather than opening
 * a page.
 *
 * The worker refuses anything else before it opens a tab (`openEditor`); this
 * is the same rule applied early, so the viewer never offers a button that is
 * going to be refused. `file:` is excluded deliberately: it opens in the
 * browser, showing source in a tab rather than in an editor, which is not what
 * the button says it does.
 */
export function isEditorScheme(url: string): boolean {
  if (/^(https?|javascript|data|file|blob|about|chrome[\w-]*):/i.test(url)) return false;
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

export interface EditorTarget {
  /** Absolute local path. */
  path: string;
  /**
   * 1-based, as stored on `ComponentSource` — and typed that way, not just
   * documented. This is the D1 boundary: a source-map position reaches it only
   * through `toOneBased`.
   */
  line?: Pos1;
  column?: Pos1;
}

/**
 * Fills an editor URL template. Null when the template cannot be satisfied, or
 * when what it produced is not an editor link.
 *
 * A missing line is filled as 1 rather than left as `{line1}`: an editor handed
 * a literal placeholder opens nothing, while an editor handed line 1 opens the
 * file, which is the whole point.
 */
export function buildEditorUrl(template: string, target: EditorTarget): string | null {
  if (!template) return null;

  // `pos1` and not the literal `1`: an assertion, not arithmetic, and the one
  // spelling that says which base the fallback is in.
  const line = target.line ?? pos1(1);
  const column = target.column ?? pos1(1);

  // A function replacement, not the string itself: `$&`, `` $` ``, `$'` and
  // `$1` are substitution patterns to `String.replace`, and a path is somebody
  // else's filename rather than a pattern. `src/routes/$'.tsx` would otherwise
  // be filled with the text after `{path}` instead of with the file.
  const url = template
    .replace(/\{path\}/g, () => target.path)
    .replace(/\{line1\}/g, String(line))
    .replace(/\{col1\}/g, String(column))
    .replace(/\{line\}/g, String(Math.max(0, line - 1)))
    .replace(/\{col\}/g, String(Math.max(0, column - 1)));

  return isEditorScheme(url) ? url : null;
}

/** The two settings a source path needs before it can become a link. */
export interface EditorLink {
  projectRoot: string;
  /** Already resolved from the chosen editor; '' when there is nothing to use. */
  template: string;
}

/**
 * The editor link for one resolved component, or null when there is none.
 *
 * Null is the common case and not a failure: no project root configured, a
 * component that never resolved to a file, or a bundle position rather than an
 * original source. The viewer shows the path either way — the link is the extra.
 */
export function componentEditorUrl(
  component: ComponentSource,
  link: EditorLink | null,
): string | null {
  if (!link) return null;

  // An absolute path came out of the source map itself, so it needs no root —
  // and must not be joined onto one, which would produce a doubled path.
  const path = component.absolutePath
    ? component.absolutePath
    : component.source
      ? toAbsolutePath(link.projectRoot, component.source)
      : null;
  if (!path) return null;

  return buildEditorUrl(link.template, {
    path,
    line: component.line,
    column: component.column,
  });
}
