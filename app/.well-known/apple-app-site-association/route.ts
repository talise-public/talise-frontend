import { NextResponse } from "next/server";

export const runtime = "edge";
export const dynamic = "force-static";

/**
 * Universal Links manifest. Apple fetches this at install time to learn
 * which paths the Talise app handles.
 *
 * IMPORTANT: `public/.well-known/apple-app-site-association` is a real static
 * file on the same path and is what actually gets served (filesystem assets are
 * matched before route handlers). This handler is the fallback, so the two MUST
 * agree, they previously did not. Change both or neither.
 *
 * Claimed paths, and only paths the app can actually handle:
 *   - /r/<CODE> , referral invites. Newly claimed: the invite link was NOT in
 *     this list, so tapping an invite on a device with Talise installed opened
 *     Safari and the app never saw the inviter's code. `DeepLink.route` in
 *     ios/Talise/App/AppRoot.swift now captures it.
 *   - /c/<id>   , cheques (claimable money links), handled by DeepLink.route.
 *
 * Deliberately NOT claimed: /pay/* and /i/*. This handler used to list them,
 * but `DeepLink.route` drops anything that is not a cheque or a referral, so
 * claiming them turned a working web payment link into a silent dead end
 * (app opens, nothing happens, no way back). Add them here only together with
 * real in-app routing. The static file never claimed them.
 *
 * The team ID defaults to the real App ID prefix (5N8DU2A9WH, the
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
          paths: ["/r/*", "/c/*"],
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
