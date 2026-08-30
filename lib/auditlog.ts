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
  private listeners: Array<(entry: AuditEntry) => void> = [];

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
    for (const l of this.listeners) l(entry);
    return entry;
  }

  getEntries(): AuditEntry[] {
    return [...this.entries];
  }

  onChange(cb: (entry: AuditEntry) => void): () => void {
    this.listeners.push(cb);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== cb);
    };
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __auditLog: AuditLog | undefined;
}

export const auditLog: AuditLog =
  globalThis.__auditLog ?? (globalThis.__auditLog = new AuditLog());
