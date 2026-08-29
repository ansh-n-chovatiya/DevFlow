/**
 * jsdom does not implement `CSS.escape`, which the selector builder relies on.
 * Chrome has had it since 46, so the gap is the test environment's, not the
 * code's. This shim covers identifiers — classes and ids — which is all the
 * selector builder ever passes it.
 */
if (typeof globalThis.CSS === 'undefined') {
  // @ts-expect-error — only the one method the code under test actually calls.
  globalThis.CSS = {};
}

globalThis.CSS.escape ??= (value: string): string =>
  String(value).replace(/[^\w-]/g, (char) => `\\${char}`);
