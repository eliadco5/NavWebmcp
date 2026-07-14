"use client";

import { useEffect, useRef, createContext, useContext, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { StoreEvent } from "@/lib/store";
import type { AuditEntry } from "@/lib/auditlog";
import { installWebMCPPolyfill } from "@/lib/webmcp-polyfill";
import { book } from "@/lib/ui-tools/book";

interface AuthUser {
  id: string;
  username: string;
  displayName: string;
  role: string;
}

export async function serverCall(
  name: string,
  params: Record<string, unknown> = {}
): Promise<unknown> {
  const res = await fetch("/api/call", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, params }),
  });
  if (res.status === 401) {
    window.location.href = "/login";
    return { success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } };
  }
  return res.json();
}

interface BridgeContextValue {
  call: (name: string, params?: Record<string, unknown>) => Promise<unknown>;
  storeEvents: StoreEvent[];
  auditEntries: AuditEntry[];
  confirmPending: { name: string; input: Record<string, unknown>; resolve: (v: boolean) => void } | null;
  user: AuthUser | null;
  agentToken: string | null;
  logout: () => Promise<void>;
}

const BridgeContext = createContext<BridgeContextValue>({
  call: serverCall,
  storeEvents: [],
  auditEntries: [],
  confirmPending: null,
  user: null,
  agentToken: null,
  logout: async () => {},
});

export function useBridge() {
  return useContext(BridgeContext);
}

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [agentToken, setAgentToken] = useState<string | null>(null);
  const [storeEvents, setStoreEvents] = useState<StoreEvent[]>([]);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [confirmPending, setConfirmPending] = useState<BridgeContextValue["confirmPending"]>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);

  // Auth check on mount
  useEffect(() => {
    fetch("/api/me")
      .then(async (r) => {
        if (r.status === 401) {
          router.replace("/login");
          return;
        }
        const data = await r.json();
        if (data.success) {
          setUser(data.user);
          setAgentToken(data.agentToken);
        }
      })
      .catch(() => router.replace("/login"));
  }, [router]);

  // Register the composite `book` tool into document.modelContext once the user is known.
  // The same function is used by the UI button — one code path, business logic in the page.
  useEffect(() => {
    if (!user) return;
    installWebMCPPolyfill();
    const mc = document.modelContext;
    if (mc.getTools().some((t) => t.name === "book")) return; // already registered (hot-reload guard)
    mc.registerTool({
      name: "book",
      title: "Book a Table",
      description:
        "Book a table in ONE step: finds the matching open slot for the date and time, " +
        "reserves it, and validates the booking. Prefer this over calling " +
        "searchAvailability + createReservation separately.",
      inputSchema: {
        type: "object",
        properties: {
          date: { type: "string", description: "Date in YYYY-MM-DD format" },
          time: { type: "string", description: "Desired time slot, e.g. '18:00'" },
          partySize: { type: "number", description: "Number of guests (1–20)" },
          name: { type: "string", description: "Guest name for the reservation" },
        },
        required: ["date", "time", "partySize", "name"],
      },
      execute: (input) => book(input as unknown as Parameters<typeof book>[0]),
    });
    // Expose on window for console inspection (mirrors README pattern)
    if (typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>)["bookTool"] = (input: Parameters<typeof book>[0]) => book(input);
    }
  }, [user]);

  // Load initial audit log entries
  useEffect(() => {
    fetch("/api/audit")
      .then(r => r.ok ? r.json() : null)
      .then((data: AuditEntry[] | null) => {
        if (data) setAuditEntries(data);
      })
      .catch(() => {});
  }, []);

  // Subscribe to server-sent events
  useEffect(() => {
    const es = new EventSource("/api/events");

    es.addEventListener("store", (e) => {
      const event = JSON.parse(e.data) as StoreEvent;
      setStoreEvents((prev) => [event, ...prev].slice(0, 50));
    });

    es.addEventListener("audit", (e) => {
      const entry = JSON.parse(e.data) as AuditEntry;
      setAuditEntries((prev) => [entry, ...prev].slice(0, 50));
    });

    return () => es.close();
  }, []);

  const handleConfirmation = useCallback(
    (name: string, input: Record<string, unknown>): Promise<boolean> => {
      return new Promise((resolve) => {
        resolveRef.current = resolve;
        setConfirmPending({ name, input, resolve });
      });
    },
    []
  );

  function resolveConfirm(approved: boolean) {
    setConfirmPending(null);
    resolveRef.current?.(approved);
    resolveRef.current = null;
  }

  const call = useCallback(async (name: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (name === "cancelReservation") {
      const approved = await handleConfirmation(name, params);
      if (!approved) {
        return { success: false, error: { code: "CONFIRMATION_DENIED", message: "User denied the action." } };
      }
    }
    return serverCall(name, params);
  }, [handleConfirmation]);

  const logout = useCallback(async () => {
    await fetch("/api/logout", { method: "POST" });
    setUser(null);
    setAgentToken(null);
    router.replace("/login");
  }, [router]);

  return (
    <BridgeContext.Provider value={{ call, storeEvents, auditEntries, confirmPending, user, agentToken, logout }}>
      {children}
      {confirmPending && (
        <ConfirmationDialog
          name={confirmPending.name}
          input={confirmPending.input}
          onApprove={() => resolveConfirm(true)}
          onDeny={() => resolveConfirm(false)}
        />
      )}
    </BridgeContext.Provider>
  );
}

function ConfirmationDialog({
  name, input, onApprove, onDeny,
}: {
  name: string;
  input: Record<string, unknown>;
  onApprove: () => void;
  onDeny: () => void;
}) {
  return (
    <div style={{
      position: "fixed", inset: 0, background: "rgba(0,0,0,.45)",
      display: "flex", alignItems: "center", justifyContent: "center", zIndex: 1000,
    }}>
      <div className="card" style={{ maxWidth: 420, width: "90%", padding: 28 }}>
        <h3 style={{ marginBottom: 12, fontSize: 18 }}>Confirm Action</h3>
        <p style={{ marginBottom: 8, color: "#555" }}>
          An agent wants to perform: <strong>{name}</strong>
        </p>
        <pre style={{
          background: "#f4f6f8", borderRadius: 6, padding: 12,
          fontSize: 12, marginBottom: 20, overflow: "auto", maxHeight: 160,
        }}>
          {JSON.stringify(input, null, 2)}
        </pre>
        <div style={{ display: "flex", gap: 12, justifyContent: "flex-end" }}>
          <button onClick={onDeny} style={{ background: "#e5e7eb", color: "#374151" }}>
            Deny
          </button>
          <button onClick={onApprove} style={{ background: "#ef4444", color: "#fff" }}>
            Allow Cancellation
          </button>
        </div>
      </div>
    </div>
  );
}
