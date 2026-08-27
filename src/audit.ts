import { appendFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import type { AuditEntry } from "./types.js";

export class Audit {
  constructor(private path: string) {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  record(entry: Omit<AuditEntry, "ts">): void {
    const line: AuditEntry = { ts: new Date().toISOString(), ...entry };
    try {
      appendFileSync(this.path, JSON.stringify(line) + "\n");
    } catch {
      /* audit must never take the hot path down */
    }
  }
}

export function sha256Short(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}