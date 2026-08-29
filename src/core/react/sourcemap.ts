/**
 * Source maps: reading the annotation, parsing the JSON, and turning a position
 * in a served bundle back into the file somebody wrote.
 *
 * Ported from react-source-locator `src/core/sourcemap.ts` @ 314488d, with three
 * divergences:
 *
 *   1. **No fetching and no caching in here.** Upstream's module owns a fetch
 *      callback and two module-level caches. This one is pure: it parses text
 *      and answers lookups. The worker's resolver owns every fetch and every
 *      cache, because it is also what owns the budgets they have to respect.
 *   2. **Mappings are kept as text and decoded one line at a time** (see
 *      `vlq.ts`). A `PreparedMap` therefore holds the raw string, not a decoded
 *      object graph, and an index map keeps its sections rather than flattening
 *      them into one — flattening would defeat the streaming decode entirely.
 *   3. **Positions come back 1-based**, converted here, once. Source maps are
 *      0-based; humans, editors and stack traces are not, and a flow is read by
 *      an AI that pastes the number into an editor. Everything upstream of this
 *      function is 0-based and everything downstream is 1-based.
 *
 * Pure — no DOM, no Chrome, no network.
 */

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
  | { kind: 'plain'; mappings: string; sources: string[]; names: string[] }
  | { kind: 'index'; sections: PreparedSection[] };

interface PreparedSection {
  /** Where this section's own line 0, column 0 sits in the generated file. */
  line: number;
  column: number;
  map: PreparedMap;
}

/** A position in the file somebody actually wrote. Line and column are 1-based. */
export interface OriginalPosition {
  /** Normalised — see `normalizeSourcePath`. */
  source: string;
  /** 1-based. */
  line: number;
  /** 1-based. */
  column: number;
  /** The original identifier, when the map recorded one. */
  name: string | null;
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
 *     checked out. Upstream keeps that namespace, which is where this diverges.
 *     In a plain path the same `.` is ordinary relative navigation, so the rule
 *     is deliberately not applied there.
 *   - Leading `..` segments are dropped for the same reason: they record how far
 *     the map sat from the output directory, not where the source lives.
 *
 * **Absolute paths are kept absolute.** FlowSnap exists to hand flows to an AI
 * running on the same machine, so `/Users/me/proj/src/App.tsx` from a Vite dev
 * server is directly openable — strictly better than a guessed relative path.
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

function prepare(raw: RawSourceMap): PreparedMap {
  if (raw.sections) return prepareIndexMap(raw);

  if (typeof raw.mappings !== 'string') {
    throw new SourceMapError('Source map has no mappings.');
  }

  return {
    kind: 'plain',
    mappings: raw.mappings,
    sources: (raw.sources ?? []).map((s) => applySourceRoot(raw.sourceRoot, s ?? '')),
    names: raw.names ?? [],
  };
}

/**
 * Prepares an index map by keeping its sections rather than merging them.
 *
 * Upstream flattens every section into one decoded mapping table. Here that
 * would mean decoding every section of the map to answer one lookup, which is
 * the cost the streaming decode exists to avoid — so a lookup instead picks the
 * one section covering the position and recurses into it.
 *
 * Sections referenced by `url` are skipped, as upstream: resolving them needs
 * another fetch per section and no major bundler emits them.
 */
function prepareIndexMap(raw: RawSourceMap): PreparedMap {
  const sections: PreparedSection[] = [];

  for (const section of raw.sections ?? []) {
    if (!section.map) continue;
    sections.push({
      line: section.offset?.line ?? 0,
      column: section.offset?.column ?? 0,
      map: prepare(section.map),
    });
  }

  if (sections.length === 0) {
    throw new SourceMapError('Index map has no usable sections.');
  }

  // Offsets are required to be ordered, but nothing enforces it in the wild.
  sections.sort((a, b) => a.line - b.line || a.column - b.column);

  return { kind: 'index', sections };
}

/** Parses source map JSON. Throws `SourceMapError` on anything unusable. */
export function parseSourceMap(json: string): PreparedMap {
  let raw: RawSourceMap;
  try {
    raw = JSON.parse(json) as RawSourceMap;
  } catch {
    throw new SourceMapError('Source map is not valid JSON.');
  }
  return prepare(raw);
}

/**
 * Maps a 0-based generated position back to the original source.
 *
 * Returns null when no mapping covers the position — which happens legitimately,
 * for generated code with no original counterpart — so the caller can say
 * *found in the bundle, but the map does not cover it* rather than guessing.
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
    /*
     * The one place 0-based becomes 1-based. See the file header.
     *
     * Tier 3 — deliberately not configurable.
     * Why: get this base wrong and every
     * file opens one line off, forever, and nothing anywhere fails.
     */
    line: (segment.originalLine ?? 0) + 1,
    column: (segment.originalColumn ?? 0) + 1,
    name: segment.nameIndex === undefined ? null : (map.names[segment.nameIndex] ?? null),
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
