/**
 * Turning a recorded path into a link that opens the right file.
 *
 * The failure this guards is silent: an off-by-one on the line number, or a
 * root joined onto a path that was already absolute, opens *something* — just
 * not the line the flow is pointing at.
 */

import { describe, expect, it } from 'vitest';
import {
  EDITORS,
  buildEditorUrl,
  componentEditorUrl,
  editorTemplate,
  isEditorScheme,
  toAbsolutePath,
} from '../src/core/react/editor.js';
import { pos0, pos1 } from '../src/core/react/positions.js';
import type { ComponentSource } from '../src/shared/types.js';

const VSCODE = EDITORS.vscode.template;

describe('toAbsolutePath', () => {
  it('joins a repo-relative path onto the root', () => {
    expect(toAbsolutePath('/Users/me/shop', 'src/Cart.tsx')).toBe('/Users/me/shop/src/Cart.tsx');
  });

  it('does not double a root the path already carries', () => {
    // Some maps record the compilation root, so the path arrives absolute and
    // already under the configured root. Joining again is a path to nowhere.
    expect(toAbsolutePath('/Users/me/shop', '/Users/me/shop/src/Cart.tsx')).toBe(
      '/Users/me/shop/src/Cart.tsx',
    );
  });

  it('treats a leading slash as project-relative, because Vite emits those', () => {
    expect(toAbsolutePath('/Users/me/shop', '/src/App.tsx')).toBe('/Users/me/shop/src/App.tsx');
  });

  it('tolerates a trailing slash on the root', () => {
    expect(toAbsolutePath('/Users/me/shop/', 'src/Cart.tsx')).toBe('/Users/me/shop/src/Cart.tsx');
  });

  it('refuses to guess when there is no root and the path is relative', () => {
    expect(toAbsolutePath('', 'src/Cart.tsx')).toBeNull();
  });

  it('passes an absolute path through with no root at all', () => {
    expect(toAbsolutePath('', '/Users/me/shop/src/Cart.tsx')).toBe('/Users/me/shop/src/Cart.tsx');
  });
});

describe('buildEditorUrl', () => {
  it('treats the stored line as 1-based, and takes nothing else', () => {
    // D1. The two copies of this file meant opposite things by {line1}: one was
    // handed a 0-based map position and added one here, the other was handed a
    // number already converted at the source-map edge. `Pos1` is what makes the
    // wrong one a compile error rather than a file that opens one line off.
    const url = buildEditorUrl(VSCODE, {
      path: '/repo/src/Cart.tsx',
      line: pos1(34),
      column: pos1(3),
    });
    expect(url).toBe('vscode://file//repo/src/Cart.tsx:34:3');

    // @ts-expect-error a raw number has no base, and that is the whole point
    buildEditorUrl(VSCODE, { path: '/repo/src/Cart.tsx', line: 34 });
  });

  it('offers 0-based placeholders one lower', () => {
    const url = buildEditorUrl('ed://{path}#L{line}C{col}', {
      path: '/repo/a.tsx',
      line: pos1(34),
      column: pos1(3),
    });
    expect(url).toBe('ed:///repo/a.tsx#L33C2');
  });

  it('never produces a negative position, whatever arrives', () => {
    // `pos1` floors at 1 for exactly this reason, so the 0-based placeholder
    // floors at 0. A map that reported line 0 and a stored value that was never
    // converted both end up here, and neither can print `-1`.
    const url = buildEditorUrl('ed://{path}#L{line}', { path: '/repo/a.tsx', line: pos1(0) });
    expect(url).toBe('ed:///repo/a.tsx#L0');
  });

  it('opens the file at line 1 when the position is unknown', () => {
    // A literal {line1} in the URL opens nothing; line 1 opens the file.
    expect(buildEditorUrl(VSCODE, { path: '/repo/a.tsx' })).toBe('vscode://file//repo/a.tsx:1:1');
  });

  it('is null with no template, which is what an empty custom field means', () => {
    expect(buildEditorUrl('', { path: '/repo/a.tsx', line: pos1(1) })).toBeNull();
  });

  it('refuses a template that would open a web page', () => {
    // The settings field is a URL the worker hands to `chrome.tabs.create`;
    // without this it is a way to make the extension open anything.
    expect(buildEditorUrl('https://evil.test/?f={path}', { path: '/repo/a.tsx' })).toBeNull();
    expect(buildEditorUrl('javascript:alert({path})', { path: '/a' })).toBeNull();
    expect(buildEditorUrl('file://{path}', { path: '/repo/a.tsx' })).toBeNull();
  });
});

describe('isEditorScheme', () => {
  it('accepts the schemes the built-in editors use', () => {
    for (const { template } of Object.values(EDITORS)) {
      if (!template) continue;
      expect(isEditorScheme(template), template).toBe(true);
    }
  });

  it('rejects a bare path, which has no scheme to hand off to', () => {
    expect(isEditorScheme('/repo/src/Cart.tsx')).toBe(false);
  });
});

describe('editorTemplate', () => {
  it('uses the chosen editor’s own template', () => {
    expect(editorTemplate('zed', '')).toBe(EDITORS.zed.template);
  });

  it('uses the custom field only when custom is chosen', () => {
    expect(editorTemplate('custom', 'ed://{path}')).toBe('ed://{path}');
    expect(editorTemplate('vscode', 'ed://{path}')).toBe(VSCODE);
  });

  it('is empty for an editor key that no longer exists', () => {
    expect(editorTemplate('emacs-2003', '')).toBe('');
  });
});

describe('componentEditorUrl', () => {
  const link = { projectRoot: '/Users/me/shop', template: VSCODE };
  const resolved: ComponentSource = {
    name: 'Cart',
    status: 'resolved',
    source: 'src/Cart.tsx',
    line: pos1(34),
    column: pos1(2),
  };

  it('links a resolved component to its file and line', () => {
    expect(componentEditorUrl(resolved, link)).toBe(
      'vscode://file//Users/me/shop/src/Cart.tsx:34:2',
    );
  });

  it('uses an absolute path from the map ahead of the configured root', () => {
    const elsewhere: ComponentSource = {
      ...resolved,
      absolutePath: '/build/agent/src/Cart.tsx',
    };
    expect(componentEditorUrl(elsewhere, link)).toBe('vscode://file//build/agent/src/Cart.tsx:34:2');
  });

  it('has nothing to link when the component never resolved', () => {
    expect(componentEditorUrl({ name: 'Cart', status: 'not-found' }, link)).toBeNull();
  });

  it('has nothing to link when a compiled position is all there is', () => {
    // The viewer still shows `app.js:1:245`; it is not a file anyone can open.
    const compiled: ComponentSource = {
      name: 'Cart',
      status: 'compiled-only',
      compiled: { url: 'https://shop.test/app.js', line: pos0(1), column: pos0(245) },
    };
    expect(componentEditorUrl(compiled, link)).toBeNull();
  });

  it('offers nothing at all before the settings have been read', () => {
    expect(componentEditorUrl(resolved, null)).toBeNull();
  });
});
