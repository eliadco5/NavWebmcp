"use client";

import type { Reservation } from "@/lib/store";

interface Props {
  reservations: Reservation[];
  onCancel: (id: string) => void;
  cancelling?: string;
}

export function ReservationList({ reservations, onCancel, cancelling }: Props) {
  if (reservations.length === 0) {
    return <p style={{ color: "#888", padding: "12px 0" }}>No reservations yet.</p>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {reservations.map((r) => (
        <div
          key={r.id}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            background: "#f9fafb", border: "1px solid #e5e7eb",
            borderRadius: 8, padding: "10px 14px",
          }}
        >
          <div>
            <span style={{ fontWeight: 600 }}>{r.name}</span>
            <span style={{ color: "#6b7280", marginLeft: 10, fontSize: 13 }}>
              {r.date} {r.time} · {r.partySize} guests
            </span>
            <span style={{ color: "#9ca3af", marginLeft: 10, fontSize: 11 }}>
              #{r.id}
            </span>
          </div>
          <button
            onClick={() => onCancel(r.id)}
            disabled={cancelling === r.id}
            style={{ background: "#fee2e2", color: "#991b1b", fontSize: 13 }}
          >
            {cancelling === r.id ? "Cancelling…" : "Cancel"}
          </button>
        </div>
      ))}
    </div>
  );
}
