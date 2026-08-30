"use client";

import { useState } from "react";
import { useBridge } from "@/app/providers";

interface Guest {
  guestId: string;
  name: string;
  email: string;
  phone: string;
  createdAt: string;
}

export function GuestSearchCard({
  selectedGuestId,
  onSelect,
}: {
  selectedGuestId: string | null;
  onSelect: (guestId: string) => void;
}) {
  const { call } = useBridge();
  const [query, setQuery] = useState("");
  const [guests, setGuests] = useState<Guest[]>([]);
  const [searching, setSearching] = useState(false);

  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearching(true);
    try {
      const res = await call("searchGuests", { query }) as { success: boolean; data?: { guests: Guest[] } };
      if (res.success && res.data) setGuests(res.data.guests);
    } finally {
      setSearching(false);
    }
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !email.trim() || !phone.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const res = await call("createGuest", { name: name.trim(), email: email.trim(), phone: phone.trim() }) as {
        success: boolean;
        data?: { guest: Guest };
        error?: { message: string };
      };
      if (!res.success) {
        setError(res.error?.message ?? "Failed to create guest");
      } else if (res.data) {
        setName(""); setEmail(""); setPhone(""); setShowCreate(false);
        setGuests((prev) => [res.data!.guest, ...prev]);
        onSelect(res.data.guest.guestId);
      }
    } finally {
      setCreating(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Guests
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>searchGuests / createGuest</span>
      </h2>
      <form onSubmit={handleSearch} style={{ display: "flex", gap: 10, marginBottom: 12 }}>
        <input placeholder="Search name or email" value={query} onChange={(e) => setQuery(e.target.value)} />
        <button type="submit" disabled={searching} style={{ background: "#4f46e5", color: "#fff" }}>
          {searching ? "…" : "Search"}
        </button>
      </form>

      {guests.length === 0 ? (
        <p style={{ color: "#9ca3af", fontSize: 13, marginBottom: 12 }}>No results yet — try a search.</p>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
          {guests.map((g) => (
            <button
              key={g.guestId}
              type="button"
              onClick={() => onSelect(g.guestId)}
              className="row"
              style={{
                textAlign: "left", cursor: "pointer",
                border: g.guestId === selectedGuestId ? "1px solid #4f46e5" : "1px solid #e5e7eb",
              }}
            >
              <span style={{ fontSize: 13 }}>
                <strong>{g.name}</strong>
                <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280" }}>{g.email}</span>
              </span>
            </button>
          ))}
        </div>
      )}

      {!showCreate ? (
        <button type="button" onClick={() => setShowCreate(true)} style={{ fontSize: 12, background: "#f3f4f6", color: "#374151" }}>
          + New guest
        </button>
      ) : (
        <form onSubmit={handleCreate} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <input placeholder="Full name" value={name} onChange={(e) => setName(e.target.value)} required />
          <input placeholder="Email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input placeholder="Phone" value={phone} onChange={(e) => setPhone(e.target.value)} required />
          {error && <p style={{ color: "#ef4444", fontSize: 13 }}>{error}</p>}
          <div style={{ display: "flex", gap: 10 }}>
            <button type="button" onClick={() => setShowCreate(false)} style={{ background: "#f3f4f6", color: "#374151", flex: 1 }}>
              Cancel
            </button>
            <button type="submit" disabled={creating} style={{ background: "#4f46e5", color: "#fff", flex: 2 }}>
              {creating ? "Creating…" : "Create Guest"}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
