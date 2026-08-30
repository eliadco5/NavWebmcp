"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";
import { GuestSearchCard } from "./GuestSearchCard";
import { GuestPreferencesCard } from "./GuestPreferencesCard";
import { LoyaltyCard } from "./LoyaltyCard";
import { CommunicationsCard } from "./CommunicationsCard";
import { DEMO_GUEST_IDS } from "@/lib/seed/crm";

interface Guest {
  guestId: string;
  name: string;
  email: string;
  phone: string;
  createdAt: string;
}

function GuestDetailCard({ guestId }: { guestId: string }) {
  const { call } = useBridge();
  const [guest, setGuest] = useState<Guest | null>(null);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const res = await call("getGuest", { guestId }) as { success: boolean; data?: { guest: Guest } };
    if (res.success && res.data) {
      setGuest(res.data.guest);
      setName(res.data.guest.name);
      setEmail(res.data.guest.email);
      setPhone(res.data.guest.phone);
    }
  }, [call, guestId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const res = await call("updateGuest", { guestId, name, email, phone }) as { success: boolean; error?: { message: string } };
      if (!res.success) setError(res.error?.message ?? "Failed to update guest");
      else { setEditing(false); await refresh(); }
    } finally {
      setSaving(false);
    }
  }

  if (!guest) return null;

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Guest Detail
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>getGuest / updateGuest</span>
      </h2>
      {!editing ? (
        <>
          <p style={{ fontSize: 13, marginTop: 10 }}><strong>{guest.name}</strong></p>
          <p style={{ fontSize: 12, color: "#6b7280" }}>{guest.email} · {guest.phone}</p>
          <button type="button" onClick={() => setEditing(true)} style={{ fontSize: 12, marginTop: 10, background: "#f3f4f6", color: "#374151" }}>
            Edit
          </button>
        </>
      ) : (
        <form onSubmit={handleSave} style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
          <input value={name} onChange={(e) => setName(e.target.value)} />
          <input value={email} onChange={(e) => setEmail(e.target.value)} />
          <input value={phone} onChange={(e) => setPhone(e.target.value)} />
          {error && <p style={{ color: "#ef4444", fontSize: 13 }}>{error}</p>}
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={() => setEditing(false)} style={{ background: "#f3f4f6", color: "#374151", flex: 1 }}>
              Cancel
            </button>
            <button type="submit" disabled={saving} style={{ background: "#4f46e5", color: "#fff", flex: 2 }}>
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export function CrmPanel() {
  const { user } = useBridge();
  const isPrivileged = user?.role === "support" || user?.role === "admin";
  const [selectedGuestId, setSelectedGuestId] = useState<string | null>(null);

  return (
    <div className="grid-2">
      <div className="col">
        {isPrivileged ? (
          <GuestSearchCard selectedGuestId={selectedGuestId} onSelect={setSelectedGuestId} />
        ) : (
          <div className="card">
            <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>Pick a Guest</h2>
            <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>
              Guest search is support/admin only — pick a demo guest to view your own preferences and loyalty status.
            </p>
            <select value={selectedGuestId ?? ""} onChange={(e) => setSelectedGuestId(e.target.value || null)}>
              <option value="">Select a guest…</option>
              {DEMO_GUEST_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
            </select>
          </div>
        )}
        {isPrivileged && selectedGuestId && <GuestDetailCard guestId={selectedGuestId} />}
      </div>
      <div className="col">
        <GuestPreferencesCard guestId={selectedGuestId} />
        <LoyaltyCard guestId={selectedGuestId} canAward={isPrivileged} />
        {isPrivileged && <CommunicationsCard guestId={selectedGuestId} />}
      </div>
    </div>
  );
}
