/**
 * Source maps: reading the annotation, parsing the JSON, and turning a position
 * in a served bundle back into the file somebody wrote.
 *
 * The one parser. Both extensions DevFlow merges shipped a copy of this, and
 * three of the five divergences the merge had to resolve lived here.
 *
 *   **D1 · The base.** `lookupOriginal` returns `Pos0`, because that is what a
 *   source map says. It does not editorialise. One copy used to add one here so
 *   everything downstream of it was 1-based; the other stayed 0-based to
 *   `buildEditorUrl`, which added one there instead — so `{line1}` meant
 *   opposite things in two files with the same name. The conversion now happens
 *   at the surface that shows the number, through `toOneBased`, and the brand on
 *   `Pos0`/`Pos1` is what makes doing it twice, or not at all, a compile error.
 *   See `positions.ts`.
 *
 *   **D3 · `sourcesContent`.** Off by default, on when a caller asks. The panel
 *   renders a source preview from it; the recorder must not keep it, because a
 *   flow is handed to an AI and inlined original source is both a token disaster
 *   and a way to leak code the user did not mean to send. This one is a
 *   *parameter* where D1 got a type, and the difference is the failure mode, not
 *   taste: get `keepSourcesContent` wrong and you lose a preview or carry a
 *   larger object — visible, bounded, harmless. Get the line base wrong and
 *   every file opens one line off, forever, with nothing to notice. A parameter
 *   is safe exactly when being wrong is loud.
 *
 *   **D4 · No fetching and no caching in here.** One copy owned a fetch callback
 *   and two module-level caches; this one parses text and answers lookups. That
 *   is not a preference: `src/core/` is bundled into `mcp-server/core.js` for a
 *   Node process with no `chrome` object, so a `fetch` in here fails
 *   `npm run build:mcp`. Both caches live behind `BundleProvider` now, which is
 *   also what owns the time and size budgets they have to respect.
 *
 * Mappings are kept as text and decoded one line at a time (see `vlq.ts`), so a
 * `PreparedMap` holds the raw string rather than a decoded object graph, and an
 * index map keeps its sections instead of flattening them into one — flattening
 * would mean decoding every section to answer one lookup, which is the whole
 * cost the streaming decode exists to avoid.
 *
 * Pure — no DOM, no Chrome, no network.
 */

import { pos0, type Pos0 } from './positions.js';
import { decodeLine, findSegmentInLine } from './vlq.js';

export class SourceMapError extends Error {}

/** Raw source map JSON, v3. */
interface RawSourceMap {
  version?: number;
  file?: string;
  sourceRoot?: string;
  sources?: (string | null)[];
  sourcesContent?: (string | null)[];
  names?: string[];
  mappings?: string;
  /** Index maps carry sections instead of mappings. */
  sections?: { offset: { line: number; column: number }; map?: RawSourceMap; url?: string }[];
}

/** A map ready for lookups. Mappings stay as text; see the header. */
export type PreparedMap =
  | {
      kind: 'plain';
      mappings: string;
      sources: string[];
      /**
       * The original file text a map inlined, when the parse was asked to keep
       * it (D3). Empty otherwise — never `undefined`, so nothing downstream can
       * tell "this map inlined nothing" from "we chose not to keep it" by shape
       * and branch on the difference. `OriginalPosition.content` is null either
       * way, which is the only answer a caller needs.
       */
      sourcesContent: (string | null)[];
      names: string[];
    }
  | { kind: 'index'; sections: PreparedSection[] };

interface PreparedSection {
  /** Where this section's own line 0, column 0 sits in the generated file. */
  line: number;
  column: number;
  map: PreparedMap;
}

/**
 * A position in the file somebody actually wrote.
 *
 * **0-based on both axes, because the map is** (D1). Whoever puts this number in
 * front of a person converts it with `toOneBased` at that edge, and the brand is
 * what stops it happening twice or not at all.
 */
export interface OriginalPosition {
  /** Normalised — see `normalizeSourcePath`. */
  source: string;
  line: Pos0;
  column: Pos0;
  /** The original identifier, when the map recorded one. */
  name: string | null;
  /**
   * The original file's text, when the map inlined it *and* the parse kept it.
   * Null is the ordinary case and the default; see D3 in the header.
   */
  content: string | null;
}

/**
 * Reads the `sourceMappingURL` annotation from bundle text.
 *
 * Scans only the tail: the annotation belongs at the end, and a full-text regex
 * over a multi-megabyte bundle is slow and can match a string literal in code.
 */
