export interface AuditEntry {
  id: string;
  timestamp: string;
  operation: string;
  input: Record<string, unknown>;
  /** The op's `data` on success, or its `error` object on failure — what the
   *  platform actually sent back to the caller. Optional only for backwards
   *  compatibility with call sites that predate this field. */
  output?: unknown;
  success: boolean;
  source: "ui" | "agent";
}

class AuditLog {
  private entries: AuditEntry[] = [];

  record(
    operation: string,
    input: Record<string, unknown>,
    success: boolean,
    source: "ui" | "agent" = "ui",
    output?: unknown
  ): AuditEntry {
    const entry: AuditEntry = {
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      operation,
      input,
      output,
      success,
      source,
    };
    this.entries.unshift(entry);
    if (this.entries.length > 100) this.entries.pop();
    return entry;
  }

  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  /** For lib/shared-state. Empty means "nothing recorded on this instance yet",
   *  which restore() must be able to distinguish from "never hydrated". */
  snapshot(): AuditEntry[] {
    return [...this.entries];
  }

  /** Restore IN PLACE — see BookingStore.restore() for why. */
  restore(data: AuditEntry[]): void {
    this.entries.length = 0;
    this.entries.push(...data);
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __auditLog: AuditLog | undefined;
}

export const auditLog: AuditLog =
  globalThis.__auditLog ?? (globalThis.__auditLog = new AuditLog());
