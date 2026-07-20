import { NextResponse } from "next/server";
import { normalizeHandle, RESERVED_USERNAMES } from "@/lib/handle";
import { suins } from "@/lib/suins-operator";

export const runtime = "nodejs";

/**
 * GET /api/username/check?u=<input>
 *
 * Availability comes from SuiNS on chain, `getNameRecord` returns null if
 * `<name>.talise.sui` hasn't been minted yet. Source of truth is chain;
 * no DB.
 */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const raw = (url.searchParams.get("u") ?? "").trim();
  if (!raw) {
    return NextResponse.json({ available: false, reason: "empty" });
  }
  const username = normalizeHandle(raw);
  if (!username) {
    return NextResponse.json({ available: false, reason: "invalid" });
  }
  if (RESERVED_USERNAMES.has(username)) {
    return NextResponse.json({ available: false, reason: "reserved" });
  }
  try {
    const record = await suins().getNameRecord(`${username}.talise.sui`);
    if (record) {
      return NextResponse.json({ available: false, reason: "taken" });
    }
    return NextResponse.json({ available: true });
  } catch (e) {
    // SuinsClient throws when the dynamic field for the name doesn't
    // exist on chain, that means the name is unclaimed AND available.
    // The error message comes through in two shapes depending on
    // transport / SDK version: "does not exist", "not exist", or
    // "Object 0x… not found". All three signal the same thing: free.
    // Without "not found" in the regex, free names fall through to
    // `available: false, reason: "rpc"` and iOS reads it as taken.
    const msg = (e as Error).message ?? "";
    if (/(not exist|not found)/i.test(msg)) {
      return NextResponse.json({ available: true });
    }
    return NextResponse.json({ available: false, reason: "rpc" });
  }
}