export function extractSourceMappingURL(content: string): string | null {
  const TAIL = 2000;
  const tail = content.length > TAIL ? content.slice(-TAIL) : content;

  // Both the `//#` and legacy `//@` spellings, plus the /* */ form.
  const re = /[#@]\s*sourceMappingURL\s*=\s*([^\s'"*]+)/g;

  let last: string | null = null;
  for (const m of tail.matchAll(re)) last = m[1];

  return last;
}

/** Decodes a `data:` source map URL, handling both base64 and percent-encoded payloads. */
export function decodeDataUrl(url: string): string {
  const comma = url.indexOf(',');
  if (comma === -1) throw new SourceMapError('Malformed data: source map URL.');

  const meta = url.slice(0, comma);
  const payload = url.slice(comma + 1);

  if (!/;base64$/i.test(meta)) return decodeURIComponent(payload);

  // atob yields one char per byte; reassemble as UTF-8 so non-ASCII paths survive.
  const binary = atob(payload);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Joins a `sourceRoot` with a source path without mangling absolute or webpack:// paths. */
function applySourceRoot(sourceRoot: string | undefined, source: string): string {
  if (!sourceRoot) return source;
  if (/^[a-z][a-z0-9+.-]*:/i.test(source) || source.startsWith('/')) return source;
  return sourceRoot.endsWith('/') ? sourceRoot + source : `${sourceRoot}/${source}`;
}

/** A `(app-pages-browser)`-style layer marker, as Next.js and webpack-internal emit. */
const LAYER_SEGMENT = /^\(.*\)$/;

/** Schemes bundlers invent for their own namespaces, as opposed to a real file. */
function isNamespacedScheme(scheme: string): boolean {
  return scheme.toLowerCase() !== 'file';
}

/**
 * Normalises a source map path into something worth handing to an editor.
 *
 * Bundlers emit `webpack://app/./src/Foo.tsx`, `webpack-internal:///(app-pages-browser)/./src/app/page.tsx`,
 * `../../src/App.tsx` and absolute file paths. Two rules do most of the work:
 *
 *   - In a bundler URL, a `.` segment is the compilation root. Everything before
 *     it is the bundler's synthetic namespace — a project name, a webpack layer
 *     — and says nothing about where the file sits in the repo somebody has
 *     checked out. Keeping it produced `my-app/src/App.tsx`, which opens
 *     nothing when joined to a project root. In a plain path the same `.` is
 *     ordinary relative navigation, so the rule is deliberately not applied
 *     there — cutting at it would turn `src/a/../b/./c.ts` into `c.ts`.
 *   - Leading `..` segments are dropped for the same reason: they record how far
 *     the map sat from the output directory, not where the source lives.
 *
 * **Absolute paths are kept absolute.** A flow is read by an AI running on the
 * same machine, and a source is opened in an editor on it, so
 * `/Users/me/proj/src/App.tsx` from a Vite dev server is directly openable —
 * strictly better than a guessed relative path joined onto a project root.
 */
export function normalizeSourcePath(source: string): string {
  let path = source;
  let namespaced = false;

  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(path);
  if (schemeMatch) {
    const [, scheme, rest] = schemeMatch;
    namespaced = isNamespacedScheme(scheme);
    path = namespaced ? rest : `/${rest.replace(/^\/+/, '')}`;
  }

  let segments = path.split('/');

  // The namespace strip applies only to a bundler URL. A plain path's `.` and
  // `..` segments are ordinary relative navigation — `src/a/../b/./c.ts` means
  // `src/b/c.ts`, and cutting at that `.` would throw away `src/b` entirely.
  if (namespaced) {
    const root = segments.indexOf('.');
    if (root !== -1) {
      segments = segments.slice(root);
    } else {
      // No root marker, so drop the leading noise by shape instead: the empty
      // segments of `webpack-internal:///` and any layer marker in front of the
      // real path. A `(marketing)` route group deeper in stays, because it is a
      // directory that exists on disk.
      while (segments.length > 0 && (segments[0] === '' || LAYER_SEGMENT.test(segments[0]))) {
        segments.shift();
      }
    }
  }

  // A bundler namespace is never a filesystem root, whatever it starts with.
  const isAbsolute = !namespaced && path.startsWith('/');

  const out: string[] = [];
  for (const part of segments) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length > 0) out.pop();
      continue;
    }
    out.push(part);
  }

  const joined = out.join('/');
  return isAbsolute ? `/${joined}` : joined;
}

function prepare(raw: RawSourceMap, keepSourcesContent: boolean): PreparedMap {
  if (raw.sections) return prepareIndexMap(raw, keepSourcesContent);

  if (typeof raw.mappings !== 'string') {
    throw new SourceMapError('Source map has no mappings.');
  }

  return {
    kind: 'plain',
    mappings: raw.mappings,
    sources: (raw.sources ?? []).map((s) => applySourceRoot(raw.sourceRoot, s ?? '')),
    // Dropped here rather than at lookup, because the point of dropping it is
    // that the strings are not retained at all: on a large map `sourcesContent`
    // is the bulk of the JSON, and holding it in order to ignore it later saves
    // nothing that matters.
    sourcesContent: keepSourcesContent ? (raw.sourcesContent ?? []) : [],
    names: raw.names ?? [],
  };
}

