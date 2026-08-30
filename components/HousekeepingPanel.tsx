"use client";

import { useBridge } from "@/app/providers";
import { TableStatusCard } from "./TableStatusCard";
import { CleaningScheduleCard } from "./CleaningScheduleCard";
import { InspectionsCard } from "./InspectionsCard";

export function HousekeepingPanel() {
  const { user } = useBridge();
  const isAdmin = user?.role === "admin";

  return (
    <div className="grid-2">
      <div className="col">
        <TableStatusCard />
        <CleaningScheduleCard />
      </div>
      <div className="col">
        {isAdmin ? (
          <InspectionsCard />
        ) : (
          <div className="card">
            <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>Inspections</h2>
            <p style={{ fontSize: 13, color: "#9ca3af" }}>Admin only.</p>
          </div>
        )}
      </div>
    </div>
  );
}
