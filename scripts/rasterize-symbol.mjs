// Rasterize Talise's symbol.svg to PNG for email use. Email clients
// (Gmail, Outlook) don't render SVG reliably; PNG hosted at a public
// URL is the universal fallback. Re-fills the SVG with the brand
// accent (#79D96C) before rasterizing.

import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Resvg } from "@resvg/resvg-js";
import sharp from "sharp";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, "..");

const svg = await fs.readFile(path.join(WEB, "public/symbol.svg"), "utf8");
const tinted = svg.replace(/fill="[^"]*"/g, 'fill="#79D96C"');

// Display size in email is 24x22. We render at that 1x size and 2x
// retina. Earlier we rendered at 48x44 / 96x88 (4x), which produced
// a 1.5kB PNG. Rendering at the actual display size + sharp's
// palette-PNG output cuts to ~250-400 bytes, well over 3x smaller.
for (const [w, h, name] of [
  [24, 22, "symbol.png"],
  [48, 44, "symbol@2x.png"],
]) {
  const resvg = new Resvg(tinted, {
    fitTo: { mode: "width", value: w },
    background: "rgba(0,0,0,0)",
  });
  const rawPng = resvg.render().asPng();
  // Reduce to a 16-color indexed palette PNG. The glyph is a single
  // solid fill on transparent, so 16 colors is overkill anyway; the
  // PNG header overhead dominates the byte count at this size.
  const compressed = await sharp(rawPng)
    .png({ palette: true, colors: 16, compressionLevel: 9, effort: 10 })
    .toBuffer();
  await fs.writeFile(path.join(WEB, "public", name), compressed);
  console.log("wrote", name, `${w}x${h}`, `${compressed.length} bytes`);
}
