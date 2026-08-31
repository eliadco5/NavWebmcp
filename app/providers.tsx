"use client";

import { useEffect, useRef, createContext, useContext, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import type { AuditEntry } from "@/lib/auditlog";
import { getModelContext } from "@/lib/webmcp-polyfill";
import { initAgentBridge } from "@/lib/adapters/webmcp";
import { book } from "@/lib/ui-tools/book";
import { seatGuest } from "@/lib/ui-tools/seatGuest";
import { hostVipGuest } from "@/lib/ui-tools/hostVipGuest";
import { AGENT_INSTRUCTIONS } from "@/lib/agent-instructions";
import { registry } from "@/lib/operations";
import type { Role } from "@/lib/auth";

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
  // No redirect-to-/login on 401 here: /api/call auto-provisions an alice/customer
  // session for any visitor with none (see getOrProvisionUser in lib/auth.ts), so a
  // 401 now only means DEMO_MODE=false with a genuinely absent/expired session —
  // in which case bouncing every failed call to /login would be the wrong UX for
  // what's meant to be a one-off escape hatch, not the default flow.
  return res.json();
}

interface BridgeContextValue {
  call: (name: string, params?: Record<string, unknown>) => Promise<unknown>;
  storeVersion: number;
  auditEntries: AuditEntry[];
  confirmPending: { name: string; input: Record<string, unknown>; resolve: (v: boolean) => void } | null;
  user: AuthUser | null;
  agentToken: string | null;
  logout: () => Promise<void>;
  switchRole: (role: "customer" | "support" | "admin") => Promise<void>;
}

const BridgeContext = createContext<BridgeContextValue>({
  call: serverCall,
  storeVersion: 0,
  auditEntries: [],
  confirmPending: null,
  user: null,
  agentToken: null,
  logout: async () => {},
  switchRole: async () => {},
});

export function useBridge() {
  return useContext(BridgeContext);
}

