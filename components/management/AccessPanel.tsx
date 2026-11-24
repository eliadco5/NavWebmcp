"use client";

import { useCallback, useEffect, useState } from "react";
import type { ClientView, SessionView } from "@/lib/management/sessions";
import type { CreditLedgerView } from "@/lib/credits/admin";
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
  const [ledgers, setLedgers] = useState<CreditLedgerView[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [s, c, cr] = await Promise.all([
        adminApi<{ sessions: SessionView[] }>("sessions"),
        adminApi<{ clients: ClientView[] }>("clients"),
        adminApi<{ ledgers: CreditLedgerView[] }>("credits"),
      ]);
      setSessions(s.sessions);
      setClients(c.clients);
      setLedgers(cr.ledgers);
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

  async function setFrozen(l: CreditLedgerView, frozen: boolean) {
    const who = l.kind === "agent" ? `agent client ${l.id}` : userName(l.id);
    if (frozen && !window.confirm(`Freeze ${who}? Every call it makes is refused until you unfreeze it.`)) return;
    try {
      await adminApi("credits", { method: "POST", body: JSON.stringify({ kind: l.kind, id: l.id, frozen }) });
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
        <SectionTitle hint="Credit metering (docs/credits.md). A low or negative balance, a small window or many refusals means a caller is sending too many, too large or too slow calls.">Credits</SectionTitle>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>{["Caller", "Balance", "Window", "Calls", "Spent", "Refused", "Last call", ""].map((h) => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>
              {ledgers.length === 0 && <tr><td colSpan={8} style={{ ...td, color: INK.muted }}>No metered calls yet.</td></tr>}
              {ledgers.map((l) => (
                <tr key={l.principal}>
                  <td style={td}>
                    <div style={{ fontWeight: 600 }}>{l.kind === "agent" ? "Agent" : userName(l.id)}</div>
                    <span style={{ fontSize: 11, color: INK.muted }}>{l.kind === "agent" ? l.id : "person, UI"}</span>
                  </td>
                  <td style={{ ...td, color: l.balance < 0 ? "#991b1b" : undefined }}>{l.balance}</td>
                  <td style={td} title={`max ${l.maxWindow}, refill ${l.refillPerSec}/s`}>{l.window} / {l.maxWindow}</td>
                  <td style={td}>{l.calls}</td>
                  <td style={td}>{l.spent}</td>
                  <td style={{ ...td, color: l.refused > 0 ? "#991b1b" : undefined }}>{l.refused}</td>
                  <td style={td} title={fmtTime(l.lastAt)}>{ago(l.lastAt)}</td>
                  <td style={td}>
                    {l.frozen
                      ? <button type="button" onClick={() => setFrozen(l, false)} style={{ fontSize: 12, padding: "2px 10px" }}>Unfreeze</button>
                      : <button type="button" onClick={() => setFrozen(l, true)} style={{ fontSize: 12, padding: "2px 10px", background: "#fee2e2", color: "#991b1b" }}>Freeze</button>}
                  </td>
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
