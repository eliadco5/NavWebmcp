import { resetAllSeedStores } from "@/lib/seed";
import { withSharedState } from "@/lib/shared-state";

// Re-seeds every operations store (CRM, tasks, housekeeping, finance,
// front-office) to its initial demo state, in place. Two callers:
//   - scripts/bench.mjs, so it can re-run flows without restarting the server
//     (checkOutGuest is a one-way transition, so without this the seeded
//     res_003 could only be seated once per server lifetime)
//   - the "Reset demo data" button in the Agent tab, as recovery for a judge
//     who's checked out every guest and is stuck looking at an empty panel.
//
// No admin gate: the role switcher (POST /api/switch-role) already lets any
// visitor become admin with one click, so an admin-only check here would be
// theatre, not security. This route only restores in-memory seed data — it
// cannot destroy anything a real deployment would care about.
export const POST = withSharedState(async function POST() {
  if (process.env.DEMO_MODE === "false") {
    return Response.json({ success: false, error: { code: "FORBIDDEN", message: "Disabled." } }, { status: 404 });
  }

  // Wrapped in withSharedState so the freshly reseeded data (not the stale
  // hydrated-from-Redis data resetAllSeedStores() just overwrote) is what gets
  // flushed back. booking/audit/loaded aren't touched by resetAllSeedStores(),
  // so their snapshots won't have changed and flush skips writing them.
  resetAllSeedStores();
  return Response.json({ success: true });
});
