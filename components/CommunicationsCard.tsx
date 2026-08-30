"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

interface CommunicationEntry {
  commId: string;
  guestId: string;
  type: "call" | "email" | "note";
  subject: string;
  body: string;
  agentId: string;
  createdAt: string;
}

const TYPES: CommunicationEntry["type"][] = ["call", "email", "note"];

export function CommunicationsCard({ guestId }: { guestId: string | null }) {
  const { call } = useBridge();
  const [typeFilter, setTypeFilter] = useState("");
  const [entries, setEntries] = useState<CommunicationEntry[]>([]);

  const [type, setType] = useState<CommunicationEntry["type"]>("note");
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!guestId) { setEntries([]); return; }
    const params: Record<string, unknown> = { guestId };
    if (typeFilter) params.type = typeFilter;
    const res = await call("listCommunications", params) as { success: boolean; data?: { communications: CommunicationEntry[] } };
    if (res.success && res.data) setEntries(res.data.communications);
  }, [call, guestId, typeFilter]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleLog(e: React.FormEvent) {
    e.preventDefault();
    if (!guestId || !subject.trim() || !body.trim()) return;
    setLoading(true);
    setError(null);
    try {
      const res = await call("logCommunication", { guestId, type, subject: subject.trim(), body: body.trim() }) as {
        success: boolean;
        error?: { message: string };
      };
      if (!res.success) setError(res.error?.message ?? "Failed to log communication");
      else {
        setSubject("");
        setBody("");
        await refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Communications
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>listCommunications / logCommunication</span>
      </h2>
      {!guestId ? (
        <p style={{ color: "#9ca3af", fontSize: 13 }}>Pick a guest to view communications.</p>
      ) : (
        <>
          <form onSubmit={handleLog} style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 14 }}>
            <div className="field-grid">
              <select value={type} onChange={(e) => setType(e.target.value as CommunicationEntry["type"])}>
                {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
              <input placeholder="Subject" value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <input placeholder="Body" value={body} onChange={(e) => setBody(e.target.value)} />
            {error && <p style={{ color: "#ef4444", fontSize: 13 }}>{error}</p>}
            <button type="submit" disabled={loading} style={{ background: "#4f46e5", color: "#fff" }}>
              {loading ? "Logging…" : "Log Communication"}
            </button>
          </form>

          <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} style={{ marginBottom: 12 }}>
            <option value="">All types</option>
            {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </select>

          {entries.length === 0 ? (
            <p style={{ color: "#9ca3af", fontSize: 13 }}>No communications logged.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              {entries.map((c) => (
                <div key={c.commId} className="row" style={{ alignItems: "flex-start" }}>
                  <span style={{ fontSize: 13 }}>
                    <span className="badge badge-ui" style={{ marginRight: 8 }}>{c.type}</span>
                    <strong>{c.subject}</strong>
                    <br />
                    <span style={{ fontSize: 12, color: "#6b7280" }}>{c.body}</span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
