// Streaming ZIP writer: deflate through the browser's own CompressionStream, no library.
// Each entry streams straight to the sink, so a large CSV never has to fit in memory. Sizes and
// CRC are not known up front, so entries use a data descriptor (general purpose flag bit 3).
// Limits (no ZIP64): each entry and the whole archive under 4 GiB, at most 65535 entries.
// A session is far below both; crossing one throws rather than writing a corrupt archive.
// Format reference: PKWARE APPNOTE.TXT sections 4.3.7 (local header), 4.3.9 (data descriptor),
// 4.3.12 (central directory), 4.3.16 (end of central directory).

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** CRC-32 (IEEE). Pass the previous result as `crc` to continue across chunks. */
export function crc32(bytes, crc = 0) {
  let c = ~crc >>> 0;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return ~c >>> 0;
}

const MAX32 = 0xFFFFFFFF;
const enc = new TextEncoder();

function dosDateTime(d) {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

function toStream(source) {
  if (source instanceof ReadableStream) return source;
  if (typeof Blob !== 'undefined' && source instanceof Blob) return source.stream();
  const bytes = typeof source === 'string' ? enc.encode(source) : source;
  if (!(bytes instanceof Uint8Array)) throw new TypeError('zip entry source must be a Blob, ReadableStream, Uint8Array or string');
  return new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } });
}

/**
 * Write a ZIP archive.
 * @param {Array<{name: string, source: Blob|ReadableStream|Uint8Array|string, lastModified?: Date}>} entries
 * @param {{write(chunk: Uint8Array): (void|Promise<void>)}} sink  e.g. a FileSystemWritableFileStream
 * @returns {Promise<{bytes: number, entries: Array<{name: string, size: number, compressed: number, crc: number}>}>}
 */
export async function writeZip(entries, sink) {
  if (entries.length > 0xFFFF) throw new Error(`Too many files for one zip (${entries.length}, limit 65535).`);
  let offset = 0;
  const out = async (b) => { await sink.write(b); offset += b.length; if (offset > MAX32) throw new Error('Zip would pass 4 GiB. Split the session.'); };
  const central = [];

  for (const e of entries) {
    const name = enc.encode(e.name);
    const { time, date } = dosDateTime(e.lastModified || new Date());
    const localOffset = offset;

    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034B50, true);
    lh.setUint16(4, 20, true);            // version needed: 2.0 (deflate)
    lh.setUint16(6, 0x0808, true);        // bit 3: sizes in data descriptor; bit 11: UTF-8 name
    lh.setUint16(8, 8, true);             // method: deflate
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    // crc and sizes stay 0 here; the data descriptor carries them
    lh.setUint16(26, name.length, true);
    await out(new Uint8Array(lh.buffer));
    await out(name);

    let crc = 0, size = 0, compressed = 0;
    const counted = toStream(e.source).pipeThrough(new TransformStream({
      transform(chunk, ctl) {
        const b = typeof chunk === 'string' ? enc.encode(chunk) : chunk;
        crc = crc32(b, crc); size += b.length;
        if (size > MAX32) throw new Error(`${e.name} is over 4 GiB, too big for this zip writer.`);
        ctl.enqueue(b);
      },
    })).pipeThrough(new CompressionStream('deflate-raw'));
    const reader = counted.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      compressed += value.length;
      await out(value);
    }

    const dd = new DataView(new ArrayBuffer(16));
    dd.setUint32(0, 0x08074B50, true);
    dd.setUint32(4, crc, true);
    dd.setUint32(8, compressed, true);
    dd.setUint32(12, size, true);
    await out(new Uint8Array(dd.buffer));

    central.push({ name, time, date, crc, compressed, size, localOffset });
  }

  const cdStart = offset;
  for (const c of central) {
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014B50, true);
    ch.setUint16(4, 0x0314, true);        // made by: Unix (3), spec 2.0, so file modes below are honoured
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0808, true);
    ch.setUint16(10, 8, true);
    ch.setUint16(12, c.time, true);
    ch.setUint16(14, c.date, true);
    ch.setUint32(16, c.crc, true);
    ch.setUint32(20, c.compressed, true);
    ch.setUint32(24, c.size, true);
    ch.setUint16(28, c.name.length, true);
    ch.setUint32(38, (0o100644 << 16) >>> 0, true); // regular file, rw-r--r--
    ch.setUint32(42, c.localOffset, true);
    await out(new Uint8Array(ch.buffer));
    await out(c.name);
  }
  const cdSize = offset - cdStart;

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054B50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, cdSize, true);
  eocd.setUint32(16, cdStart, true);
  await out(new Uint8Array(eocd.buffer));

  return {
    bytes: offset,
    entries: central.map((c) => ({ name: new TextDecoder().decode(c.name), size: c.size, compressed: c.compressed, crc: c.crc })),
  };
}

/** Convenience: build the whole archive as a Blob (for the Download session fallback). */
export async function zipToBlob(entries) {
  const parts = [];
  await writeZip(entries, { write: (b) => { parts.push(b); } });
  return new Blob(parts, { type: 'application/zip' });
}
