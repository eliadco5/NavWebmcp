"use client";

import { useEffect, useState } from "react";
import { useBridge } from "@/app/providers";
import { ActivityLog } from "./ActivityLog";
import { ReservationsPanel } from "./ReservationsPanel";
import { FrontDeskPanel } from "./FrontDeskPanel";
import { ShiftNotesCard } from "./ShiftNotesCard";
import { CrmPanel } from "./CrmPanel";
import { TasksPanel } from "./TasksPanel";
import { HousekeepingPanel } from "./HousekeepingPanel";
import { FinancePanel } from "./FinancePanel";
import { UsersPanel } from "./UsersPanel";
import { AgentPanel } from "./AgentPanel";

type Role = "customer" | "support" | "admin";

interface Tab {
  id: string;
  label: string;
  visible: (role: Role) => boolean;
  render: () => React.ReactNode;
}

const ROLES: Role[] = ["customer", "support", "admin"];

// One entry per domain tab. `visible` gates both the tab button and (as a
// safety net) which panel can ever render — mirrors the role gating pattern
// BookingApp.tsx used to apply as plain JSX conditionals.
const TABS: Tab[] = [
  { id: "reservations", label: "Reservations", visible: () => true, render: () => <ReservationsPanel /> },
  {
    id: "frontdesk", label: "Front Desk", visible: (r) => r !== "customer",
    render: () => (
      <div className="col">
        <FrontDeskPanel />
        <ShiftNotesCard />
      </div>
    ),
  },
  { id: "guests", label: "Guests", visible: () => true, render: () => <CrmPanel /> },
  { id: "tasks", label: "Tasks", visible: () => true, render: () => <TasksPanel /> },
  { id: "housekeeping", label: "Housekeeping", visible: (r) => r !== "customer", render: () => <HousekeepingPanel /> },
  { id: "finance", label: "Finance", visible: (r) => r === "admin", render: () => <FinancePanel /> },
  { id: "agent", label: "Agent", visible: () => true, render: () => <AgentPanel /> },
];

function useHashTab(defaultId: string): [string, (id: string) => void] {
  const [tab, setTab] = useState(defaultId);

  useEffect(() => {
    const fromHash = window.location.hash.replace("#", "");
    if (fromHash) setTab(fromHash);
  }, []);

  const set = (id: string) => {
    setTab(id);
    window.location.hash = id;
  };

  return [tab, set];
}

export function AppShell() {
  const { user, logout, switchRole, auditEntries } = useBridge();
  const [activeTab, setActiveTab] = useHashTab("reservations");

  const role = (user?.role ?? "customer") as Role;
  const visibleTabs = TABS.filter((t) => t.visible(role));
  const isAdmin = role === "admin";

  // If a role switch makes the current tab invisible (e.g. admin -> customer
  // while on a support-only tab), fall back to a tab that's always there
  // instead of leaving the screen blank.
  useEffect(() => {
    if (!visibleTabs.some((t) => t.id === activeTab)) {
      setActiveTab("reservations");
    }
  }, [visibleTabs, activeTab]); // eslint-disable-line react-hooks/exhaustive-deps

  const active = visibleTabs.find((t) => t.id === activeTab) ?? visibleTabs[0];

  return (
    <div className="container">
      <div className="app-header">
        <div>
          <h1 style={{ fontSize: 28, fontWeight: 700 }}>AgentBridge Booking Demo</h1>
          <p style={{ color: "#6b7280", marginTop: 6 }}>
            Book a table — or let an AI agent do it.
          </p>
          <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
            <a href="/docs/presentation.html" target="_blank" rel="noopener" style={{ fontSize: 12, color: "#4f46e5" }}>
              Slides
            </a>
            <a href="/docs/progressive-tool-disclosure.html" target="_blank" rel="noopener" style={{ fontSize: 12, color: "#4f46e5" }}>
              Progressive Disclosure
            </a>
            <a href="/docs/navcmcp-comparison.html" target="_blank" rel="noopener" style={{ fontSize: 12, color: "#4f46e5" }}>
              Comparison
            </a>
          </div>
        </div>
        {user && (
          <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 6 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
              <span style={{ fontSize: 13, color: "#374151" }}>
                Signed in as <strong>{user.displayName}</strong>
              </span>
              <span style={{
                fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 12,
                background: role === "admin" ? "#fef3c7" : role === "support" ? "#ede9fe" : "#e0f2fe",
                color: role === "admin" ? "#92400e" : role === "support" ? "#5b21b6" : "#0369a1",
              }}>
                {role}
              </span>
              <button
                type="button"
                onClick={logout}
                style={{ fontSize: 12, padding: "4px 12px", background: "#f3f4f6", color: "#374151" }}
              >
                Sign out
              </button>
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
              {ROLES.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => switchRole(r)}
                  disabled={r === role}
                  style={{
                    fontSize: 11, padding: "3px 10px", borderRadius: 99,
                    background: r === role ? "#4f46e5" : "#f3f4f6",
                    color: r === role ? "#fff" : "#374151",
                  }}
                >
                  {r}
                </button>
              ))}
              <span style={{ fontSize: 10, color: "#9ca3af", marginLeft: 4 }}>demo mode</span>
            </div>
          </div>
        )}
      </div>

      <div className="tabs" role="tablist">
        {visibleTabs.map((t) => (
          <button
            key={t.id}
            type="button"
            role="tab"
            aria-selected={t.id === active?.id}
            className="tab"
            onClick={() => setActiveTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="col">
        {active?.render()}

        {isAdmin && <UsersPanel />}

        <div className="card">
          <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 16 }}>
            Activity Log
            <span style={{ marginLeft: 8, fontSize: 12, color: "#9ca3af", fontWeight: 400 }}>
              (agent + UI calls)
            </span>
          </h2>
          <ActivityLog entries={auditEntries} />
        </div>
      </div>
    </div>
  );
}
