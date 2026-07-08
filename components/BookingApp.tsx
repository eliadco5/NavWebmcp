"use client";

import { useState, useEffect, useCallback } from "react";
import { useBridge } from "@/app/providers";
import { AvailabilityList } from "./AvailabilityList";
import { ReservationList } from "./ReservationList";
import { ActivityLog } from "./ActivityLog";
import type { Slot, Reservation } from "@/lib/store";

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

export function BookingApp() {
  const { call, storeEvents, auditEntries } = useBridge();

  const [searchDate, setSearchDate] = useState(todayISO());
  const [partySize, setPartySize] = useState(2);
  const [slots, setSlots] = useState<Slot[]>([]);
  const [searchLoading, setSearchLoading] = useState(false);

  const [bookingSlot, setBookingSlot] = useState<Slot | null>(null);
  const [guestName, setGuestName] = useState("");
  const [bookingLoading, setBookingLoading] = useState(false);
  const [bookingError, setBookingError] = useState<string | null>(null);

  const [reservations, setReservations] = useState<Reservation[]>([]);
  const [cancelling, setCancelling] = useState<string | undefined>();

  const refreshReservations = useCallback(async () => {
    const result = await call("listReservations") as { success: boolean; data?: { reservations: Reservation[] } };
    if (result.success && result.data) setReservations(result.data.reservations);
  }, [call]);

  // Initial load
  useEffect(() => { refreshReservations(); }, [refreshReservations]);

  // Refresh whenever the server store changes (MCP or UI calls)
  useEffect(() => {
    if (storeEvents.length > 0) refreshReservations();
  }, [storeEvents, refreshReservations]);

  async function handleSearch(e: React.FormEvent) {
    e.preventDefault();
    setSearchLoading(true);
    setSlots([]);
    try {
      const result = await call("searchAvailability", { date: searchDate, partySize }) as { success: boolean; data?: { slots: Slot[] } };
      if (result.success && result.data) setSlots(result.data.slots);
    } finally {
      setSearchLoading(false);
    }
  }

  async function handleBook(e: React.FormEvent) {
    e.preventDefault();
    if (!bookingSlot || !guestName.trim()) return;
    setBookingLoading(true);
    setBookingError(null);
    try {
      const result = await call("createReservation", {
        slotId: bookingSlot.id,
        name: guestName.trim(),
        partySize,
      }) as { success: boolean; error?: { message: string } };

      if (result.success) {
        setBookingSlot(null);
        setGuestName("");
        const searchResult = await call("searchAvailability", { date: searchDate, partySize }) as { success: boolean; data?: { slots: Slot[] } };
        if (searchResult.success && searchResult.data) setSlots(searchResult.data.slots);
      } else {
        setBookingError(result.error?.message ?? "Failed to create reservation");
      }
    } finally {
      setBookingLoading(false);
    }
  }

  async function handleCancel(reservationId: string) {
    setCancelling(reservationId);
    try {
      await call("cancelReservation", { reservationId, confirm: true });
    } finally {
      setCancelling(undefined);
    }
  }

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 20px" }}>
      <div style={{ marginBottom: 32 }}>
        <h1 style={{ fontSize: 28, fontWeight: 700 }}>AgentBridge Booking Demo</h1>
        <p style={{ color: "#6b7280", marginTop: 6 }}>
          Book a table — or let an AI agent do it.{" "}
          <code style={{ fontSize: 12, background: "#f3f4f6", padding: "2px 6px", borderRadius: 4 }}>
            MCP endpoint: /api/mcp
          </code>
        </p>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 24 }}>
        {/* Left column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="card">
            <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 16 }}>Find Availability</h2>
            <form onSubmit={handleSearch} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              <div>
                <label style={{ fontSize: 13, color: "#374151", display: "block", marginBottom: 4 }}>Date</label>
                <input
                  type="date"
                  value={searchDate}
                  onChange={(e) => setSearchDate(e.target.value)}
                  min={todayISO()}
                  required
                />
              </div>
              <div>
                <label style={{ fontSize: 13, color: "#374151", display: "block", marginBottom: 4 }}>Party Size</label>
                <input
                  type="number"
                  value={partySize}
                  onChange={(e) => setPartySize(Number(e.target.value))}
                  min={1}
                  max={20}
                  required
                />
              </div>
              <button type="submit" style={{ background: "#4f46e5", color: "#fff" }}>
                Search
              </button>
            </form>

            {(slots.length > 0 || searchLoading) && (
              <div style={{ marginTop: 16 }}>
                <AvailabilityList
                  slots={slots}
                  onBook={(slot) => { setBookingSlot(slot); setBookingError(null); }}
                  loading={searchLoading}
                />
              </div>
            )}
          </div>

          {bookingSlot && (
            <div className="card" style={{ borderLeft: "4px solid #4f46e5" }}>
              <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
                Book {bookingSlot.time}
              </h2>
              <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 16 }}>
                {bookingSlot.date} · up to {bookingSlot.capacity} guests
              </p>
              <form onSubmit={handleBook} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                <div>
                  <label style={{ fontSize: 13, color: "#374151", display: "block", marginBottom: 4 }}>
                    Guest Name
                  </label>
                  <input
                    type="text"
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    placeholder="e.g. Alice Smith"
                    required
                  />
                </div>
                {bookingError && (
                  <p style={{ color: "#ef4444", fontSize: 13 }}>{bookingError}</p>
                )}
                <div style={{ display: "flex", gap: 10 }}>
                  <button
                    type="button"
                    onClick={() => setBookingSlot(null)}
                    style={{ background: "#f3f4f6", color: "#374151", flex: 1 }}
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={bookingLoading}
                    style={{ background: "#4f46e5", color: "#fff", flex: 2 }}
                  >
                    {bookingLoading ? "Booking…" : "Confirm Booking"}
                  </button>
                </div>
              </form>
            </div>
          )}
        </div>

        {/* Right column */}
        <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
          <div className="card">
            <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 16 }}>Reservations</h2>
            <ReservationList
              reservations={reservations}
              onCancel={handleCancel}
              cancelling={cancelling}
            />
          </div>

          <div className="card">
            <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 16 }}>
              Activity Log
              <span style={{ marginLeft: 8, fontSize: 12, color: "#9ca3af", fontWeight: 400 }}>
                (agent + UI calls)
              </span>
            </h2>
            <ActivityLog entries={auditEntries} />
          </div>

          <div className="card" style={{ background: "#1e1b4b", color: "#e0e7ff" }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Connect an AI Agent</h2>
            <p style={{ fontSize: 12, marginBottom: 8, color: "#a5b4fc" }}>Claude Code:</p>
            <pre style={{ background: "#312e81", borderRadius: 6, padding: 10, fontSize: 11, overflowX: "auto", marginBottom: 12 }}>
              {`claude mcp add --transport http booking \\\n  http://localhost:3002/api/mcp`}
            </pre>
            <p style={{ fontSize: 12, marginBottom: 8, color: "#a5b4fc" }}>MCP Inspector:</p>
            <pre style={{ background: "#312e81", borderRadius: 6, padding: 10, fontSize: 11, overflowX: "auto" }}>
              {`npx @modelcontextprotocol/inspector \\\n  http://localhost:3002/api/mcp`}
            </pre>
          </div>
        </div>
      </div>
    </div>
  );
}
