import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// package.json lives two levels up from either src/ (tsc dist/src) at runtime.
// Read once at module load; never hardcode the version string again.
const PKG = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");

export const HUB_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(PKG, "utf8")) as { version: string }).version;
  } catch {
    return "unknown";
  }
})();