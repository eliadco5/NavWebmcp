"use client";

import { useState, useEffect, useCallback } from "react";
import { useBridge } from "@/app/providers";
import { book } from "@/lib/ui-tools/book";
import { AvailabilityList } from "./AvailabilityList";
import { ReservationList } from "./ReservationList";
import { ActivityLog } from "./ActivityLog";
import { UsersPanel } from "./UsersPanel";
import type { Slot, Reservation } from "@/lib/store";

function todayISO() {
  return new Date().toISOString().split("T")[0];
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      style={{
        fontSize: 11, padding: "2px 8px", borderRadius: 4,
        background: copied ? "#22c55e" : "#312e81", color: "#e0e7ff",
        border: "none", cursor: "pointer",
      }}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

export function BookingApp() {
  const { call, storeEvents, auditEntries, user, agentToken, logout } = useBridge();

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
  const isPrivileged = user?.role === "support" || user?.role === "admin";
  const isAdmin = user?.role === "admin";

  const refreshReservations = useCallback(async () => {
    const result = await call("listReservations") as { success: boolean; data?: { reservations: Reservation[] } };
    if (result.success && result.data) setReservations(result.data.reservations);
  }, [call]);

  useEffect(() => { refreshReservations(); }, [refreshReservations]);

  useEffect(() => {
    if (storeEvents.length > 0) refreshReservations();
  }, [storeEvents, refreshReservations]);

  const refreshAllReservations = useCallback(async () => {
    if (!isPrivileged) return;
    const result = await call("listAllReservations") as { success: boolean; data?: { reservations: Reservation[] } };
    if (result.success && result.data) setAllReservations(result.data.reservations);
  }, [call, isPrivileged]);

  useEffect(() => { refreshAllReservations(); }, [refreshAllReservations]);
  useEffect(() => {
    if (storeEvents.length > 0) refreshAllReservations();
  }, [storeEvents, refreshAllReservations]);

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
      const result = await book({
        date: searchDate,
        time: bookingSlot.time,
        partySize,
        name: guestName.trim(),
      });

      if (result.success) {
        setBookingSlot(null);
        setGuestName("");
        // Refresh availability to reflect the now-booked slot
        const searchResult = await call("searchAvailability", { date: searchDate, partySize }) as { success: boolean; data?: { slots: Slot[] } };
        if (searchResult.success && searchResult.data) setSlots(searchResult.data.slots);
      } else {
        setBookingError(result.error.message);
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

  const mcpCommand = agentToken
    ? `claude mcp add --transport http booking \\\n  ${window.location.origin}/api/mcp \\\n  --header "Authorization: Bearer ${agentToken}"`
    : "";

  return (
    <div style={{ maxWidth: 1100, margin: "0 auto", padding: "32px 20px" }}>
      {/* Header */}
      <div style={{ marginBottom: 32, display: "flex", alignItems: "flex-start", justifyContent: "space-between" }}>
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700 }}>AgentBridge Booking Demo</h1>
          <p style={{ color: "#6b7280", marginTop: 6 }}>
            Book a table — or let an AI agent do it.
          </p>
        </div>
        {user && (
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <span style={{ fontSize: 13, color: "#374151" }}>
              Signed in as <strong>{user.displayName}</strong>
            </span>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 12,
              background: user.role === "admin" ? "#fef3c7" : user.role === "support" ? "#ede9fe" : "#e0f2fe",
              color: user.role === "admin" ? "#92400e" : user.role === "support" ? "#5b21b6" : "#0369a1",
            }}>
              {user.role}
            </span>
            <button
              type="button"
              onClick={logout}
              style={{ fontSize: 12, padding: "4px 12px", background: "#f3f4f6", color: "#374151" }}
            >
              Sign out
            </button>
          </div>
        )}
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
            <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 16 }}>My Reservations</h2>
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

          {/* Support/Admin: all reservations panel */}
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
                    <div key={r.id} style={{
                      padding: "8px 12px", background: "#f9fafb", borderRadius: 6,
                      fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center",
                    }}>
                      <span>
                        <strong>{r.name}</strong> · {r.date} {r.time} · party of {r.partySize}
                        <span style={{ marginLeft: 8, fontSize: 11, color: "#6b7280" }}>({r.userId})</span>
                      </span>
                      {isAdmin && (
                        <button
                          type="button"
                          onClick={async () => {
                            if (!confirm(`Cancel reservation ${r.id} for ${r.name}?`)) return;
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

          {/* Admin: user management */}
          {isAdmin && <UsersPanel />}

          {/* Agent connect card */}
          <div className="card" style={{ background: "#1e1b4b", color: "#e0e7ff" }}>
            <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Connect an AI Agent</h2>

            {agentToken && (
              <div style={{ marginBottom: 16 }}>
                <p style={{ fontSize: 12, marginBottom: 4, color: "#a5b4fc" }}>Your agent token:</p>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <code style={{
                    background: "#312e81", borderRadius: 4, padding: "4px 8px",
                    fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
                  }}>
                    {agentToken}
                  </code>
                  <CopyButton text={agentToken} />
                </div>
              </div>
            )}

            <p style={{ fontSize: 12, marginBottom: 8, color: "#a5b4fc" }}>Claude Code:</p>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <pre style={{ background: "#312e81", borderRadius: 6, padding: 10, fontSize: 11, overflowX: "auto", margin: 0 }}>
                {mcpCommand}
              </pre>
              {mcpCommand && (
                <div style={{ display: "flex", justifyContent: "flex-end" }}>
                  <CopyButton text={mcpCommand.replace(/\\\n\s+/g, " ")} />
                </div>
              )}
            </div>

            <p style={{ fontSize: 12, marginTop: 12, marginBottom: 8, color: "#a5b4fc" }}>MCP Inspector:</p>
            <pre style={{ background: "#312e81", borderRadius: 6, padding: 10, fontSize: 11, overflowX: "auto" }}>
              {`npx @modelcontextprotocol/inspector \\\n  ${typeof window !== "undefined" ? window.location.origin : "http://localhost:3000"}/api/mcp`}
            </pre>
            <p style={{ fontSize: 11, color: "#818cf8", marginTop: 6 }}>
              Use the Authorization header with your token in the inspector.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
