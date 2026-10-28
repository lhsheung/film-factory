"use strict";

const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const root = path.resolve(__dirname, "..");
const svg = `
<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256">
  <rect x="8" y="8" width="240" height="240" rx="54" fill="#161713"/>
  <rect x="30" y="60" width="196" height="136" rx="22" fill="#23241f" stroke="#b08a55" stroke-width="4"/>
  <g fill="#e5ad68">
    <rect x="58" y="78" width="18" height="100" rx="4"/>
    <rect x="92" y="78" width="18" height="100" rx="4"/>
    <rect x="126" y="78" width="18" height="100" rx="4"/>
  </g>
  <rect x="158" y="78" width="42" height="100" rx="10" fill="none" stroke="#e5ad68" stroke-width="4"/>
  <circle cx="179" cy="128" r="12" fill="#e5ad68"/>
</svg>`;

async function main() {
  const png = await sharp(Buffer.from(svg)).png().toBuffer();
  fs.writeFileSync(path.join(root, "assets", "icon.png"), png);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(1, 4);
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0, 0);
  entry.writeUInt8(0, 1);
  entry.writeUInt8(0, 2);
  entry.writeUInt8(0, 3);
  entry.writeUInt16LE(1, 4);
  entry.writeUInt16LE(32, 6);
  entry.writeUInt32LE(png.length, 8);
  entry.writeUInt32LE(22, 12);
  fs.writeFileSync(path.join(root, "assets", "icon.ico"), Buffer.concat([header, entry, png]));
  process.stdout.write(`icon.png ${png.length} bytes\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});
