"use client";

import { useState, useCallback, useEffect } from "react";
import { useBridge } from "@/app/providers";
import { DEMO_GUEST_IDS } from "@/lib/seed/crm";
import { DEMO_USERS } from "@/lib/constants";

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

interface CheckinStatus {
  reservationId: string;
  guestName: string;
  guestId: string;
  partySize: number;
  status: string;
  tableId: string | null;
  seatedAt: string | null;
  minutesSeated: number | null;
}

export function FrontDeskPanel() {
  const { call, storeVersion } = useBridge();

  const [tables, setTables] = useState<OccupancyTable[]>([]);
  const [reservations, setReservations] = useState<FrontDeskReservation[]>([]);
  const [bills, setBills] = useState<Record<string, Bill>>({});
  const [details, setDetails] = useState<Record<string, CheckinStatus>>({});
  const [advanced, setAdvanced] = useState<string | null>(null);
  const [tableChoice, setTableChoice] = useState<Record<string, string>>({});
  const [vipForm, setVipForm] = useState<string | null>(null);
  const [vipGuestId, setVipGuestId] = useState<string>(DEMO_GUEST_IDS[0]);
  const [vipPoints, setVipPoints] = useState(100);
  const [vipNote, setVipNote] = useState("");
  const [vipResult, setVipResult] = useState<Record<string, unknown> | null>(null);
  const [taskForm, setTaskForm] = useState<string | null>(null);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskDepartment, setTaskDepartment] = useState("");
  const [taskPriority, setTaskPriority] = useState<"low" | "medium" | "high">("medium");
  const [taskAssigneeId, setTaskAssigneeId] = useState("");
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
    if (storeVersion > 0) refresh();
  }, [storeVersion, refresh]);

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

  async function handleCheckInAdvanced(reservationId: string) {
    const tableId = tableChoice[reservationId];
    if (!tableId) return;
    setBusy(reservationId);
    setError(null);
    try {
      // Reaches the raw checkInGuest op directly (seatGuest above is the
      // composite: occupancy check + checkInGuest + validate, in one call).
      const result = await call("checkInGuest", { reservationId, tableId }) as { success: boolean; error?: { message: string } };
      if (!result.success) setError(result.error?.message ?? "Failed to check in guest");
      else { setAdvanced(null); await refresh(); }
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

  async function handleDetails(reservationId: string) {
    if (details[reservationId]) {
      setDetails((prev) => { const next = { ...prev }; delete next[reservationId]; return next; });
      return;
    }
    setBusy(reservationId);
    try {
      const result = await call("getCheckinStatus", { reservationId }) as { success: boolean; data?: CheckinStatus };
      if (result.success && result.data) setDetails((prev) => ({ ...prev, [reservationId]: result.data! }));
    } finally {
      setBusy(null);
    }
  }

  async function handleHostVip(reservationId: string) {
    if (!vipNote.trim()) return;
    setBusy(reservationId);
    setError(null);
    setVipResult(null);
    try {
      const result = await call("hostVipGuest", {
        reservationId,
        guestId: vipGuestId,
        pointsToAward: vipPoints,
        visitNote: vipNote.trim(),
      }) as { success: boolean; data?: Record<string, unknown>; error?: { message: string } };
      if (!result.success) setError(result.error?.message ?? "Failed to host VIP guest");
      else {
        setVipResult(result.data ?? {});
        setVipNote("");
        await refresh();
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleCreateTask(reservationId: string) {
    if (!taskTitle.trim() || !taskDepartment.trim()) return;
    setBusy(reservationId);
    setError(null);
    try {
      const result = await call("createTask", {
        title: taskTitle.trim(),
        department: taskDepartment.trim(),
        priority: taskPriority,
        reservationId,
        ...(taskAssigneeId && { assigneeId: taskAssigneeId }),
      }) as { success: boolean; error?: { message: string } };
      if (!result.success) setError(result.error?.message ?? "Failed to create task");
      else {
        setTaskForm(null);
        setTaskTitle("");
        setTaskDepartment("");
        setTaskAssigneeId("");
      }
    } finally {
      setBusy(null);
    }
  }

  async function handleCheckOut(reservationId: string) {
    setBusy(reservationId);
    setError(null);
    try {
      // checkOutGuest carries requiresConfirmation:true AND its own confirm
      // schema field (the server enforces this too, not just the UI dialog) —
      // providers.tsx's ConfirmationDialog approves first, then confirm: true
      // here satisfies the op's own server-side check.
      const result = await call("checkOutGuest", { reservationId, confirm: true }) as { success: boolean; error?: { message: string } };
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

  const availableTables = tables.filter((t) => t.status === "available");

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
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <div>
                <span style={{ fontWeight: 600 }}>{r.guestName}</span>
                <span style={{ color: "#6b7280", marginLeft: 10, fontSize: 13 }}>
                  party of {r.partySize} · {r.status}
                  {r.tableId && ` · ${r.tableId}`}
                </span>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button
                  type="button"
                  onClick={() => handleDetails(r.reservationId)}
                  disabled={busy === r.reservationId}
                  style={{ background: "#f3f4f6", color: "#374151", fontSize: 12 }}
                >
                  {details[r.reservationId] ? "Hide Details" : "Details"}
                </button>
                <button
                  type="button"
                  onClick={() => setTaskForm(taskForm === r.reservationId ? null : r.reservationId)}
                  style={{ background: "#f3f4f6", color: "#374151", fontSize: 12 }}
                >
                  Create Task
                </button>
                {r.status === "pending" && (
                  <>
                    <button
                      type="button"
                      aria-label={`Check in ${r.guestName}`}
                      onClick={() => handleSeat(r.reservationId)}
                      disabled={busy === r.reservationId}
                      style={{ background: "#4f46e5", color: "#fff", fontSize: 13 }}
                    >
                      {busy === r.reservationId ? "Seating…" : "Check In"}
                    </button>
                    <button
                      type="button"
                      onClick={() => setAdvanced(advanced === r.reservationId ? null : r.reservationId)}
                      style={{ background: "#f3f4f6", color: "#374151", fontSize: 12 }}
                    >
                      Advanced
                    </button>
                    <button
                      type="button"
                      onClick={() => setVipForm(vipForm === r.reservationId ? null : r.reservationId)}
                      style={{ background: "#ede9fe", color: "#5b21b6", fontSize: 12 }}
                    >
                      Host VIP
                    </button>
                  </>
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

            {taskForm === r.reservationId && (
              <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <p style={{ fontSize: 11, color: "#9ca3af" }}>
                  createTask — linked to this reservation via reservationId.
                </p>
                <input placeholder="Title" value={taskTitle} onChange={(e) => setTaskTitle(e.target.value)} />
                <div className="field-grid">
                  <input placeholder="Department" value={taskDepartment} onChange={(e) => setTaskDepartment(e.target.value)} />
                  <select value={taskPriority} onChange={(e) => setTaskPriority(e.target.value as typeof taskPriority)}>
                    <option value="low">low</option>
                    <option value="medium">medium</option>
                    <option value="high">high</option>
                  </select>
                  <select value={taskAssigneeId} onChange={(e) => setTaskAssigneeId(e.target.value)}>
                    <option value="">Unassigned</option>
                    {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                  </select>
                </div>
                <button
                  type="button"
                  disabled={busy === r.reservationId || !taskTitle.trim() || !taskDepartment.trim()}
                  onClick={() => handleCreateTask(r.reservationId)}
                  style={{ background: "#4f46e5", color: "#fff", fontSize: 12 }}
                >
                  {busy === r.reservationId ? "Creating…" : "Create Task"}
                </button>
              </div>
            )}

            {details[r.reservationId] && (
              <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10, fontSize: 12, color: "#6b7280" }}>
                guestId: {details[r.reservationId].guestId} · seatedAt: {details[r.reservationId].seatedAt ?? "—"}
                {details[r.reservationId].minutesSeated != null && ` · ${details[r.reservationId].minutesSeated}m seated`}
              </div>
            )}

            {advanced === r.reservationId && (
              <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10, display: "flex", gap: 8 }}>
                <select
                  value={tableChoice[r.reservationId] ?? ""}
                  onChange={(e) => setTableChoice((prev) => ({ ...prev, [r.reservationId]: e.target.value }))}
                  style={{ flex: 1 }}
                >
                  <option value="">Choose a table…</option>
                  {availableTables.map((t) => (
                    <option key={t.tableId} value={t.tableId}>{t.tableId} (cap {t.capacity})</option>
                  ))}
                </select>
                <button
                  type="button"
                  disabled={!tableChoice[r.reservationId] || busy === r.reservationId}
                  onClick={() => handleCheckInAdvanced(r.reservationId)}
                  style={{ background: "#4f46e5", color: "#fff", fontSize: 12 }}
                >
                  checkInGuest
                </button>
              </div>
            )}

            {vipForm === r.reservationId && (
              <div style={{ marginTop: 10, borderTop: "1px solid #e5e7eb", paddingTop: 10, display: "flex", flexDirection: "column", gap: 8 }}>
                <p style={{ fontSize: 11, color: "#9ca3af" }}>
                  hostVipGuest — one call: preferences + loyalty + seat + award + log.
                </p>
                <div className="field-grid">
                  <select value={vipGuestId} onChange={(e) => setVipGuestId(e.target.value)}>
                    {DEMO_GUEST_IDS.map((id) => <option key={id} value={id}>{id}</option>)}
                  </select>
                  <input type="number" value={vipPoints} onChange={(e) => setVipPoints(Number(e.target.value))} min={1} />
                </div>
                <input placeholder="Visit note" value={vipNote} onChange={(e) => setVipNote(e.target.value)} />
                <button
                  type="button"
                  disabled={busy === r.reservationId}
                  onClick={() => handleHostVip(r.reservationId)}
                  style={{ background: "#5b21b6", color: "#fff", fontSize: 12 }}
                >
                  {busy === r.reservationId ? "Hosting…" : "Host VIP Guest"}
                </button>
                {vipResult && (
                  <pre style={{ fontSize: 11, background: "#f3f4f6", borderRadius: 6, padding: 8, overflowX: "auto", margin: 0 }}>
                    {JSON.stringify(vipResult, null, 2)}
                  </pre>
                )}
              </div>
            )}

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
