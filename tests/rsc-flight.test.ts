/**
 * The flight-payload reader, against bytes that were really on a wire.
 *
 * **Every row string in this file is transcribed from `.ctx/spike-rsc.md`**,
 * which printed them off a real Next 16.3.4 / React 19.2.8 App Router app —
 * §1 for the prod rows and the two element arities, §2 for the dev `I` rows and
 * the `D` rows whose referents are not on the HTTP stream at all, §6 for the
 * out-of-order chunk timings. Nothing here is invented except where a comment
 * says so, and the two places it does are marked.
 *
 * Dev and prod row shapes are tested apart on purpose. The spike's own warning
 * is that "a parser written against prod bytes will silently mis-index dev
 * bytes, and vice versa" — silently being the operative word, since both shapes
 * are valid JSON arrays and neither throws.
 */

import { describe, expect, it } from 'vitest';
import {
  buildFlightModel,
  buildFromFlight,
  flightElementFor,
  joinFlightChunks,
  normalizeModulePath,
  parseFlightPayload,
  readElement,
  readReference,
  resolveValue,
  rowValue,
  splitFlightRows,
} from '../src/core/rsc/flight.js';

// ── The fixtures ─────────────────────────────────────────────────────────────

/** spike-rsc §1, "Real rows, verbatim, from prod". */
const PROD_ROWS = [
  '1:"$Sreact.fragment"',
  '2:I[39756,["/_next/static/chunks/3fntmmi971322.js"],"default"]',
  '6:"$Sreact.suspense"',
  'e:I[68027,["/_next/static/chunks/3fntmmi971322.js"],"default",1]',
  'b:[["$","meta","0",{"charSet":"utf-8"}],["$","meta","1",{"name":"viewport","content":"width=device-width, initial-scale=1"}]]',
  '7:["$","div",null,{"id":"slow-server-data","children":[["$","h2",null,{"children":"SlowServerData"}],["$","p",null,{"children":"marker=SPIKE_SUSPENDED_PAYLOAD_ARRIVED"}]]}]',
].join('\n');

/**
 * spike-rsc §2, the dev `I` rows and the `D` rows around the server component.
 *
 * The one edit: the spike printed row 32's props elided as
 * `{"id":"server-only","data-computed":29,…}`. The ellipsis is dropped here so
 * the row is parseable JSON; every key that is present was printed.
 */
const DEV_ROWS = [
  '3f:I["[project]/app/components/ClientCounter.tsx [app-client] (ecmascript)",["/_next/static/chunks/node_modules_next_dist_20wefz_._.js","/_next/static/chunks/_098lxtj._.js"],"default"]',
  '41:I["[project]/app/components/ActionForm.tsx [app-client] (ecmascript)",["/_next/static/chunks/_098lxtj._.js"],"default"]',
  '32:D"$34"',
  '32:D"$33"',
  '32:["$","div",null,{"id":"server-only","data-computed":29},"$33","$35",1]',
].join('\n');

