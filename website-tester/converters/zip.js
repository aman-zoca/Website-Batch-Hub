// Minimal dependency-free ZIP writer (STORE method — no compression).
// Enough to bundle a handful of small CSV/JSON text files into one .zip.
// Uses Node's built-in zlib.crc32 (Node >= 22.2).

import zlib from "node:zlib";

/** files: { name: string|Buffer }. Returns a Buffer of the .zip. */
export function makeZip(files) {
  const entries = [];
  const chunks = [];
  let offset = 0;

  const dosDateTime = () => ({ time: 0, date: 0x21 }); // fixed 1980-01-01 (deterministic)

  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.isBuffer(content)
      ? content
      : Buffer.from(String(content), "utf8");
    const nameBuf = Buffer.from(name, "utf8");
    const crc = zlib.crc32(data) >>> 0;
    const { time, date } = dosDateTime();

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header sig
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(0, 8); // method: store
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28); // extra len

    chunks.push(local, nameBuf, data);
    entries.push({ nameBuf, crc, size: data.length, offset, time, date });
    offset += local.length + nameBuf.length + data.length;
  }

  const central = [];
  let cdSize = 0;
  for (const e of entries) {
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); // central dir header sig
    c.writeUInt16LE(20, 4); // version made by
    c.writeUInt16LE(20, 6); // version needed
    c.writeUInt16LE(0, 8); // flags
    c.writeUInt16LE(0, 10); // method
    c.writeUInt16LE(e.time, 12);
    c.writeUInt16LE(e.date, 14);
    c.writeUInt32LE(e.crc, 16);
    c.writeUInt32LE(e.size, 20);
    c.writeUInt32LE(e.size, 24);
    c.writeUInt16LE(e.nameBuf.length, 28);
    c.writeUInt16LE(0, 30); // extra
    c.writeUInt16LE(0, 32); // comment
    c.writeUInt16LE(0, 34); // disk start
    c.writeUInt16LE(0, 36); // internal attrs
    c.writeUInt32LE(0, 38); // external attrs
    c.writeUInt32LE(e.offset, 42); // local header offset
    central.push(c, e.nameBuf);
    cdSize += c.length + e.nameBuf.length;
  }

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // EOCD sig
  eocd.writeUInt16LE(0, 4); // disk
  eocd.writeUInt16LE(0, 6); // cd start disk
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16); // cd offset
  eocd.writeUInt16LE(0, 20); // comment len

  return Buffer.concat([...chunks, ...central, eocd]);
}
