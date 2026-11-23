"use client";

import { useCallback, useEffect, useState } from "react";
import type { ClientView, SessionView } from "@/lib/management/sessions";
import { INK, SectionTitle, Status, adminApi, ago, fmtTime, th, td, userName } from "./shared";

function LiveStatus({ v }: { v: { connected: boolean; endReason?: string } }) {
  if (v.endReason === "revoked") return <Status kind="critical" label="Revoked" />;
  if (v.endReason === "logout") return <Status kind="warning" label="Logged out" />;
  return v.connected ? <Status kind="good" label="Connected" /> : <span style={{ fontSize: 12, color: INK.muted }}>Idle</span>;
}

/** Who is signed in and which agents are connected — and revoking either. */
export function AccessPanel({ onHistory }: { onHistory: (targetType: string, targetId: string) => void }) {
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [clients, setClients] = useState<ClientView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c] = await Promise.all([
        adminApi<{ sessions: SessionView[] }>("sessions"),
        adminApi<{ clients: ClientView[] }>("clients"),
      ]);
      setSessions(s.sessions);
      setClients(c.clients);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  async function revoke(kind: "sessions" | "clients", id: string, what: string) {
    if (!window.confirm(`Revoke ${what}? It stops working on its next request.`)) return;
    try {
      await adminApi(kind, { method: "DELETE", body: JSON.stringify(kind === "sessions" ? { sid: id } : { clientId: id }) });
      await load();
    } catch (e) {
      setError(String((e as Error).message));
    }
  }

  const revokeBtn = (onClick: () => void, disabled: boolean) => (
    <button type="button" disabled={disabled} onClick={onClick} style={{ fontSize: 12, padding: "2px 10px", background: disabled ? "#f3f4f6" : "#fee2e2", color: disabled ? INK.muted : "#991b1b" }}>
      Revoke
    </button>
  );

  return (
    <div className="col">
      {error && <p style={{ color: "#991b1b", fontSize: 13 }}>{error}</p>}
      <div className="card">
        <SectionTitle hint="Agents users have connected through MCP. Revoking one disconnects that agent only.">Agent clients</SectionTitle>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Agent", "For user", "Software", "Last active", "Status", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {clients.length === 0 && <tr><td colSpan={6} style={{ ...td, color: INK.muted }}>No agent has connected yet.</td></tr>}
              {clients.map((c) => (
                <tr key={c.clientId}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{c.label ?? (c.kind === "default" ? "Session token" : c.kind === "legacy" ? "Legacy token" : "Agent")}</div>
                    <button type="button" onClick={() => onHistory("agentClient", c.clientId)} style={{ fontSize: 11, padding: 0, background: "none", color: "#4f46e5" }}>{c.clientId}</button>
                  </td>
                  <td style={td}>{userName(c.userId)} ({c.role})</td>
                  <td style={td}>{c.agentName ? `${c.agentName}${c.agentVersion ? ` ${c.agentVersion}` : ""}` : <span style={{ color: INK.muted }}>unknown</span>}</td>
                  <td style={td} title={fmtTime(c.lastSeenAt)}>{ago(c.lastSeenAt)}</td>
                  <td style={td}><LiveStatus v={c} /></td>
                  <td style={td}>{revokeBtn(() => revoke("clients", c.clientId, `agent client ${c.label ?? c.clientId}`), c.endReason === "revoked")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <SectionTitle hint="People's sign-ins. Revoking a session also cuts off the agent tokens it authorised; a logout doesn't.">Sign-in sessions</SectionTitle>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["User", "Started", "Last active", "From", "Status", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {sessions.length === 0 && <tr><td colSpan={6} style={{ ...td, color: INK.muted }}>No sessions recorded.</td></tr>}
              {sessions.map((s) => (
                <tr key={s.sid}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{userName(s.userId)} <span style={{ fontWeight: 400, color: INK.muted }}>({s.role}{s.provisioned ? ", demo" : ""})</span></div>
                    <button type="button" onClick={() => onHistory("session", s.sid)} style={{ fontSize: 11, padding: 0, background: "none", color: "#4f46e5" }}>{s.sid}</button>
                  </td>
                  <td style={td}>{fmtTime(s.startedAt)}</td>
                  <td style={td} title={fmtTime(s.lastSeenAt)}>{ago(s.lastSeenAt)}</td>
                  <td style={{ ...td, maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={s.userAgent}>
                    {s.ip ?? "—"}{s.userAgent ? ` · ${s.userAgent}` : ""}
                  </td>
                  <td style={td}><LiveStatus v={s} /></td>
                  <td style={td}>{revokeBtn(() => revoke("sessions", s.sid, `${userName(s.userId)}'s session`), s.endReason === "revoked")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
