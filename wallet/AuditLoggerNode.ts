import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { setAuditLogSink } from "./AuditLogger";

/** Configure the shared audit logger to append JSON lines on Node or Bun. */
export function configureNodeAuditLogger(
  logPath = join(process.cwd(), "audit.log")
): void {
  setAuditLogSink((_entry, serializedEntry) => {
    appendFileSync(logPath, serializedEntry);
  });
}