describe('splitFlightRows', () => {
  it('reads the hex id, the optional tag and the payload of every prod row', () => {
    const { rows } = splitFlightRows(`${PROD_ROWS}\n`);

    expect(rows.map((r) => [r.id, r.tag])).toEqual([
      ['1', ''],
      ['2', 'I'],
      ['6', ''],
      ['e', 'I'],
      ['b', ''],
      ['7', ''],
    ]);
  });

  /*
   * §1: "The id is lowercase hex, not decimal — row 45 is followed by row 46 …
   * 4e … 5c." Kept as a string throughout, because `e` parsed to 14 and then
   * printed is a row id that does not exist in the stream.
   */
  it('keeps a hex id as the string it was sent as', () => {
    const { rows } = splitFlightRows('e:I[68027,[],"default",1]\n');
    expect(rows[0].id).toBe('e');
  });

  /*
   * §6 timed CHUNK 1 ending inside `2:I[39756,` and CHUNK 2 opening mid-row.
   * The unterminated tail is handed back rather than parsed, so a streaming
   * caller can prepend it to what comes next.
   */
  it('returns the unterminated tail as pending rather than parsing it', () => {
    const { rows, pending } = splitFlightRows('1:"$Sreact.fragment"\n2:I[39756,');
    expect(rows).toHaveLength(1);
    expect(pending).toBe('2:I[39756,');
  });

  it('joins chunks before splitting, so a straddling row survives', () => {
    const { rows } = splitFlightRows(
      `${joinFlightChunks(['1:"$Sreact.frag', 'ment"\n'])}`,
    );
    expect(rows).toHaveLength(1);
    expect(rowValue(buildFlightModel(rows), '1')).toBe('$Sreact.fragment');
  });

  it('ignores a line that is not row-shaped instead of inventing a row', () => {
    const { rows } = splitFlightRows('not a row at all: nope\n1:"$Sreact.fragment"\n');
    expect(rows).toHaveLength(1);
  });
});

describe('readReference', () => {
  it('reads every pointer form the spike inventoried', () => {
    expect(readReference('$L7')).toEqual({ kind: 'lazy', id: '7' });
    expect(readReference('$33')).toEqual({ kind: 'back', id: '33' });
    expect(readReference('$Sreact.fragment')).toEqual({ kind: 'symbol', name: 'react.fragment' });
    expect(readReference('$@30')).toEqual({ kind: 'promise', id: '30' });
    expect(readReference('$undefined')).toEqual({ kind: 'undefined' });
    expect(readReference('$Y')).toEqual({ kind: 'omitted' });
  });

  it('is null for ordinary text, so a page string is never read as a pointer', () => {
    expect(readReference('marker=SPIKE_SERVER_RENDERED_TEXT')).toBeNull();
    expect(readReference('')).toBeNull();
  });
});

describe('readElement — the two arities', () => {
  /** §1, the same `<p>` printed side by side in the two builds. */
  const PROD_TUPLE = JSON.parse(
    '["$","p",null,{"children":"marker=SPIKE_SERVER_RENDERED_TEXT"}]',
  ) as unknown;
  const DEV_TUPLE = JSON.parse(
    '["$","p",null,{"children":"marker=SPIKE_SERVER_RENDERED_TEXT"},"$37","$39",1]',
  ) as unknown;

  it('reads type, key and props identically in both, and stamps the shape', () => {
    const prod = readElement(PROD_TUPLE);
    const dev = readElement(DEV_TUPLE);

    expect(prod).toMatchObject({ type: 'p', key: null, shape: 'prod' });
    expect(dev).toMatchObject({ type: 'p', key: null, shape: 'dev' });
    expect(prod?.props).toEqual(dev?.props);
  });

  /*
   * The mis-index the spike warns about, stated as an assertion rather than as
   * prose: the dev tuple's props are slot 3 and not slot 5, and the owner and
   * stack references are never mistaken for them.
   */
  it('does not let the dev extras displace props', () => {
    const dev = readElement(DEV_TUPLE);
    expect(dev?.props).toEqual({ children: 'marker=SPIKE_SERVER_RENDERED_TEXT' });
    expect(dev?.owner).toBe('$37');
    expect(dev?.stack).toBe('$39');
    expect(dev?.validated).toBe(1);
  });

  /*
   * Three extras, not two. The roadmap's summary says two; the spike's own
   * annotation names `owner`, `stack` and `validated`, and 4 + 3 = 7 is what the
   * bytes are. Anything indexing from the end of the tuple depends on this.
   */
  it('counts seven slots in dev and four in prod', () => {
    expect((DEV_TUPLE as unknown[]).length).toBe(7);
    expect((PROD_TUPLE as unknown[]).length).toBe(4);
  });

  it('leaves the dev-only slots undefined on a prod tuple', () => {
    const prod = readElement(PROD_TUPLE);
    expect(prod?.owner).toBeUndefined();
    expect(prod?.stack).toBeUndefined();
  });

  it('is null for an array that is not an element', () => {
    expect(readElement(['x', 'p', null, {}])).toBeNull();
    expect(readElement(['$', 'p'])).toBeNull();
    expect(readElement({ $: 'p' })).toBeNull();
  });
});

