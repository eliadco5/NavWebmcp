"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

interface ShiftNote {
  id: string;
  note: string;
  author: string;
  createdAt: string;
  date: string;
}

export function ShiftNotesCard() {
  const { call, storeVersion, user } = useBridge();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [notes, setNotes] = useState<ShiftNote[]>([]);
  const [newNote, setNewNote] = useState("");
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    const res = await call("listShiftNotes", { date }) as { success: boolean; data?: { notes: ShiftNote[] } };
    if (res.success && res.data) setNotes(res.data.notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call, date]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { if (storeVersion > 0) refresh(); }, [storeVersion, refresh]);

  async function handleAdd(e: React.FormEvent) {
    e.preventDefault();
    if (!newNote.trim()) return;
    setLoading(true);
    try {
      await call("addShiftNote", { note: newNote.trim(), author: user?.displayName ?? "Unknown" });
      setNewNote("");
      await refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Shift Notes
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>listShiftNotes / addShiftNote</span>
      </h2>
      <input
        type="date"
        value={date}
        onChange={(e) => setDate(e.target.value)}
        style={{ marginBottom: 12, width: "auto" }}
      />

      {notes.length === 0 ? (
        <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 14 }}>No notes for this date.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 14 }}>
          {notes.map((n) => (
            <div key={n.id} className="row" style={{ alignItems: "flex-start" }}>
              <span style={{ fontSize: 13 }}>
                {n.note}
                <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280" }}>{n.author}</span>
              </span>
            </div>
          ))}
        </div>
      )}

      <form onSubmit={handleAdd} style={{ display: "flex", gap: 10 }}>
        <input placeholder="Handover note" value={newNote} onChange={(e) => setNewNote(e.target.value)} />
        <button type="submit" disabled={loading} style={{ background: "#4f46e5", color: "#fff" }}>
          {loading ? "Adding…" : "Add"}
        </button>
      </form>
    </div>
  );
}
