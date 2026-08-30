"use client";

import { useState } from "react";
import { useBridge } from "@/app/providers";
import { MyTasksCard } from "./MyTasksCard";
import { TaskSearchCard } from "./TaskSearchCard";
import { CreateTaskCard } from "./CreateTaskCard";

export function TasksPanel() {
  const { user } = useBridge();
  const isPrivileged = user?.role === "support" || user?.role === "admin";
  const isAdmin = user?.role === "admin";
  const [refreshKey, setRefreshKey] = useState(0);

  if (!isPrivileged) {
    return <div className="col"><MyTasksCard /></div>;
  }

  return (
    <div className="grid-2">
      <div className="col">
        <MyTasksCard />
        <CreateTaskCard onCreated={() => setRefreshKey((k) => k + 1)} />
      </div>
      <div className="col">
        <TaskSearchCard key={refreshKey} isAdmin={isAdmin} />
      </div>
    </div>
  );
}
