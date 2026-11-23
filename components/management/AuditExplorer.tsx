"use client";

import { Fragment, useCallback, useEffect, useState } from "react";
import type { AuditEvent } from "@/lib/audit/types";
import { ActorChip, INK, SectionTitle, Status, adminApi, fmtTime, th, td, userName } from "./shared";

interface Filters {
  actorType: string; channel: string; category: string; outcome: string;
  action: string; targetType: string; targetId: string; userId: string;
}
const EMPTY: Filters = { actorType: "", channel: "", category: "", outcome: "", action: "", targetType: "", targetId: "", userId: "" };

type Verification = { ok: boolean; checked: number; durable: boolean; brokenAt?: { seq: number; reason: string } };

function query(f: Filters, extra: Record<string, string | number | undefined> = {}) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries({ ...f, ...extra })) if (v !== "" && v !== undefined) p.set(k, String(v));
  return p.toString();
}

const OUTCOME = { success: "good", failure: "warning", denied: "critical" } as const;

/** Search the audit trail, follow a record's history, verify integrity, export. */
export function AuditExplorer({ focus }: { focus?: { targetType: string; targetId: string } | null }) {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [cursor, setCursor] = useState<number | undefined>();
  const [open, setOpen] = useState<string | null>(null);
  const [verify, setVerify] = useState<Verification | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const search = useCallback(async (f: Filters, more = false, before?: number) => {
    setBusy(true);
    try {
      const d = await adminApi<{ events: AuditEvent[]; nextBeforeSeq?: number }>(`audit?${query(f, { limit: 50, beforeSeq: more ? before : undefined })}`);
      setEvents((prev) => (more ? [...prev, ...d.events] : d.events));
      setCursor(d.nextBeforeSeq);
      setError(null);
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  }, []);

  useEffect(() => {
    const f = focus ? { ...EMPTY, ...focus } : EMPTY;
    setFilters(f);
    search(f);
  }, [focus, search]);

  const set = (k: keyof Filters) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setFilters({ ...filters, [k]: e.target.value });
  const select = (k: keyof Filters, opts: string[], label: string) => (
    <label style={{ fontSize: 12, color: INK.secondary }}>
      {label}
      <select value={filters[k]} onChange={set(k)} style={{ marginTop: 2 }}>
        <option value="">Any</option>
        {opts.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  );
  const text = (k: keyof Filters, label: string, placeholder: string) => (
    <label style={{ fontSize: 12, color: INK.secondary }}>
      {label}
      <input value={filters[k]} onChange={set(k)} placeholder={placeholder} style={{ marginTop: 2 }} />
    </label>
  );
  const historyOf = (type: string, id: string) => {
    const f = { ...EMPTY, targetType: type, targetId: id };
    setFilters(f);
    search(f);
  };

  return (
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "flex-start" }}>
        <SectionTitle hint="Tamper-evident record of every call, sign-in and admin action. Inputs and outputs are redacted.">Audit trail</SectionTitle>
        <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
          {verify && (verify.ok
            ? <Status kind={verify.durable ? "good" : "warning"} label={`Chain intact · ${verify.checked} events${verify.durable ? "" : " · in memory only"}`} />
            : <Status kind="critical" label={`Chain broken at #${verify.brokenAt?.seq} (${verify.brokenAt?.reason})`} />)}
          <button type="button" style={{ fontSize: 12, padding: "4px 10px" }} onClick={async () => setVerify(await adminApi<Verification>("audit/verify"))}>
            Verify integrity
          </button>
          <a href={`/api/admin/audit/export?${query(filters, { format: "csv" })}`} style={{ fontSize: 12 }}>Export CSV</a>
          <a href={`/api/admin/audit/export?${query(filters, { format: "ndjson" })}`} style={{ fontSize: 12 }}>Export NDJSON</a>
        </div>
      </div>

      <form
        onSubmit={(e) => { e.preventDefault(); search(filters); }}
        style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(130px, 1fr))", gap: 8, marginBottom: 12, alignItems: "end" }}
      >
        {select("actorType", ["human", "agent", "system"], "Who")}
        {select("channel", ["ui", "webmcp", "mcp", "internal"], "Channel")}
        {select("category", ["operation", "auth", "admin"], "Category")}
        {select("outcome", ["success", "failure", "denied"], "Outcome")}
        {text("action", "Action", "createReservation")}
        {text("userId", "User id", "u_alice")}
        {text("targetType", "Record type", "reservation")}
        {text("targetId", "Record id", "res_…")}
        <div style={{ display: "flex", gap: 6 }}>
          <button type="submit" disabled={busy} style={{ fontSize: 13 }}>{busy ? "Searching…" : "Search"}</button>
          <button type="button" onClick={() => { setFilters(EMPTY); search(EMPTY); }} style={{ fontSize: 13, background: "#f3f4f6", color: INK.secondary }}>Clear</button>
        </div>
      </form>

      {error && <p style={{ color: "#991b1b", fontSize: 13 }}>{error}</p>}
      {filters.targetType && filters.targetId && (
        <p style={{ fontSize: 13, color: INK.secondary, marginBottom: 8 }}>
          History of <strong>{filters.targetType} {filters.targetId}</strong> — newest first.
        </p>
      )}

      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead>
            <tr>{["#", "Time", "Who", "On behalf of", "Action", "Outcome", "Record", "Channel"].map((h) => <th key={h} style={th}>{h}</th>)}</tr>
          </thead>
          <tbody>
            {events.length === 0 && (
              <tr><td style={{ ...td, color: INK.muted }} colSpan={8}>No matching events.</td></tr>
            )}
            {events.map((e) => (
              <Fragment key={e.id}>
                <tr onClick={() => setOpen(open === e.id ? null : e.id)} style={{ cursor: "pointer" }}>
                  <td style={{ ...td, color: INK.muted, fontVariantNumeric: "tabular-nums" }}>{e.seq}</td>
                  <td style={{ ...td, whiteSpace: "nowrap" }}>{fmtTime(e.ts)}</td>
                  <td style={td}><ActorChip type={e.actor.type} name={e.actor.agent?.name} /></td>
                  <td style={td}>{e.actor.type === "system" ? "—" : `${userName(e.actor.userId)} (${e.actor.role})`}</td>
                  <td style={{ ...td, fontWeight: 600 }}>{e.action}{e.reportedBy === "client" && <span style={{ color: INK.muted, fontWeight: 400 }}> · reported by page</span>}</td>
                  <td style={td}><Status kind={OUTCOME[e.outcome]} label={e.errorCode ?? e.outcome} /></td>
                  <td style={td}>
                    {e.target ? (
                      <button
                        type="button"
                        title="Show this record's history"
                        onClick={(ev) => { ev.stopPropagation(); historyOf(e.target!.type, e.target!.id); }}
                        style={{ fontSize: 12, padding: "1px 6px", background: "#eef2ff", color: "#3730a3" }}
                      >
                        {e.target.type} {e.target.id}
                      </button>
                    ) : "—"}
                  </td>
                  <td style={td}>{e.channel}</td>
                </tr>
                {open === e.id && (
                  <tr>
                    <td colSpan={8} style={{ ...td, background: "#f9fafb" }}>
                      <div style={{ fontSize: 12, color: INK.secondary, display: "flex", gap: 16, flexWrap: "wrap", marginBottom: 6 }}>
                        <span>assurance: {e.actor.assurance}</span>
                        {e.actor.agent?.clientId && <span>agent client: {e.actor.agent.clientId}</span>}
                        {e.actor.sessionId && <span>session: {e.actor.sessionId}</span>}
                        {e.requestId && <span>request: {e.requestId}</span>}
                        {e.parentCallId && <span>parent call: {e.parentCallId}</span>}
                        {e.ip && <span>ip: {e.ip}</span>}
                        {e.durationMs !== undefined && <span>{e.durationMs} ms</span>}
                        <span title={e.hash}>hash: {e.hash.slice(0, 12)}…</span>
                      </div>
                      <pre style={{ fontSize: 11, background: "#fff", border: "1px solid #e5e7eb", borderRadius: 6, padding: 8, overflowX: "auto", maxHeight: 220, margin: 0 }}>
                        {JSON.stringify({ input: e.input, output: e.output }, null, 2)}
                      </pre>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
      {cursor !== undefined && (
        <button type="button" disabled={busy} onClick={() => search(filters, true, cursor)} style={{ marginTop: 10, fontSize: 13, background: "#f3f4f6", color: INK.secondary }}>
          Load older
        </button>
      )}
    </div>
  );
}
