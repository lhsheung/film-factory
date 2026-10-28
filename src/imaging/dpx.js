"use strict";

// SMPTE 268M DPX, 10-bit RGB — the container the Digital Intermediate ships in.
//
// Upstream writes its DI through the host; there is no host-side writer here,
// so this module writes the file directly: a 2048-byte header (768 generic +
// 640 image + 640 orientation) and 10-bit RGB packed three to a 32-bit word,
// which is what Cineon-lineage tools expect from a log DI.

const HEADER_BYTES = 2048;

function pad(text, length) {
  const out = Buffer.alloc(length);
  out.write(String(text).slice(0, length - 1), 0, "ascii");
  return out;
}

function timestamp(date) {
  const p = (v) => String(v).padStart(2, "0");
  return `${date.getUTCFullYear()}:${p(date.getUTCMonth() + 1)}:${p(date.getUTCDate())}:`
    + `${p(date.getUTCHours())}:${p(date.getUTCMinutes())}:${p(date.getUTCSeconds())}:GMT`;
}

function pack10bit(words) {
  const n = words.length;
  const groupCount = Math.ceil(n / 3);
  const out = Buffer.alloc(groupCount * 4);
  for (let g = 0; g < groupCount; g += 1) {
    const r = words[3 * g] & 0x3ff;
    const gg = words[3 * g + 1] & 0x3ff;
    const b = words[3 * g + 2] & 0x3ff;
    // DPX packs the three samples into the low 30 bits, datum 1 in bits 0-9.
    const value = ((r << 22) | (gg << 12) | (b << 2)) >>> 0;
    out.writeUInt32BE(value, g * 4);
  }
  return out;
}

/**
 * @param {object} options
 *   width, height
 *   data: Uint16Array of 10-bit code values (0..1023), 3 per pixel
 *   creator, description
 * @returns {Buffer}
 */
function writeDpx(options) {
  const { width, height, data } = options;
  const payload = pack10bit(data);
  const total = HEADER_BYTES + payload.length;
  const header = Buffer.alloc(HEADER_BYTES);

  // --- generic file header (768 bytes) ---
  header.write("SDPX", 0, "ascii");
  header.writeUInt32BE(HEADER_BYTES, 4);
  header.write("V2.0", 8, "ascii");
  header.writeUInt32BE(total, 12);
  header.writeUInt32BE(0, 16);              // ditto key: new frame
  header.writeUInt32BE(768, 20);            // generic header size
  header.writeUInt32BE(640, 24);            // industry header size
  header.writeUInt32BE(0, 28);              // user header size
  pad(options.filename || "DI.dpx", 100).copy(header, 32);
  pad(timestamp(new Date()), 24).copy(header, 132);
  pad(options.creator || "几多筒菲林", 100).copy(header, 156);
  pad(options.project || "几多筒菲林 Cineon DI", 200).copy(header, 256);
  pad(options.copyright || "", 200).copy(header, 456);
  header.writeUInt32BE(0xffffffff, 660);    // encryption: none

  // --- image information header (640 bytes at 768) ---
  const image = 768;
  header.writeUInt16BE(0, image + 0);       // orientation: left to right, top to bottom
  header.writeUInt16BE(1, image + 2);       // number of image elements
  header.writeUInt32BE(width, image + 4);   // pixels per line
  header.writeUInt32BE(height, image + 8);  // lines per element
  // element 1 (40 bytes at image + 12)
  const el = image + 12;
  header.writeUInt32BE(0, el + 0);          // data sign: unsigned
  header.writeUInt32BE(0, el + 4);          // reference low data
  header.writeFloatBE(0, el + 8);           // reference low quantity
  header.writeUInt32BE(1023, el + 12);      // reference high data
  header.writeFloatBE(2.048, el + 16);      // reference high quantity (density)
  header.writeUInt8(50, el + 20);           // descriptor: RGB
  header.writeUInt8(1, el + 21);            // transfer: printing density
  header.writeUInt8(1, el + 22);            // colorimetric: printing density
  header.writeUInt8(10, el + 23);           // bit size
  header.writeUInt16BE(1, el + 24);         // packing: filled to 32-bit words
  header.writeUInt16BE(0, el + 26);         // encoding: none
  header.writeUInt32BE(HEADER_BYTES, el + 28);
  header.writeUInt32BE(0, el + 32);         // end-of-line padding
  header.writeUInt32BE(0, el + 36);         // end-of-file padding
  pad(options.description || "Cineon log, 300 codes per decade", 32).copy(header, el + 40);

  return Buffer.concat([header, payload]);
}

/** Read a DPX header back — used by the tests to prove the file is well formed. */
function readDpxHeader(buffer) {
  return {
    magic: buffer.toString("ascii", 0, 4),
    offset: buffer.readUInt32BE(4),
    version: buffer.toString("ascii", 8, 12),
    total: buffer.readUInt32BE(12),
    genericHeaderSize: buffer.readUInt32BE(20),
    industryHeaderSize: buffer.readUInt32BE(24),
    width: buffer.readUInt32BE(772),
    height: buffer.readUInt32BE(776),
    bitSize: buffer.readUInt8(768 + 12 + 23),
    descriptor: buffer.readUInt8(768 + 12 + 20),
    packing: buffer.readUInt16BE(768 + 12 + 24),
    dataOffset: buffer.readUInt32BE(768 + 12 + 28)
  };
}

module.exports = { writeDpx, readDpxHeader, pack10bit, HEADER_BYTES };
