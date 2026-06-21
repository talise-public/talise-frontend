// Node module-resolution shim for running the shielded-pool SDK (TypeScript,
// Next.js-flavored) under plain `node --import`. Two gaps to bridge:
//
//   1. `server-only` — a Next.js build-time marker package with NO runtime code
//      (Next aliases it away at bundle time). Under Node it isn't installed, so
//      we resolve it to an empty data: module.
//   2. Extensionless RELATIVE imports inside the .ts SDK (e.g. tx.ts does
//      `import ... from "./prover"`). Node's ESM resolver needs the extension;
//      we append `.ts` when a bare relative specifier has no extension and the
//      `.ts` file exists.
//
// This adds NO behavior to the SDK — it only makes the real modules importable.
import { fileURLToPath, pathToFileURL } from "node:url";
import { existsSync } from "node:fs";
import { dirname, resolve as pathResolve, extname } from "node:path";

// web/ project root (this file lives in web/scripts/).
const WEB_ROOT = pathResolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function resolve(specifier, context, nextResolve) {
  if (specifier === "server-only" || specifier === "server-only/index") {
    return {
      url: "data:text/javascript,export%20default%20%7B%7D",
      format: "module",
      shortCircuit: true,
    };
  }
  // `@/...` path alias (mirrors tsconfig.json) -> resolve under web/ root,
  // appending .ts when extensionless.
  if (specifier.startsWith("@/")) {
    const base = pathResolve(WEB_ROOT, specifier.slice(2));
    for (const cand of [base, base + ".ts", base + ".mjs", base + ".js", base + "/index.ts"]) {
      if (existsSync(cand) && extname(cand)) {
        return { url: pathToFileURL(cand).href, shortCircuit: true };
      }
    }
  }
  // Extensionless relative import -> try appending .ts (then .mjs/.js).
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && !extname(specifier)) {
    const parentPath = context.parentURL ? fileURLToPath(context.parentURL) : process.cwd();
    const base = pathResolve(dirname(parentPath), specifier);
    for (const ext of [".ts", ".mjs", ".js"]) {
      if (existsSync(base + ext)) {
        return { url: pathToFileURL(base + ext).href, shortCircuit: true };
      }
    }
  }
  return nextResolve(specifier, context);
}