/**
 * Prepares an index map by keeping its sections rather than merging them.
 *
 * Flattening every section into one decoded mapping table would mean decoding
 * every section of the map to answer one lookup, which is the cost the streaming
 * decode exists to avoid — so a lookup instead picks the one section covering
 * the position and recurses into it.
 *
 * `keepSourcesContent` rides down with the recursion. An index map's sources
 * live in its sections, so a section prepared without the flag is exactly where
 * a dropped `sourcesContent` would silently come back — or, the other way, where
 * a panel's preview would go blank on a Next.js build and nowhere else.
 *
 * Sections referenced by `url` are skipped: resolving them needs another fetch
 * per section — which this module does not do at all (D4) — and no major bundler
 * emits them.
 */
function prepareIndexMap(raw: RawSourceMap, keepSourcesContent: boolean): PreparedMap {
  const sections: PreparedSection[] = [];

  for (const section of raw.sections ?? []) {
    if (!section.map) continue;
    sections.push({
      line: section.offset?.line ?? 0,
      column: section.offset?.column ?? 0,
      map: prepare(section.map, keepSourcesContent),
    });
  }

  if (sections.length === 0) {
    throw new SourceMapError('Index map has no usable sections.');
  }

  // Offsets are required to be ordered, but nothing enforces it in the wild.
  sections.sort((a, b) => a.line - b.line || a.column - b.column);

  return { kind: 'index', sections };
}

export interface ParseOptions {
  /**
   * Keep the original file text a map inlined, so a surface can render a
   * preview of it (D3).
   *
   * **Default false, and the default is the safe one.** The recorder must not
   * keep it: a flow is handed to an AI, and inlined original source is both a
   * token disaster and a way to leak code the user did not mean to send. The
   * panel passes true, because a preview is the thing it draws and the text
   * never leaves the page it is drawn on.
   */
  keepSourcesContent?: boolean;
}

/** Parses source map JSON. Throws `SourceMapError` on anything unusable. */
export function parseSourceMap(json: string, options: ParseOptions = {}): PreparedMap {
  let raw: RawSourceMap;
  try {
    raw = JSON.parse(json) as RawSourceMap;
  } catch {
    throw new SourceMapError('Source map is not valid JSON.');
  }
  return prepare(raw, options.keepSourcesContent ?? false);
}

/**
 * Maps a generated position back to the original source. 0-based in, 0-based
 * out — the map's own base, both ways (D1).
 *
 * Returns null when no mapping covers the position — which happens legitimately,
 * for generated code with no original counterpart — so the caller can say
 * *found in the bundle, but the map does not cover it* rather than guessing.
 *
 * The generated position stays a plain `number`: it is a bundle offset that
 * `search.ts` computed, not a value read out of a map, and branding the input
 * would put an assertion on every caller without removing one from anywhere.
 */
export function lookupOriginal(
  map: PreparedMap,
  line: number,
  column: number,
): OriginalPosition | null {
  if (map.kind === 'index') {
    const section = findSection(map.sections, line, column);
    if (!section) return null;
    return lookupOriginal(
      section.map,
      line - section.line,
      // Only the section's first line is shifted horizontally.
      line === section.line ? column - section.column : column,
    );
  }

  const segment = findSegmentInLine(decodeLine(map.mappings, line), column);
  if (!segment || segment.sourceIndex === undefined) return null;

  const rawSource = map.sources[segment.sourceIndex];
  if (rawSource === undefined) {
    throw new SourceMapError('Source map references a source index it does not define.');
  }

  return {
    source: normalizeSourcePath(rawSource),
    // No arithmetic here, deliberately. `pos0` asserts what the format already
    // says — this is the map-decoding edge that CONTRACTS §1 names as one of
    // the three places an assertion is legitimate — and `toOneBased` is applied
    // once, later, by whichever surface puts the number in front of a person.
    line: pos0(segment.originalLine ?? 0),
    column: pos0(segment.originalColumn ?? 0),
    name: segment.nameIndex === undefined ? null : (map.names[segment.nameIndex] ?? null),
    content: map.sourcesContent[segment.sourceIndex] ?? null,
  };
}

/** The last section starting at or before a position. */
function findSection(
  sections: PreparedSection[],
  line: number,
  column: number,
): PreparedSection | null {
  let found: PreparedSection | null = null;
  for (const section of sections) {
    if (section.line > line || (section.line === line && section.column > column)) break;
    found = section;
  }
  return found;
}
