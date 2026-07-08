"use client";

import type { Slot } from "@/lib/store";

interface Props {
  slots: Slot[];
  onBook: (slot: Slot) => void;
  loading?: boolean;
}

export function AvailabilityList({ slots, onBook, loading }: Props) {
  if (loading) return <p style={{ color: "#888", padding: "12px 0" }}>Searching…</p>;
  if (slots.length === 0) return <p style={{ color: "#888", padding: "12px 0" }}>No slots found for selected date and party size.</p>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {slots.map((slot) => (
        <div
          key={slot.id}
          style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            background: "#f9fafb", border: "1px solid #e5e7eb",
            borderRadius: 8, padding: "10px 14px",
          }}
        >
          <div>
            <span style={{ fontWeight: 600 }}>{slot.time}</span>
            <span style={{ color: "#6b7280", marginLeft: 12, fontSize: 13 }}>
              Up to {slot.capacity} guests
            </span>
          </div>
          <button
            onClick={() => onBook(slot)}
            style={{ background: "#4f46e5", color: "#fff", fontSize: 13 }}
          >
            Book
          </button>
        </div>
      ))}
    </div>
  );
}
