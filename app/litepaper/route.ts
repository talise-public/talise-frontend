import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-static";

export async function GET() {
  const pdf = await readFile(path.join(process.cwd(), "public", "litepaper.pdf"));
  // Cast to BodyInit-compatible Uint8Array view so NextResponse accepts the buffer.
  const body = new Uint8Array(pdf.buffer, pdf.byteOffset, pdf.byteLength);
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": 'inline; filename="talise-litepaper.pdf"',
      "Cache-Control": "public, max-age=3600, s-maxage=86400",
    },
  });
}
