/**
 * The four DOM helpers every viewer controller needs.
 *
 * Deliberately four. The point of putting the structure in viewer.html and the
 * repeated rows in `<template>` is that the controllers bind data rather than
 * build markup, and a larger helper set here would be the beginning of building
 * markup again.
 */

export function el<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`FlowSnap: missing #${id} in viewer.html`);
  return node as T;
}

/** Find inside a subtree. Throws rather than returning null: the markup is ours. */
export function find<T extends Element = HTMLElement>(root: ParentNode, selector: string): T {
  const node = root.querySelector<T>(selector);
  if (!node) throw new Error(`FlowSnap: missing ${selector}`);
  return node;
}

export function show(node: Element, visible: boolean): void {
  node.classList.toggle('hidden', !visible);
}

/** The single root element of a `<template>`, ready to fill in. */
export function clone<T extends HTMLElement = HTMLElement>(id: string): T {
  const template = document.getElementById(id);
  if (!(template instanceof HTMLTemplateElement)) {
    throw new Error(`FlowSnap: #${id} is not a <template>`);
  }

  const root = template.content.firstElementChild;
  if (!root) throw new Error(`FlowSnap: <template>#${id} is empty`);

  return root.cloneNode(true) as T;
}
