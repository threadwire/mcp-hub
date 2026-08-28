import { createHash } from "node:crypto";

export { HubStore } from "./store.js";

export function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}