describe('client module references', () => {
  it('reads a dev I row down to the file it names', () => {
    const { model } = parseFlightPayload(`${DEV_ROWS}\n`);
    const ref = model.modules.get('3f');

    expect(ref?.moduleId).toBe('[project]/app/components/ClientCounter.tsx [app-client] (ecmascript)');
    expect(ref?.sourceFile).toBe('app/components/ClientCounter.tsx');
    expect(ref?.exportName).toBe('default');
    expect(ref?.chunks).toHaveLength(2);
  });

  /*
   * §2's whole point: the same row in prod is an opaque integer, and there is no
   * file to be had from the browser. `sourceFile` being null is the finding, not
   * a parse failure — `mcp-server/rsc.js` is what closes it.
   */
  it('reports a prod I row as an integer with no file', () => {
    const { model } = parseFlightPayload(`${PROD_ROWS}\n`);
    const ref = model.modules.get('2');

    expect(ref?.moduleId).toBe(39756);
    expect(ref?.sourceFile).toBeNull();
    expect(ref?.exportName).toBe('default');
  });

  it('normalizes the two spellings of one file to the same path', () => {
    expect(
      normalizeModulePath('[project]/app/components/ClientCounter.tsx [app-client] (ecmascript)'),
    ).toBe('app/components/ClientCounter.tsx');
    // The on-disk manifest's key for the same file — spike §4.
    expect(normalizeModulePath('[project]/app/components/ClientCounter.tsx')).toBe(
      'app/components/ClientCounter.tsx',
    );
  });

  it('refuses an id that is not path-shaped rather than returning it unchanged', () => {
    expect(normalizeModulePath(56850)).toBeNull();
    expect(normalizeModulePath('56850')).toBeNull();
  });
});

describe('buildFromFlight — the build, without walking anything', () => {
  it('calls a string module id development', () => {
    expect(parseFlightPayload(`${DEV_ROWS}\n`).build).toBe('development');
  });

  it('calls an integer module id production', () => {
    expect(parseFlightPayload(`${PROD_ROWS}\n`).build).toBe('production');
  });

  /*
   * Not a default. A page with no I row at all must not be reported as
   * production, because production is what makes every component `absent`.
   */
  it('says unknown rather than guessing when there is no I row', () => {
    expect(parseFlightPayload('1:"$Sreact.fragment"\n').build).toBe('unknown');
  });

  it('falls back to a D row when there is no I row', () => {
    const { rows } = splitFlightRows('32:D"$34"\n');
    expect(buildFromFlight(buildFlightModel(rows))).toBe('development');
  });
});

