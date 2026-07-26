import { NextResponse } from "next/server";

export const runtime = "edge";
// Deliberately NOT `force-static`: the fingerprints come from an env var, and a
// statically-baked response would freeze whatever was set at build time (and
// Next warns that the two directives are incompatible anyway). The
// Cache-Control header below is what actually keeps this cheap.
export const dynamic = "force-dynamic";

/**
 * Android App Links manifest, `/.well-known/assetlinks.json`.
 *
 * This file did not exist. `mobile/app.json` declares `autoVerify: true` intent
 * filters for talise.io / www.talise.io / app.talise.io, and Android verifies
 * those by fetching THIS document at install time. With it missing, every
 * verification failed, which means NO Android App Link was ever verified:
 * invite links and cheque-claim links both fell through to the browser instead
 * of opening Talise, and Android showed the disambiguation dialog at best.
 *
 * Package name comes from `mobile/app.json` (`android.package`) and matches the
 * legacy native module's `applicationId` in `android/app/build.gradle.kts`:
 * io.talise.app.
 *
 * ── FINGERPRINTS: value you must fill in ──────────────────────────────────
 * The signing certificate SHA-256 is NOT in this repo. The Android keystore is
 * managed by EAS (no keystore file, no credentials.json is checked in, by
 * design), so it cannot be derived from source. Set it as an env var:
 *
 *   ANDROID_CERT_FINGERPRINTS="AA:BB:…:FF,11:22:…:99"
 *
 * Comma or whitespace separated, colon-delimited uppercase hex, which is
 * exactly the format the tools below print. You almost always need TWO:
 *
 *   1. The UPLOAD key (what EAS signs your build with):
 *        cd mobile && eas credentials -p android
 *      then read "SHA256 Fingerprint" for the production keystore.
 *      Equivalently, from a downloaded APK:
 *        keytool -printcert -jarfile app.apk
 *
 *   2. The Play App Signing key (what Google RE-SIGNS with before serving to
 *      devices) once the app is on the Play Store:
 *        Play Console → your app → Test and release → Setup → App integrity
 *        → App signing key certificate → SHA-256 certificate fingerprint
 *
 * Ship both. Builds installed directly (EAS internal/APK) verify against (1);
 * Play installs verify against (2). Omitting (2) is the classic "App Links work
 * on my test APK but not from the Play Store" bug.
 *
 * Until the env var is set this route serves a valid, EMPTY statement list:
 * well-formed JSON that verifies nothing, so behaviour is exactly today's
 * (links open in the browser) rather than a 500 on a `.well-known` path.
 */
const PACKAGE_NAME = "io.talise.app";

/**
 * Parse + normalize the configured fingerprints. Google's verifier is strict:
 * uppercase colon-delimited hex, 32 bytes. We normalize case/separators so a
 * copy-paste with lowercase hex or stray whitespace still verifies, and drop
 * anything that isn't a plausible SHA-256 so one bad entry can't invalidate
 * the whole document.
 */
function fingerprints(): string[] {
  const raw = process.env.ANDROID_CERT_FINGERPRINTS ?? "";
  const out: string[] = [];
  for (const part of raw.split(/[,\s]+/)) {
    const cleaned = part.trim().toUpperCase().replace(/[^0-9A-F]/g, "");
    if (cleaned.length !== 64) continue;
    out.push((cleaned.match(/.{2}/g) ?? []).join(":"));
  }
  return Array.from(new Set(out));
}

export async function GET() {
  const certs = fingerprints();
  if (certs.length === 0) {
    console.warn(
      "[assetlinks] ANDROID_CERT_FINGERPRINTS is not set, Android App Links cannot verify"
    );
  }

  const statements = certs.length
    ? [
        {
          relation: [
            "delegate_permission/common.handle_all_urls",
            // Lets the app be offered as a credential provider for this
            // domain, harmless if unused and required if we ever ship
            // autofill/passkeys on Android (the Apple side already declares
            // webcredentials).
            "delegate_permission/common.get_login_creds",
          ],
          target: {
            namespace: "android_app",
            package_name: PACKAGE_NAME,
            sha256_cert_fingerprints: certs,
          },
        },
      ]
    : [];

  return NextResponse.json(statements, {
    headers: {
      // Google's verifier requires application/json and NO redirect on this
      // path. Keep both, and keep the TTL short so rotating a signing key
      // does not take a day to propagate.
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
