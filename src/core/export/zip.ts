/**
 * ZIP writer with optional deflate, no dependencies.
 *
 * Runs in an extension page, where Blob / TextEncoder / DataView /
 * CompressionStream all exist. `createZip` is async because deflate is.
 */

/**
 * Bytes backed by a plain ArrayBuffer. `Uint8Array` alone widens to
 * `ArrayBufferLike`, which includes `SharedArrayBuffer` and so is rejected by
 * `Blob` and by the streams API.
 */
export type Bytes = Uint8Array<ArrayBuffer>;

export interface ZipEntry {
  name: string;
  data: Bytes;
}

/** ZIP requires a CRC32 per entry. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Bytes): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Compress with raw DEFLATE (ZIP method 8). Falls back to the original bytes
 * when the result would be larger — which it is for already-compressed input
 * like JPEG.
 */
async function deflateRaw(bytes: Bytes): Promise<{ data: Bytes; compressed: boolean }> {
  if (typeof CompressionStream === 'undefined') return { data: bytes, compressed: false };

  try {
    const cs = new CompressionStream('deflate-raw');
    const writer = cs.writable.getWriter();
    void writer.write(bytes);
    void writer.close();

    const chunks: Uint8Array<ArrayBufferLike>[] = [];
    const reader = cs.readable.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }

    const totalLen = chunks.reduce((n, c) => n + c.length, 0);
    if (totalLen >= bytes.length) return { data: bytes, compressed: false };

    const out = new Uint8Array(totalLen);
    let offset = 0;
    for (const chunk of chunks) {
      out.set(chunk, offset);
      offset += chunk.length;
    }
    return { data: out, compressed: true };
  } catch {
    return { data: bytes, compressed: false };
  }
}

const IMAGE_RE = /\.(jpg|jpeg|png|gif|webp)$/i;

/**
 * Build a ZIP archive from a list of entries.
 *
 * A `.gitignore` is prepended so that unzipping a flow into a repository does
 * not accidentally commit screenshots of whatever the user was recording.
 */
export async function createZip(files: ZipEntry[]): Promise<Blob> {
  const encoder = new TextEncoder();
  const allFiles: ZipEntry[] = [{ name: '.gitignore', data: encoder.encode('*\n') }, ...files];

  const localChunks: Bytes[] = [];
  const centralChunks: Bytes[] = [];
  let offset = 0;

  for (const file of allFiles) {
    const nameBytes = encoder.encode(file.name);
    const raw = file.data;

    const { data, compressed } = IMAGE_RE.test(file.name)
      ? { data: raw, compressed: false }
      : await deflateRaw(raw);

    const compression = compressed ? 8 : 0;
    const crc = crc32(raw); // always of the uncompressed data
    const compSize = data.length;
    const uncompSize = raw.length;

    // Local file header: 30 bytes + filename.
    const local = new Uint8Array(30 + nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0, true); // flags
    lv.setUint16(8, compression, true); // 0 = store, 8 = deflate
    lv.setUint16(10, 0, true); // mod time
    lv.setUint16(12, 0, true); // mod date
    lv.setUint32(14, crc, true);
    lv.setUint32(18, compSize, true);
    lv.setUint32(22, uncompSize, true);
    lv.setUint16(26, nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra field length
    local.set(nameBytes, 30);

    localChunks.push(local, data);

    // Central directory header: 46 bytes + filename.
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true);
    cv.setUint16(6, 20, true);
    cv.setUint16(8, 0, true);
    cv.setUint16(10, compression, true);
    cv.setUint16(12, 0, true);
    cv.setUint16(14, 0, true);
    cv.setUint32(16, crc, true);
    cv.setUint32(20, compSize, true);
    cv.setUint32(24, uncompSize, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint16(30, 0, true);
    cv.setUint16(32, 0, true);
    cv.setUint16(34, 0, true);
    cv.setUint16(36, 0, true);
    cv.setUint32(38, 0, true);
    cv.setUint32(42, offset, true); // local header offset
    central.set(nameBytes, 46);

    centralChunks.push(central);
    offset += local.length + data.length;
  }

  const centralSize = centralChunks.reduce((n, c) => n + c.length, 0);
  const centralOffset = offset;

  // End of central directory record: 22 bytes.
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true);
  ev.setUint16(6, 0, true);
  ev.setUint16(8, allFiles.length, true);
  ev.setUint16(10, allFiles.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, centralOffset, true);
  ev.setUint16(20, 0, true);

  return new Blob([...localChunks, ...centralChunks, eocd], { type: 'application/zip' });
}

/** Decode a `data:image/…;base64,…` URL into bytes plus a file extension. */
export function dataUrlToBytes(dataUrl: string): { bytes: Bytes; ext: string } {
  const comma = dataUrl.indexOf(',');
  const header = dataUrl.slice(0, comma);
  const binary = atob(dataUrl.slice(comma + 1));

  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const mime = /data:([^;]+)/.exec(header)?.[1] ?? 'image/jpeg';
  return { bytes, ext: mime === 'image/png' ? 'png' : 'jpg' };
}
