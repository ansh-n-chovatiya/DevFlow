/**
 * What the MCP server needs from `core/`, in one entry point.
 *
 * The server is published to npm as its own package and cannot import TypeScript
 * out of `src/`, so it used to carry a second markdown renderer written by hand
 * — 65 lines that had to agree with the 375 in `core/export/markdown.ts` and
 * did not. The good renderer omitted brittle selectors, printed a URL only when
 * the page changed, and escaped page text so a response body could not forge a
 * step heading; the server's printed the full URL and absolute screenshot path
 * on every step and escaped nothing. The careful one rendered the file a human
 * downloads. The weak one rendered what the model read.
 *
 * So `core/` is bundled into the server package instead (`npm run build:mcp`),
 * which is what `core/` being pure — no Chrome, no DOM, no clock — has always
 * been for. One renderer, one set of rules, one place to fix them.
 *
 * Nothing but re-exports belongs here. Anything this file pulls in is shipped to
 * npm, so it is deliberately narrow.
 */

export { exportToMarkdown, renderComponents, renderStep, flowHost, urlPath } from './export/markdown.js';
export { compactBody } from './schema/index.js';
export { callFailed, statusClass, stepFailed, worstLevel } from './flow/index.js';
export { stepEnclosing, stepOwner, formatSource } from './react/attribution.js';

/*
 * The one exception to "core only", and it earns it.
 *
 * `describeStamp` turns a flow's `settings` into the sentences the walkthrough
 * header prints. The wording has to be identical on both sides of the wire —
 * the extension writes `flow.md` through the same renderer the server does, and
 * a reader who sees one description in the file and another in the tool
 * response has to work out which is true. Duplicating it here in JavaScript is
 * exactly the mistake this file was created to undo, and the module it comes
 * from is pure: a field table and two string functions, no Chrome, no DOM.
 */
export { describeStamp, showValue } from '../features/settings/stamp.js';

/*
 * The rest of the exception, and Phase 4's reason for widening it.
 *
 * The server has a precedence rule — **environment variable >
 * `config.json` > per-flow > default** — and that is a chain of sparse override
 * objects resolved against the field table. `resolve()` is already exactly
 * that, and the plan's second standing rule is that it is the *only* validator:
 * a JavaScript reimplementation here would clamp a hand-edited `config.json` by
 * rules that drift from the ones the Settings screen enforces, and neither copy
 * would be wrong on its own.
 *
 * It costs the package nothing new. `describeStamp` already pulls in the field
 * table, and `features/settings/resolve.ts` exists so that the clamp can be
 * imported without `chrome.storage` coming with it.
 *
 * `flowRendering` is the other half: the six values the server decides per flow,
 * named once in typed code rather than as dotted key strings in `server.js`,
 * where a typo resolves to `undefined` and reads as the default.
 */
export { DEFAULTS, fieldFor } from '../features/settings/fields.js';

/*
 * The endpoint's allow-list, and Phase 5's reason for widening this again.
 *
 * `POST /config` writes only the settings the field table marks `machine: true`
 * — the port and the two retention caps. The server could hold that list as
 * three strings of its own, and then a key renamed in `fields.ts` would leave
 * an endpoint quietly accepting a name nothing reads and refusing the one that
 * matters. It is the same argument that put `resolve` here: one description of
 * a setting, on both sides of the wire.
 */
export { MACHINE_KEYS } from '../features/settings/fields.js';
export { resolve } from '../features/settings/resolve.js';
export { flowRendering, renderLimits } from '../features/settings/render.js';
