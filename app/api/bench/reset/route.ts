import { cookies } from "next/headers";
import { userForSession, SESSION_COOKIE } from "@/lib/auth";

// Dev/bench-only: restores the in-memory front-office store to its seed state so
// scripts/bench.mjs can re-run the check-in flow without restarting the server.
// checkOutGuest is a one-way transition (checkInGuest rejects "checked-out"), so
// without this the seeded res_003 could only be seated once per server lifetime.
//
// Every lib/operations/*.ts front-office file resolves `globalThis.__frontofficeStore`
// to the SAME object (first import creates it, later imports reuse it), so mutating its
// Maps in place here is visible to every op handler immediately — no re-import needed.
// Admin-gated like the other /api/admin/* routes; not part of the public surface.

declare global {
  var __frontofficeStore:
    | {
        tables: Map<string, { id: string; status: "available" | "occupied" | "reserved"; capacity: number; reservationId?: string; seatedAt?: string; guestId?: string }>;
        reservations: Map<string, { id: string; guestId: string; guestName: string; partySize: number; tableId?: string; status: "pending" | "checked-in" | "checked-out" | "cancelled" }>;
        bills: Map<string, { reservationId: string; tableId: string; items: { name: string; qty: number; price: number }[]; total: number; generatedAt: string }>;
        shiftNotes: { id: string; note: string; author: string; createdAt: string; date: string }[];
      }
    | undefined;
}

export async function POST() {
  const cookieStore = await cookies();
  const sessionId = cookieStore.get(SESSION_COOKIE)?.value;
  const caller = sessionId ? userForSession(sessionId) : null;
  if (!caller) return Response.json({ success: false, error: { code: "UNAUTHENTICATED" } }, { status: 401 });
  if (caller.role !== "admin") return Response.json({ success: false, error: { code: "FORBIDDEN" } }, { status: 403 });

  const fo = globalThis.__frontofficeStore;
  if (fo) {
    fo.tables.clear();
    fo.tables.set("t_01", { id: "t_01", status: "available", capacity: 2 });
    fo.tables.set("t_02", { id: "t_02", status: "occupied", capacity: 4, reservationId: "res_001", seatedAt: new Date(Date.now() - 45 * 60000).toISOString(), guestId: "g_001" });
    fo.tables.set("t_03", { id: "t_03", status: "available", capacity: 4 });
    fo.tables.set("t_04", { id: "t_04", status: "reserved", capacity: 6, reservationId: "res_002" });
    fo.tables.set("t_05", { id: "t_05", status: "available", capacity: 2 });

    fo.reservations.clear();
    fo.reservations.set("res_001", { id: "res_001", guestId: "g_001", guestName: "Alice Martin", partySize: 2, tableId: "t_02", status: "checked-in" });
    fo.reservations.set("res_002", { id: "res_002", guestId: "g_002", guestName: "Bob Chen", partySize: 5, status: "pending" });
    fo.reservations.set("res_003", { id: "res_003", guestId: "g_003", guestName: "Carol Diaz", partySize: 3, status: "pending" });

    fo.bills.clear();
  }

  return Response.json({ success: true });
}
