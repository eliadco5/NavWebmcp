"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

interface GuestPreferences {
  guestId: string;
  dietaryRestrictions: string[];
  seatingPreference: string;
  specialNotes: string;
  updatedAt: string | null;
}

export function GuestPreferencesCard({ guestId }: { guestId: string | null }) {
  const { call } = useBridge();
  const [prefs, setPrefs] = useState<GuestPreferences | null>(null);
  const [dietary, setDietary] = useState("");
  const [seating, setSeating] = useState("");
  const [notes, setNotes] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!guestId) { setPrefs(null); return; }
    const res = await call("getGuestPreferences", { guestId }) as { success: boolean; data?: { preferences: GuestPreferences } };
    if (res.success && res.data) {
      setPrefs(res.data.preferences);
      setDietary(res.data.preferences.dietaryRestrictions.join(", "));
      setSeating(res.data.preferences.seatingPreference);
      setNotes(res.data.preferences.specialNotes);
    }
  }, [call, guestId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!guestId) return;
    setLoading(true);
    setError(null);
    try {
      const res = await call("updateGuestPreferences", {
        guestId,
        dietaryRestrictions: dietary.split(",").map((s) => s.trim()).filter(Boolean),
        seatingPreference: seating,
        specialNotes: notes,
      }) as { success: boolean; error?: { message: string } };
      if (!res.success) setError(res.error?.message ?? "Failed to save preferences");
      else await refresh();
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Preferences
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>getGuestPreferences / updateGuestPreferences</span>
      </h2>
      {!guestId ? (
        <p style={{ color: "#9ca3af", fontSize: 13 }}>Pick a guest to view preferences.</p>
      ) : !prefs ? (
        <p style={{ color: "#9ca3af", fontSize: 13 }}>Loading…</p>
      ) : (
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 12, marginTop: 10 }}>
          <label style={{ fontSize: 13, color: "#374151" }}>
            Dietary restrictions (comma-separated)
            <input value={dietary} onChange={(e) => setDietary(e.target.value)} placeholder="e.g. vegan, nut-allergy" />
          </label>
          <label style={{ fontSize: 13, color: "#374151" }}>
            Seating preference
            <input value={seating} onChange={(e) => setSeating(e.target.value)} placeholder="e.g. window" />
          </label>
          <label style={{ fontSize: 13, color: "#374151" }}>
            Special notes
            <textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={3}
              style={{ width: "100%", border: "1px solid #cdd1d9", borderRadius: 6, padding: 8, font: "inherit" }}
            />
          </label>
          {error && <p style={{ color: "#ef4444", fontSize: 13 }}>{error}</p>}
          <button type="submit" disabled={loading} style={{ background: "#4f46e5", color: "#fff" }}>
            {loading ? "Saving…" : "Save Preferences"}
          </button>
        </form>
      )}
    </div>
  );
}
