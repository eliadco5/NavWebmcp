"use client";

import { useState, useEffect, useCallback } from "react";
import { useBridge } from "@/app/providers";
import { AvailabilityList } from "./AvailabilityList";
import { ReservationList } from "./ReservationList";
import { WaitTimeCard } from "./WaitTimeCard";
import type { Slot, Reservation } from "@/lib/store";

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

export function ReservationsPanel() {
  const { call, storeVersion, user } = useBridge();

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
  const [allReservations, setAllReservations] = useState<Reservation[]>([]);

  const [lookupId, setLookupId] = useState("");
  const [lookupResult, setLookupResult] = useState<Reservation | null>(null);
  const [lookupError, setLookupError] = useState<string | null>(null);
  const [lookupLoading, setLookupLoading] = useState(false);

  const isPrivileged = user?.role === "support" || user?.role === "admin";
  const isAdmin = user?.role === "admin";

  const refreshReservations = useCallback(async () => {
    const result = await call("listReservations") as { success: boolean; data?: { reservations: Reservation[] } };
    if (result.success && result.data) setReservations(result.data.reservations);
  }, [call]);

  useEffect(() => { refreshReservations(); }, [refreshReservations]);
  useEffect(() => {
    if (storeVersion > 0) refreshReservations();
  }, [storeVersion, refreshReservations]);

  const refreshAllReservations = useCallback(async () => {
    if (!isPrivileged) return;
    const result = await call("listAllReservations") as { success: boolean; data?: { reservations: Reservation[] } };
    if (result.success && result.data) setAllReservations(result.data.reservations);
  }, [call, isPrivileged]);

  useEffect(() => { refreshAllReservations(); }, [refreshAllReservations]);
  useEffect(() => {
    if (storeVersion > 0) refreshAllReservations();
  }, [storeVersion, refreshAllReservations]);

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
      // Calls the server-side `book` composite operation directly — one round
      // trip through /api/call — instead of the client orchestration in
      // lib/ui-tools/book.ts (searchAvailability + createReservation + verify,
      // 4 separate round trips). That client orchestration still exists and is
      // what's registered as the WebMCP `book` tool for in-page agents; the UI's
      // own "Confirm Booking" button gets to use the cheaper path because it
      // doesn't need to run in the browser to reach the same operation.
      const result = await call("book", {
        date: searchDate,
        time: bookingSlot.time,
        partySize,
        name: guestName.trim(),
      }) as { success: boolean; data?: { reservation: Reservation; validated: boolean }; error?: { message: string } };

      if (result.success) {
        setBookingSlot(null);
        setGuestName("");
        const searchResult = await call("searchAvailability", { date: searchDate, partySize }) as { success: boolean; data?: { slots: Slot[] } };
        if (searchResult.success && searchResult.data) setSlots(searchResult.data.slots);
      } else {
        setBookingError(result.error?.message ?? "Failed to book");
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

  async function handleLookup(e: React.FormEvent) {
    e.preventDefault();
    if (!lookupId.trim()) return;
    setLookupLoading(true);
    setLookupError(null);
    setLookupResult(null);
    try {
      const result = await call("getReservation", { reservationId: lookupId.trim() }) as {
        success: boolean;
        data?: { reservation: Reservation };
        error?: { message: string };
      };
      if (result.success && result.data) setLookupResult(result.data.reservation);
      else setLookupError(result.error?.message ?? "Reservation not found");
    } finally {
      setLookupLoading(false);
    }
  }

  return (
    <div className="grid-2">
      {/* Left column */}
      <div className="col">
        <div className="card">
          <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 16 }}>Find Availability</h2>
          <form onSubmit={handleSearch} style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <div>
              <label style={{ fontSize: 13, color: "#374151", display: "block", marginBottom: 4 }}>
                Date
                <input
                  type="date"
                  value={searchDate}
                  onChange={(e) => setSearchDate(e.target.value)}
                  min={todayISO()}
                  required
                />
              </label>
            </div>
            <div>
              <label style={{ fontSize: 13, color: "#374151", display: "block", marginBottom: 4 }}>
                Party Size
                <input
                  type="number"
                  value={partySize}
                  onChange={(e) => setPartySize(Number(e.target.value))}
                  min={1}
                  max={20}
                  required
                />
              </label>
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
                  <input
                    type="text"
                    value={guestName}
                    onChange={(e) => setGuestName(e.target.value)}
                    placeholder="e.g. Alice Smith"
                    required
                  />
                </label>
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

        <WaitTimeCard />

        <div className="card">
          <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
            Look Up Reservation
            <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>by ID</span>
          </h2>
          <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 14 }}>
            Exercises getReservation directly — the read the book() composite validates against.
          </p>
          <form onSubmit={handleLookup} style={{ display: "flex", gap: 10 }}>
            <input
              type="text"
              value={lookupId}
              onChange={(e) => setLookupId(e.target.value)}
              placeholder="Reservation ID"
              style={{ flex: 1 }}
            />
            <button type="submit" disabled={lookupLoading} style={{ background: "#4f46e5", color: "#fff" }}>
              {lookupLoading ? "Looking…" : "Look Up"}
            </button>
          </form>
          {lookupError && <p style={{ color: "#ef4444", fontSize: 13, marginTop: 10 }}>{lookupError}</p>}
          {lookupResult && (
            <div className="row" style={{ marginTop: 12 }}>
              <span style={{ fontSize: 13 }}>
                <strong>{lookupResult.name}</strong> · {lookupResult.date} {lookupResult.time} · party of {lookupResult.partySize}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Right column */}
      <div className="col">
        <div className="card">
          <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 16 }}>My Reservations</h2>
          <ReservationList
            reservations={reservations}
            onCancel={handleCancel}
            cancelling={cancelling}
          />
        </div>

        {isPrivileged && (
          <div className="card">
            <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
              All Reservations
              <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>
                ({user?.role})
              </span>
            </h2>
            <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>
              All bookings across all users.
            </p>
            {allReservations.length === 0 ? (
              <p style={{ fontSize: 13, color: "#9ca3af" }}>No reservations yet.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {allReservations.map((r) => (
                  <div key={r.id} className="row">
                    <span style={{ fontSize: 13 }}>
                      <strong>{r.name}</strong> · {r.date} {r.time} · party of {r.partySize}
                      <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280" }}>({r.userId})</span>
                    </span>
                    {isAdmin && (
                      <button
                        type="button"
                        onClick={async () => {
                          await call("cancelAnyReservation", { reservationId: r.id, confirm: true });
                        }}
                        style={{ fontSize: 11, padding: "2px 8px", background: "#fee2e2", color: "#dc2626", border: "none", borderRadius: 4, cursor: "pointer" }}
                      >
                        Cancel
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
