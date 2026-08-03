"use client";

import { useState, useCallback, useEffect } from "react";
import { useBridge } from "@/app/providers";

interface FrontDeskReservation {
  reservationId: string;
  guestName: string;
  partySize: number;
  status: "pending" | "checked-in" | "checked-out" | "cancelled";
  tableId: string | null;
}

interface OccupancyTable {
  tableId: string;
  status: "available" | "occupied" | "reserved";
  capacity: number;
  minutesSeated: number | null;
}

interface Bill {
  reservationId: string;
  status: "open" | "closed";
  guestName: string;
  items: { name: string; qty: number; price: number }[];
  total: number;
}

export function FrontDeskPanel() {
  const { call, storeEvents } = useBridge();

  const [tables, setTables] = useState<OccupancyTable[]>([]);
  const [reservations, setReservations] = useState<FrontDeskReservation[]>([]);
  const [bills, setBills] = useState<Record<string, Bill>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const [occ, list] = await Promise.all([
      call("getOccupancy") as Promise<{ success: boolean; data?: { tables: OccupancyTable[] } }>,
      call("listFrontDeskReservations") as Promise<{ success: boolean; data?: { reservations: FrontDeskReservation[] } }>,
    ]);
    if (occ.success && occ.data) setTables(occ.data.tables);
    if (list.success && list.data) setReservations(list.data.reservations);
  }, [call]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => {
    if (storeEvents.length > 0) refresh();
  }, [storeEvents, refresh]);

  async function handleSeat(reservationId: string) {
    setBusy(reservationId);
    setError(null);
    try {
      const result = await call("seatGuest", { reservationId }) as { success: boolean; error?: { message: string } };
      if (!result.success) setError(result.error?.message ?? "Failed to seat guest");
      else await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function handleViewBill(reservationId: string) {
    setBusy(reservationId);
    try {
      const result = await call("getBillSummary", { reservationId }) as { success: boolean; data?: Bill };
      if (result.success && result.data) {
        setBills((prev) => ({ ...prev, [reservationId]: result.data! }));
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleCheckOut(reservationId: string) {
    setBusy(reservationId);
    setError(null);
    try {
      const result = await call("checkOutGuest", { reservationId }) as { success: boolean; error?: { message: string } };
      if (!result.success) setError(result.error?.message ?? "Failed to check out guest");
      else {
        setBills((prev) => {
          const next = { ...prev };
          delete next[reservationId];
          return next;
        });
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Front Desk
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>
          check-in · bill · check-out
        </span>
      </h2>
      <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 14 }}>
        Seat pending reservations, review bills, and check guests out.
      </p>

      {error && <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 10 }}>{error}</p>}

      <div style={{ marginBottom: 16 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Occupancy</h3>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {tables.map((t) => (
            <div
              key={t.tableId}
              aria-label={`Table ${t.tableId}`}
              style={{
                fontSize: 12, padding: "6px 10px", borderRadius: 6,
                background: t.status === "available" ? "#dcfce7" : t.status === "occupied" ? "#fee2e2" : "#fef3c7",
                color: t.status === "available" ? "#166534" : t.status === "occupied" ? "#991b1b" : "#92400e",
              }}
            >
              <strong>{t.tableId}</strong> · {t.status}
              {t.minutesSeated != null && ` · ${t.minutesSeated}m`}
            </div>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {reservations.filter((r) => r.status !== "cancelled").map((r) => (
          <div
            key={r.reservationId}
            style={{
              background: "#f9fafb", border: "1px solid #e5e7eb",
              borderRadius: 8, padding: "10px 14px",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <span style={{ fontWeight: 600 }}>{r.guestName}</span>
                <span style={{ color: "#6b7280", marginLeft: 10, fontSize: 13 }}>
                  party of {r.partySize} · {r.status}
                  {r.tableId && ` · ${r.tableId}`}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                {r.status === "pending" && (
                  <button
                    type="button"
                    aria-label={`Check in ${r.guestName}`}
                    onClick={() => handleSeat(r.reservationId)}
                    disabled={busy === r.reservationId}
                    style={{ background: "#4f46e5", color: "#fff", fontSize: 13 }}
                  >
                    {busy === r.reservationId ? "Seating…" : "Check In"}
                  </button>
                )}
                {r.status === "checked-in" && (
                  <>
                    <button
                      type="button"
                      aria-label={`View bill for ${r.guestName}`}
                      onClick={() => handleViewBill(r.reservationId)}
                      disabled={busy === r.reservationId}
                      style={{ background: "#f3f4f6", color: "#374151", fontSize: 13 }}
                    >
                      View Bill
                    </button>
                    <button
                      type="button"
                      aria-label={`Check out ${r.guestName}`}
                      onClick={() => handleCheckOut(r.reservationId)}
                      disabled={busy === r.reservationId}
                      style={{ background: "#fee2e2", color: "#991b1b", fontSize: 13 }}
                    >
                      {busy === r.reservationId ? "Checking out…" : "Check Out"}
                    </button>
                  </>
                )}
              </div>
            </div>
            {bills[r.reservationId] && (
              <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10 }}>
                {bills[r.reservationId].items.length === 0 ? (
                  <p style={{ fontSize: 12, color: "#9ca3af" }}>Bill will be generated at checkout.</p>
                ) : (
                  <>
                    {bills[r.reservationId].items.map((item, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: "#6b7280" }}>
                        <span>{item.qty}× {item.name}</span>
                        <span>${(item.price * item.qty).toFixed(2)}</span>
                      </div>
                    ))}
                    <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, fontWeight: 600, marginTop: 4 }}>
                      <span>Total</span>
                      <span>${bills[r.reservationId].total.toFixed(2)}</span>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        ))}
        {reservations.length === 0 && (
          <p style={{ fontSize: 13, color: "#9ca3af" }}>No front-desk reservations.</p>
        )}
      </div>
    </div>
  );
}
