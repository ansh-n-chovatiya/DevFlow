/**
 * Every default equals today's constant.
 *
 * This is the test that makes the whole refactor safe. `features/settings` moved
 * sixty-odd numbers out of the files that used them and into one table; if any
 * one of them was mistyped on the way, nothing else here would fail — the
 * extension would simply record with a different settle delay, or cap bodies at
 * a different size, and every other test would keep passing.
 *
 * Table-driven on purpose. A hand-written assertion per field is a list that
 * someone forgets to add to; this walks `FIELDS` itself, so a new setting whose
 * default is not in this table fails the last case in the file.
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import * as constants from '../src/shared/constants.js';
import { DEFAULTS, FIELDS, type SettingKey } from '../src/features/settings/fields.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The constant each key's default comes from.
 *
 * Written out rather than derived, because "derived" would mean deriving it the
 * same way the table does — and a test that repeats the code under test proves
 * only that the code is self-consistent.
 */
const SOURCE: Record<SettingKey, unknown> = {
  theme: 'system',

  'recording.maxSteps': constants.MAX_STEPS,
  'recording.warnSteps': constants.WARN_STEPS,
  'recording.inputDebounceMs': constants.INPUT_DEBOUNCE_MS,
  'recording.domDelta': constants.CAPTURE_DOM_DELTA,
  'recording.domDeltaMs': constants.DOM_DELTA_MS,
  'recording.containerTextCap': constants.CONTAINER_TEXT_CAP,
  'recording.trailingStep': constants.CAPTURE_TRAILING_STEP,
  'recording.spaSettleMs': constants.SPA_SETTLE_MS,
  'recording.reloadTimeoutMs': constants.RELOAD_TIMEOUT_MS,

  'screenshots.capture': constants.CAPTURE_SCREENSHOTS,
  'screenshots.quality': constants.SCREENSHOT_QUALITY,
  'screenshots.settleDelayMs': constants.SETTLE_DELAY_MS,
  'screenshots.minIntervalMs': constants.CAPTURE_MIN_INTERVAL_MS,
  'screenshots.precaptureTtlMs': constants.PRECAPTURE_TTL_MS,
  'screenshots.paintTimeoutMs': constants.PAINT_TIMEOUT_MS,

  'network.captureBodies': constants.CAPTURE_BODIES,
  'network.bodyCap': constants.BODY_CAP,
  'network.summariseBodies': constants.SUMMARISE_BODIES,
  'network.schemaThreshold': constants.SCHEMA_THRESHOLD,

  'console.levels': constants.CONSOLE_LEVELS,
  'console.captureUncaught': constants.CAPTURE_UNCAUGHT,
  'console.logArgCap': constants.LOG_ARG_CAP,
  'console.stackFrames': constants.STACK_FRAMES,

  'annotation.stroke': constants.ANNOTATION_STROKE,

  'export.format': constants.EXPORT_DEFAULT_FORMAT,
  'export.images': constants.EXPORT_DEFAULT_IMAGES,
  'export.network': constants.EXPORT_DEFAULT_NETWORK,
  'export.logs': constants.EXPORT_DEFAULT_LOGS,
  'export.react': constants.EXPORT_DEFAULT_REACT,
  'export.sendImages': constants.SEND_DEFAULT_IMAGES,
  'export.sendNetwork': constants.SEND_DEFAULT_NETWORK,
  'export.sendLogs': constants.SEND_DEFAULT_LOGS,
  'export.sendReact': constants.SEND_DEFAULT_REACT,

  reactCapture: constants.REACT_SETTING_DEFAULTS.reactCapture,
  reactResolve: constants.REACT_SETTING_DEFAULTS.reactResolve,
  projectRoot: constants.REACT_SETTING_DEFAULTS.projectRoot,
  editor: constants.REACT_SETTING_DEFAULTS.editor,
  customEditorTemplate: constants.REACT_SETTING_DEFAULTS.customEditorTemplate,
  'react.maxComponentsPerFlow': constants.MAX_COMPONENTS_PER_FLOW,
  'react.maxResolveMsPerFlow': constants.MAX_RESOLVE_MS_PER_FLOW,
  'react.maxComponentChain': constants.MAX_COMPONENT_CHAIN,
  'react.maxFiberWalk': constants.MAX_FIBER_WALK,
  'react.chainTimeoutMs': constants.REACT_CHAIN_TIMEOUT_MS,
  'react.prewarmTtlMs': constants.REACT_PREWARM_TTL_MS,
  'react.bufferSize': constants.REACT_BUFFER_SIZE,
  'react.bufferTtlMs': constants.REACT_BUFFER_TTL_MS,
  'react.resolveConcurrency': constants.RESOLVE_CONCURRENCY,
  'react.resolveDebounceMs': constants.RESOLVE_DEBOUNCE_MS,
  'react.bundleCacheEntries': constants.BUNDLE_CACHE_ENTRIES,
  'react.bundleCacheBytes': constants.BUNDLE_CACHE_BYTES,
  'react.maxResourceBytes': constants.MAX_RESOURCE_BYTES,
  'react.maxMapBytes': constants.MAX_MAP_BYTES,
  'react.maxScriptsPerOrigin': constants.MAX_SCRIPTS_PER_ORIGIN,

  mcpServerUrl: constants.DEFAULT_MCP_URL,
  mcpAutoSend: false,
  'mcp.port': constants.MCP_PORT,
  'mcp.maxTokens': constants.MCP_MAX_TOKENS,
  'mcp.raw': constants.MCP_RAW_DEFAULT,
  'mcp.maxImages': constants.MCP_MAX_IMAGES,
  'mcp.bodyLimit': constants.MCP_BODY_LIMIT,
  'mcp.maxResponseBody': constants.MAX_RESPONSE_BODY,
  'mcp.maxConsoleEntries': constants.MAX_CONSOLE_ENTRIES,
  'mcp.maxFlows': constants.MCP_MAX_FLOWS,
  'mcp.maxFlowBytes': constants.MCP_MAX_FLOW_BYTES,
  'mcp.sendTimeoutMs': constants.SEND_TIMEOUT_MS,
  'mcp.healthTimeoutMs': constants.HEALTH_TIMEOUT_MS,
  'mcp.remoteTimeoutMs': constants.REMOTE_TIMEOUT_MS,

  'thumbnails.width': constants.THUMBNAIL_WIDTH,
  'thumbnails.height': constants.THUMBNAIL_HEIGHT,
  'thumbnails.quality': constants.THUMBNAIL_QUALITY,

  'ui.errorTtlMs': constants.ERROR_TTL_MS,
  'ui.launcherTimeoutMs': constants.LAUNCHER_TAB_TIMEOUT_MS,
};

