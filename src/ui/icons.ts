/**
 * Rendering Lucide icons.
 *
 * Markup declares an icon by name — `<span data-icon="circle-dot"></span>` —
 * and `hydrateIcons` fills it in. Keeping the geometry out of the HTML means
 * there is one copy of each path (the generated module) rather than one per use,
 * and swapping an icon is a one-word edit.
 */

import { ICON_PATHS, type IconName } from './icons.generated.js';

export type { IconName };
export { ICON_PATHS };

const SVG_NS = 'http://www.w3.org/2000/svg';

export function isIconName(value: string): value is IconName {
  return value in ICON_PATHS;
}

/**
 * Build one icon. Size, stroke and colour come from the `.icon` rule, so the
 * element inherits whatever the text around it is doing.
 */
export function icon(name: IconName, className = 'icon'): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', className);
  // Decorative by definition: every icon here sits beside its own label, or on a
  // button that carries an aria-label. Announcing it twice helps nobody.
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  // Generated constant geometry, never user input.
  svg.innerHTML = ICON_PATHS[name];
  return svg;
}

/** Replace every `[data-icon]` placeholder under `root` with its drawing. */
export function hydrateIcons(root: ParentNode = document): void {
  for (const holder of root.querySelectorAll<HTMLElement>('[data-icon]')) {
    const name = holder.dataset.icon;
    if (!name || !isIconName(name)) continue;

    const extra = holder.dataset.iconClass;
    holder.replaceChildren(icon(name, extra ? `icon ${extra}` : 'icon'));
  }
}

/** Swap an already-hydrated placeholder to a different icon. */
export function setIcon(holder: HTMLElement, name: IconName): void {
  const extra = holder.dataset.iconClass;
  holder.dataset.icon = name;
  holder.replaceChildren(icon(name, extra ? `icon ${extra}` : 'icon'));
}