export function Providers({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const [user, setUser] = useState<AuthUser | null>(null);
  const [agentToken, setAgentToken] = useState<string | null>(null);
  const [storeVersion, setStoreVersion] = useState(0);
  const [auditEntries, setAuditEntries] = useState<AuditEntry[]>([]);
  const [confirmPending, setConfirmPending] = useState<BridgeContextValue["confirmPending"]>(null);
  const resolveRef = useRef<((v: boolean) => void) | null>(null);
  const lastAuditIdRef = useRef<string | null>(null);
  // Read by initAgentBridge's getUserId/getUserRole closures (see the WebMCP
  // registration effect below) so a role switch is reflected without needing
  // to reconstruct the bridge — it's a page-lifetime singleton, only
  // constructed once, but those closures are called fresh on every
  // register()/call() and so always see the current value here.
  const userRef = useRef<AuthUser | null>(null);
  useEffect(() => {
    userRef.current = user;
  }, [user]);

  // Moved above the WebMCP registration effect (was originally declared much
  // later, alongside resolveConfirm/call) because that effect now needs to
  // pass it to initAgentBridge as onConfirmation.
  const handleConfirmation = useCallback(
    (name: string, input: Record<string, unknown>): Promise<boolean> => {
      return new Promise((resolve) => {
        resolveRef.current = resolve;
        setConfirmPending({ name, input, resolve });
      });
    },
    []
  );

  // Auth check on mount. /api/me auto-provisions an alice/customer session for a
  // first-time visitor (see getOrProvisionUser), so this normally never 401s — a
  // judge landing on the URL is signed in with zero clicks. A 401 only happens
  // with DEMO_MODE=false and no session; that's left as a silent no-op rather than
  // a redirect loop, since /login remains reachable directly.
  useEffect(() => {
    fetch("/api/me")
      .then(async (r) => {
        const data = await r.json();
        if (data.success) {
          setUser(data.user);
          setAgentToken(data.agentToken);
        }
      })
      .catch(() => {});
  }, []);

  // Register the FULL operation registry into the live ModelContext once the
  // user is known — every op, not just the 3 composites, via the same
  // AgentBridge machinery lib/adapters/mcp.ts and the MCP-over-HTTP surface
  // conceptually mirror. initAgentBridge builds each handler around
  // serverCall (POST /api/call), never op.handler directly — op handlers read/
  // write lib/store.ts's and lib/auditlog.ts's globalThis singletons, which in
  // a browser resolve to the browser's OWN globalThis, a throwaway store the
  // server (and Front Desk, and other tabs) never sees.
  //
  // Everything in this effect is wrapped in try/catch and guarded by feature
  // detection: `document.modelContext` may be a NATIVE WebMCP implementation
  // (Chrome with the flag on, or eventually shipped by default) rather than the
  // polyfill, and a native object doesn't have `getTools()`/`executeTool()` (see
  // lib/webmcp-polyfill.ts) and may reject the non-spec `instructions`/
  // `protocolVersion` extensions outright (AgentBridge's own constructor
  // already try/catches that specific assignment, but registerTool() itself
  // could still throw on a spec-drifted native implementation).
  useEffect(() => {
    if (!user) return;
    try {
      getModelContext(); // ensure the polyfill is installed before AgentBridge reaches for it
      initAgentBridge(
        {
          instructions: AGENT_INSTRUCTIONS,
          onConfirmation: handleConfirmation,
          getUserId: () => userRef.current?.id ?? null,
          getUserRole: () => (userRef.current?.role as Role | undefined) ?? null,
        },
        serverCall
      );
    } catch (err) {
      // A spec-drifted or unexpectedly strict native implementation should degrade
      // tool registration, not blank the page.
      console.warn("WebMCP tool registration failed:", err);
    }

    // Expose on window for console inspection (mirrors README pattern)
    if (typeof window !== "undefined") {
      (window as unknown as Record<string, unknown>)["bookTool"] = (input: Parameters<typeof book>[0]) => book(input);
      (window as unknown as Record<string, unknown>)["seatGuestTool"] = (input: Parameters<typeof seatGuest>[0]) => seatGuest(input);
      (window as unknown as Record<string, unknown>)["hostVipGuestTool"] = (input: Parameters<typeof hostVipGuest>[0]) => hostVipGuest(input);
    }
  }, [user, handleConfirmation]);

  // Poll the audit log rather than subscribing to SSE — see the comment in
  // call() above for why SSE doesn't work on Vercel for this app. Polling every
  // 4s while the tab is visible is the honest fix, not a downgrade: it's
  // reliable across serverless instances, which the old stream never was.
  //
  // This is ALSO the only way data panels learn about agent-initiated writes.
  // The bump inside call() below only fires for calls that went through this
  // browser tab's own UI — an agent hitting /api/mcp directly (a different
  // process, possibly a different serverless instance) never touches that
  // code path. Diffing the audit log against the last-seen entry id and
  // bumping storeVersion when a new *write* shows up is what makes "an agent
  // just booked a table" show up in My Reservations without a manual refresh.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;

    const fetchAudit = async () => {
      if (document.hidden) return; // don't burn invocations on a backgrounded tab
      try {
        const res = await fetch("/api/audit");
        if (!res.ok) return;
        const data: AuditEntry[] = await res.json();
        if (cancelled) return;
        setAuditEntries(data);

        const latest = data[0];
        if (latest && latest.id !== lastAuditIdRef.current) {
          if (lastAuditIdRef.current !== null) {
            // Entries newer than the last-seen id, oldest first, so a burst of
            // several calls between polls is still evaluated one by one.
            const previousId = lastAuditIdRef.current;
            const newEntries = [];
            for (const entry of data) {
              if (entry.id === previousId) break;
              newEntries.push(entry);
            }
            const hasWrite = newEntries.some((e) => {
              const op = registry.find((o) => o.name === e.operation);
              return op?.permission === "write";
            });
            if (hasWrite) setStoreVersion((v) => v + 1);
          }
          lastAuditIdRef.current = latest.id;
        }
      } catch {
        // transient network error — the next poll will retry
      }
    };

    fetchAudit();
    const interval = setInterval(fetchAudit, 4000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [user]);

  function resolveConfirm(approved: boolean) {
    setConfirmPending(null);
    resolveRef.current?.(approved);
    resolveRef.current = null;
  }

  const call = useCallback(async (name: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    const op = registry.find((o) => o.name === name);
    if (op?.requiresConfirmation) {
      const approved = await handleConfirmation(name, params);
      if (!approved) {
        return { success: false, error: { code: "CONFIRMATION_DENIED", message: "User denied the action." } };
      }
    }
    const result = await serverCall(name, params);
    // Bump storeVersion after a successful write so every panel watching it
    // refetches — this is what used to be the SSE "store" event stream. SSE
    // never worked on Vercel for this: no `maxDuration` on the route meant the
    // connection was killed by the default function timeout every ~10-15s
    // (EventSource just reconnects in a loop, each reconnect a billable
    // invocation), and even a live connection only saw mutations from calls
    // that happened to land on the SAME serverless instance as the stream.
    // Bumping this on the instance that just handled the write is strictly
    // more reliable than that server-push ever was.
    const success = (result as { success?: boolean } | null)?.success !== false;
    if (success && op?.permission === "write") {
      setStoreVersion((v) => v + 1);
    }
    return result;
  }, [handleConfirmation]);

  const logout = useCallback(async () => {
    await fetch("/api/logout", { method: "POST" });
    setUser(null);
    setAgentToken(null);
    router.replace("/login");
  }, [router]);

  // Demo-mode role switcher — re-mints the session cookie with the SAME userId and
  // a new role (see app/api/switch-role/route.ts). Deliberately unauthenticated;
  // exists so a judge can reach every role in one tap with no credentials.
  const switchRole = useCallback(async (role: "customer" | "support" | "admin") => {
    const res = await fetch("/api/switch-role", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ role }),
    });
    const data = await res.json();
    if (data.success) {
      setUser(data.user);
      setAgentToken(data.agentToken);
    }
  }, []);

  return (
    <BridgeContext.Provider value={{ call, storeVersion, auditEntries, confirmPending, user, agentToken, logout, switchRole }}>
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
            Confirm
          </button>
        </div>
      </div>
    </div>
  );
}
