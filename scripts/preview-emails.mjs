// Render both welcome emails to .data/preview-*.html so you can open them in a browser.
// Run with: pnpm exec node --experimental-strip-types scripts/preview-emails.mjs
//
// Note: we import compiled output via the dev server isn't running; we use a
// minimal import path that doesn't require Next compilation.

import { writeFileSync, mkdirSync } from "node:fs";
import {
  welcomeWithAddressHtml,
  welcomeEmailOnlyHtml,
} from "../lib/emails/welcome.ts";

mkdirSync(".data", { recursive: true });

const withAddr = welcomeWithAddressHtml({
  firstName: "Sofia",
  suiAddress:
    "0xa1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90",
  position: 143,
});
writeFileSync(".data/preview-welcome-with-address.html", withAddr);

const emailOnly = welcomeEmailOnlyHtml(98);
writeFileSync(".data/preview-welcome-email-only.html", emailOnly);

console.log("✓ wrote .data/preview-welcome-with-address.html");
console.log("✓ wrote .data/preview-welcome-email-only.html");
console.log("open both with: open .data/preview-*.html");
