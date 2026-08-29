/**
 * Turning a recorded source path into a link that opens the file.
 *
 * Ported from react-source-locator `src/panel/settings.ts` @ 6eb7a30 — the
 * `EDITORS` table, `toAbsolutePath` and `buildEditorUrl`. Divergences:
 *
 *   - **Lines arrive 1-based.** `ComponentSource.line` was converted once at
 *     the source-map edge, so `{line1}` is the number as stored and
 *     `{line}` is one less. Upstream takes 0-based positions and adds. Getting
 *     this backwards opens the file one line off, every time, silently.
 *   - **No `managed` policy layer.** Upstream lets an administrator push an
 *     editor org-wide; a recorder has no such deployment story, and the setting
 *     lives in the same `chrome.storage.sync` shape as everything else here.
 *   - **The template is validated, not just filled.** The URL is handed to
 *     `chrome.tabs.create`, so a template that produced `https://…` would make
 *     a settings field into a way to open arbitrary pages.
 *
 * Pure — no DOM, no Chrome.
 */

import type { ComponentSource } from '../../shared/types.js';

/** `{path}` is absolute; `{line}`/`{col}` are 0-based, `{line1}`/`{col1}` are 1-based. */
export interface EditorDefinition {
  label: string;
  template: string;
}

/**
 * Kept in step with the sibling extension's table, in the same order, so that
 * someone who has both does not have to learn two lists.
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
  /** 1-based, as stored on `ComponentSource`. */
  line?: number;
  column?: number;
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

  const line = target.line ?? 1;
  const column = target.column ?? 1;

  const url = template
    .replace(/\{path\}/g, target.path)
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