describe('every default equals today’s constant', () => {
  for (const field of FIELDS) {
    it(`${field.key} is the shipped value`, () => {
      expect(DEFAULTS[field.key]).toEqual(SOURCE[field.key]);
    });
  }

  it('names every field, so a new setting cannot be added without one', () => {
    expect(Object.keys(SOURCE).sort()).toEqual(FIELDS.map((field) => field.key).sort());
  });
});

/**
 * The MCP server is a separate npm package in a separate process, and what it
 * can and cannot share with the extension is the whole subject of delivery.
 *
 * Phase 0 left three duplicated numbers here, as literals in `server.js` with
 * this test guarding the drift. Phase 4 removed them: `core/mcp-bundle.ts` now
 * exports `DEFAULTS` and `resolve`, so the six settings that govern how a
 * response is rendered come from the same field table the Settings screen
 * draws. There is nothing left for those three to drift *from*, which is a
 * better outcome than a test — so what is asserted below is that the
 * duplication has not come back.
 *
 * Phase 5 removed the last three. Retention and the port used to be read from
 * `process.env` above the settings layer, because the port is needed to bind a
 * socket; they come through the chain like everything else now, so the server
 * declares no number the field table also declares.
 *
 * Parsed out of the source rather than imported, because importing `server.js`
 * starts an HTTP listener.
 */
