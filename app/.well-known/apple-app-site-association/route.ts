import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-static";

/**
 * Universal Links manifest. Apple fetches this at install time to learn
 * which paths the Talise app handles. We claim the real public link
 * surfaces:
 *   - /pay/<handle>  — payment links
 *   - /c/<id>        — cheques (claimable money links)
 *   - /i/<id>        — invoices
 *
 * The team ID defaults to the real App ID prefix (5N8DU2A9WH — the
 * DEVELOPMENT_TEAM in the Xcode project / ExportOptions.plist);
 * APPLE_TEAM_ID still overrides it if set. The bundle ID matches
 * `ios/project.yml` (io.talise.app).
 */
const TEAM_ID = process.env.APPLE_TEAM_ID ?? "5N8DU2A9WH";
const BUNDLE_ID = "io.talise.app";

export async function GET() {
  return NextResponse.json({
    applinks: {
      apps: [],
      details: [
        {
          appID: `${TEAM_ID}.${BUNDLE_ID}`,
          paths: ["/pay/*", "/c/*", "/i/*"],
        },
      ],
    },
    webcredentials: {
      apps: [`${TEAM_ID}.${BUNDLE_ID}`],
    },
  }, {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
