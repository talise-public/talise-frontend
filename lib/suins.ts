import "server-only";

import { isHexAddress, USERNAME_RE } from "./handle";
import { shortAddress } from "./format";
import { suins } from "./suins-operator";

/**
 * Recipient resolver. **On-chain SuiNS is the source of truth.**
 *
 * The resolver tries multiple lookup candidates so the user can type any
 * of the natural forms:
 *
 *   alice                  → tries alice.talise.sui, then alice.sui
 *   alice@talise           → tries alice.talise.sui
 *   alice@talise.sui       → tries alice.talise.sui
 *   alice.talise.sui       → tries alice.talise.sui
 *   alice.sui              → tries alice.sui
 *   sub.alice.sui          → tries sub.alice.sui   (nested root subname)
 *   0x<64 hex>             → bypasses SuiNS entirely
 *
 * Talise subnames are preferred when both could resolve (e.g. the app
 * mints `alice.talise.sui` and someone else owns the root `alice.sui` —
 * we send to the Talise user because that's what "alice" means in our
 * app context). Hex addresses bypass SuiNS entirely.
 */

export type Resolved = { address: string; displayName: string };

export async function resolveRecipient(input: string): Promise<Resolved | null> {
  if (!input) return null;
  const trimmed = input.trim().toLowerCase();
  if (!trimmed) return null;

  if (isHexAddress(trimmed)) {
    return { address: trimmed, displayName: shortAddress(trimmed, 4, 4) };
  }

  const candidates = candidateSuinsNames(trimmed);
  for (const name of candidates) {
    try {
      const record = await suins().getNameRecord(name);
      if (record?.targetAddress) {
        return {
          address: record.targetAddress,
          displayName: prettyName(name),
        };
      }
    } catch {
      // ObjectError / "not exist" / RPC hiccup — try the next candidate.
      continue;
    }
  }
  return null;
}

/**
 * Build the ordered list of full SuiNS names to look up for a given
 * user-typed input. Returns [] when the input can't be turned into a
 * valid lookup string.
 *
 * Talise-branded forms always come first so that "alice" maps to
 * alice.talise.sui (an app user) before alice.sui (a root SuiNS user).
 */
function candidateSuinsNames(raw: string): string[] {
  let s = raw.trim().toLowerCase();
  if (!s) return [];
  if (s.startsWith("@")) s = s.slice(1);

  // IMPORTANT — Talise display forms (which contain `@`) must be
  // matched BEFORE the generic `.sui` suffix branch. Otherwise a
  // string like "alice@talise.sui" matches `.endsWith(".sui")` first
  // and gets rejected by validateSui (because the "alice@talise"
  // label contains `@`), returning [] and short-circuiting the rest
  // of the candidate logic.
  if (s.endsWith("@talise.sui")) {
    const bare = s.slice(0, -"@talise.sui".length);
    return USERNAME_RE.test(bare) ? [`${bare}.talise.sui`] : [];
  }
  if (s.endsWith("@talise")) {
    const bare = s.slice(0, -"@talise".length);
    return USERNAME_RE.test(bare) ? [`${bare}.talise.sui`] : [];
  }

  // Already-canonical SuiNS forms.
  if (s.endsWith(".talise.sui")) {
    return validateSui(s) ? [s] : [];
  }
  if (s.endsWith(".sui")) {
    return validateSui(s) ? [s] : [];
  }

  // Bare username — try Talise sub (our users), then root SuiNS
  // (everyone else on Sui mainnet).
  if (USERNAME_RE.test(s)) {
    return [`${s}.talise.sui`, `${s}.sui`];
  }

  return [];
}

/**
 * Loose validity check for a full SuiNS name (anything ending in .sui).
 * The SuinsClient will reject malformed names with a thrown error, so
 * we just make sure each label is non-empty and uses the SuiNS charset.
 */
function validateSui(full: string): boolean {
  if (!full.endsWith(".sui")) return false;
  const labels = full.split(".");
  if (labels.length < 2) return false;
  return labels.every((l) => /^[a-z0-9_]{1,63}$/.test(l));
}

/** Render a full SuiNS name back as the user-friendly Talise / SuiNS form. */
function prettyName(full: string): string {
  if (full.endsWith(".talise.sui")) {
    return full.replace(/\.talise\.sui$/, "@talise.sui");
  }
  return full;
}