describe('the MCP server’s own numbers match the mirror in constants.ts', () => {
  const server = readFileSync(resolve(root, 'mcp-server/server.js'), 'utf8');

  /** `const NAME = <expression>;` — the expression, verbatim. */
  function literal(name: string): string {
    const match = new RegExp(`\\bconst ${name} = ([^;]+);`).exec(server);
    expect(match, `mcp-server/server.js no longer declares ${name}`).not.toBeNull();
    return match![1].trim();
  }

  it('takes the port from the settings layer, not from a fallback of its own', () => {
    /*
     * The one machine-wide setting that cannot be re-read: a socket is bound
     * before any request arrives. So the value is settled once, out of
     * `MACHINE_RESOLVED` — and a `|| 7734` reappearing here is the mirror
     * coming back, on the number where it would be least visible, because a
     * server on the wrong port answers nothing at all rather than answering
     * wrongly.
     *
     * Remote mode keeps `PORT`, which is not a setting: there the port is how
     * MCP itself is served.
     */
    const expression = literal('HTTP_PORT');
    expect(expression).toContain("MACHINE_RESOLVED['mcp.port']");
    expect(expression).not.toContain(String(constants.MCP_PORT));
  });

  it('reads the retention caps per sweep, so a new one governs the next save', () => {
    // Not constants at all any more: `POST /config` can lower a cap while the
    // server runs, and a value captured at import would enforce the old one
    // until the next restart with nothing saying so.
    expect(server).toMatch(/MACHINE_RESOLVED\['mcp\.maxFlows'\]/);
    expect(server).toMatch(/MACHINE_RESOLVED\['mcp\.maxFlowBytes'\]/);
  });

  it('the schema version the server accepts is the one the extension writes', () => {
    expect(literal('SUPPORTED_SCHEMA')).toBe(String(constants.FLOW_SCHEMA_VERSION));
  });

  it.each([
    'MAX_TOKENS',
    'MAX_IMAGES',
    'BODY_LIMIT',
    'FULL_BODY_LIMIT',
    'MAX_FLOWS',
    'MAX_FLOW_BYTES',
  ])(
    'does not declare %s again',
    (name) => {
      // Reintroducing any of these is how the duplication comes back: a value
      // the Settings screen offers, that the server has its own opinion about,
      // with nothing saying which one the reader is looking at.
      expect(server).not.toMatch(new RegExp(`\\bconst ${name}\\b`));
    },
  );

  it('reads its defaults out of the shared field table instead', () => {
    expect(server).toMatch(/import \{[^}]*\bDEFAULTS\b[^}]*\} from '\.\/core\.js'/s);
    expect(server).toMatch(/resolve as resolveSettings/);
  });
});

/**
 * The bundle the server imports actually carries the table.
 *
 * `mcp-server/core.js` is generated by `npm run build:mcp`, and the server's
 * whole settings layer is built on three of its exports. A bundle that stopped
 * carrying them would fail at import time in a package with no typecheck over
 * it — and only for whoever ran `npx flowsnap-mcp`, not for anyone here.
 */
describe('the bundle carries the mechanism the server imports', () => {
  const bundle = readFileSync(resolve(root, 'mcp-server/core.js'), 'utf8');

  it.each(['DEFAULTS', 'resolve', 'flowRendering', 'fieldFor', 'describeStamp'])(
    'exports %s',
    (name) => {
      expect(bundle).toMatch(new RegExp(`^export \\{[^}]*\\b${name}\\b`, 'm'));
    },
  );

  it('does not drag chrome.storage into a Node process with it', () => {
    // `features/settings/resolve.ts` exists to make this structural: the pure
    // half of the mechanism has no `chrome.*` in it, so bundling it cannot
    // reach the storage wrapper. A `chrome.` outside a comment means it did.
    const code = bundle.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(code).not.toMatch(/\bchrome\s*\./);
  });
});

describe('the shipped default file equals DEFAULTS', () => {
  const shipped = JSON.parse(
    readFileSync(resolve(root, 'public/settings.default.json'), 'utf8'),
  ) as Record<string, unknown>;

  it('key for key', () => {
    expect(Object.keys(shipped).sort()).toEqual(Object.keys(DEFAULTS).sort());
  });

  it('value for value', () => {
    for (const [key, value] of Object.entries(shipped)) {
      expect(value, key).toEqual(DEFAULTS[key as SettingKey]);
    }
  });

  it('is regenerated, not edited — the file ends with a newline', () => {
    expect(readFileSync(resolve(root, 'public/settings.default.json'), 'utf8')).toMatch(/\n$/);
  });
});