describe('out-of-order rows', () => {
  /**
   * §6, transcribed: CHUNK 2 at +10ms carries the shell with `"children":"$L7"`,
   * and the row whose id is `7` arrives at +1511ms. The two are given to the
   * reader in that order here, which is the order they arrived in.
   */
  const SHELL = '0:["$","div",null,{"id":"shell","children":"$L7"}]';
  const LATE = '7:["$","div",null,{"id":"slow-server-data","children":"arrived"}]';

  it('names the reference as unresolved while its row has not arrived', () => {
    const { model } = parseFlightPayload(`${SHELL}\n`);
    expect(model.unresolved).toEqual(['7']);

    const shell = readElement(rowValue(model, '0'));
    const props = resolveValue(model, shell?.props) as { children: unknown };
    expect(props.children).toEqual({ unresolved: true, id: '7' });
  });

  /*
   * The accumulate-then-resolve property itself: the same reference resolves
   * once the later row is in the model, with nothing about the earlier row
   * re-parsed or re-ordered. Arrival order is not a join key; the id is.
   */
  it('resolves the same reference once the late row is in the model', () => {
    const { model } = parseFlightPayload(`${SHELL}\n${LATE}\n`);
    expect(model.unresolved).toEqual([]);

    const shell = readElement(rowValue(model, '0'));
    const props = resolveValue(model, shell?.props) as { children: unknown };
    expect(readElement(props.children)).toMatchObject({ type: 'div' });
  });

  /*
   * Reversed arrival — the referent first — must give the identical answer.
   * If it did not, the reader would be depending on order somewhere.
   */
  it('gives the same answer when the rows arrive in the other order', () => {
    const forward = parseFlightPayload(`${SHELL}\n${LATE}\n`);
    const backward = parseFlightPayload(`${LATE}\n${SHELL}\n`);

    const of = (m: typeof forward.model): unknown =>
      resolveValue(m, readElement(rowValue(m, '0'))?.props);

    expect(of(backward.model)).toEqual(of(forward.model));
  });

  /*
   * §2: rows 33, 34 and 35 are referenced by the dev HTTP stream and are not on
   * it — they arrive on the HMR websocket. That is a permanent absence for an
   * HTTP-only reader, and it must read as "not here" rather than as a crash or
   * as an empty render.
   */
  it('leaves the dev debug-channel ids unresolved without failing', () => {
    const { model } = parseFlightPayload(`${DEV_ROWS}\n`);
    expect(model.unresolved).toContain('33');
    expect(model.unresolved).toContain('35');
    expect(model.unresolved).not.toContain('3f');
  });

  it('survives a row that references itself', () => {
    const { model } = parseFlightPayload('4:["$","div",null,{"children":"$4"}]\n');
    expect(() => resolveValue(model, rowValue(model, '4'))).not.toThrow();
  });
});

describe('flightElementFor — was this markup rendered on the server', () => {
  it('finds a server-rendered element by its id, however deep', () => {
    const { model } = parseFlightPayload(`${PROD_ROWS}\n`);
    const found = flightElementFor(model, {
      tag: 'div',
      attributes: { id: 'slow-server-data' },
    });
    expect(found).toMatchObject({ type: 'div', shape: 'prod' });
  });

  it('finds one nested inside another element rather than only at the row root', () => {
    const { model } = parseFlightPayload(`${PROD_ROWS}\n`);
    expect(flightElementFor(model, { tag: 'h2', attributes: {} })).toBeNull();
    expect(
      flightElementFor(model, { tag: 'meta', attributes: { 'data-x': 'y' } }),
    ).toBeNull();
  });

  it('matches on a data attribute when there is no id', () => {
    const { model } = parseFlightPayload(`${DEV_ROWS}\n`);
    const found = flightElementFor(model, {
      tag: 'div',
      attributes: { 'data-computed': '29' },
    });
    expect(found).toMatchObject({ type: 'div', shape: 'dev' });
  });

  /*
   * The refusal, and the reason it is a refusal. A bare `<div>` matches the
   * first `<div>` in any payload, and the wrong answer that produces is not
   * "no idea" — it is a confident `server-rendered` on a client component.
   */
  it('refuses an element with nothing distinguishing about it', () => {
    const { model } = parseFlightPayload(`${PROD_ROWS}\n`);
    expect(flightElementFor(model, { tag: 'div', attributes: {} })).toBeNull();
    expect(flightElementFor(model, { tag: 'div', attributes: { class: 'card' } })).toBeNull();
  });

  it('does not match an element the payload does not carry', () => {
    const { model } = parseFlightPayload(`${PROD_ROWS}\n`);
    expect(
      flightElementFor(model, { tag: 'button', attributes: { id: 'counter' } }),
    ).toBeNull();
  });
});
