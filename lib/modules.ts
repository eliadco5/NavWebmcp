import type { Role } from "@/lib/auth";
import { roleSatisfies } from "@/lib/auth";
import type { Operation } from "@/lib/operations/types";

export interface ModuleNode {
  path: string;
  title: string;
  description: string;
}
export interface FnSummary {
  name: string;
  title: string;
  description: string;
  permission: "read" | "write";
  parallelSafe: boolean;
  requiresConfirmation?: boolean;
}
export interface ExploreNode {
  path: string;
  title: string;
  description: string;
  submodules: ModuleNode[];
  functions: FnSummary[];
}
export interface PlatformManifest {
  app: string;
  description: string;
  modules: ModuleNode[];
}

// Flat module registry — add new modules here as the platform grows.
export const MODULE_DEFS: ModuleNode[] = [
  // Reservation
  { path: "reservation", title: "Reservation", description: "Create and manage table reservations, search availability, and handle cancellations." },
  { path: "reservation.availability", title: "Availability", description: "Search for open time slots by date and party size." },
  { path: "reservation.booking", title: "Booking", description: "Create and cancel reservations. Write operations — confirmation required for destructive actions." },
  { path: "reservation.search", title: "Search", description: "Look up existing reservations by ID or list all reservations for the current user." },
  { path: "reservation.admin", title: "Admin", description: "Cross-user reservation management. Available to support and admin roles only." },
  // CRM
  { path: "crm", title: "CRM", description: "Customer relationship management — guest profiles, preferences, loyalty status, and communication history." },
  { path: "crm.guests", title: "Guests", description: "Create and retrieve guest profiles, search by name or email." },
  { path: "crm.preferences", title: "Preferences", description: "Read and update guest dining preferences, dietary restrictions, and special notes." },
  { path: "crm.loyalty", title: "Loyalty", description: "View loyalty tier, point balance, and redemption history." },
  { path: "crm.communications", title: "Communications", description: "Log and retrieve guest communication history (calls, emails, notes). Support and admin only." },
  // Front Office
  { path: "frontoffice", title: "Front Office", description: "Day-of operations — check-in/check-out, current occupancy, shift notes, and walk-in handling." },
  { path: "frontoffice.checkin", title: "Check-In", description: "Process guest arrivals: confirm reservation, assign table, and mark as seated." },
  { path: "frontoffice.checkout", title: "Check-Out", description: "Close a table: generate bill summary and mark table as available." },
  { path: "frontoffice.occupancy", title: "Occupancy", description: "Real-time view of table occupancy and wait times." },
  { path: "frontoffice.shifts", title: "Shifts", description: "Shift handover notes and daily briefings. Support and admin only." },
  // Tasks
  { path: "tasks", title: "Tasks", description: "Operational task tracking — assign, update, and close tasks for staff across departments." },
  { path: "tasks.management", title: "Management", description: "Create, assign, and update tasks. Search open tasks by department or assignee." },
  { path: "tasks.assignments", title: "Assignments", description: "View tasks assigned to the current user; mark tasks as done." },
  // Housekeeping
  { path: "housekeeping", title: "Housekeeping", description: "Venue cleanliness — room/table status, cleaning schedules, and inspection logs." },
  { path: "housekeeping.status", title: "Status", description: "View current cleaning status for all tables and rooms." },
  { path: "housekeeping.schedule", title: "Schedule", description: "View today's cleaning schedule and mark items as completed." },
  { path: "housekeeping.inspections", title: "Inspections", description: "Log and retrieve inspection results. Support and admin only." },
  // Finance
  { path: "finance", title: "Finance", description: "Revenue and billing — daily summaries, payment records, refunds, and no-show fees. Admin only." },
  { path: "finance.revenue", title: "Revenue", description: "Daily and weekly revenue summaries by cover, category, and payment method." },
  { path: "finance.payments", title: "Payments", description: "Look up individual payment records and generate receipts." },
  { path: "finance.adjustments", title: "Adjustments", description: "Issue refunds, apply no-show fees, and log manual adjustments." },
];

const moduleByPath = new Map<string, ModuleNode>(MODULE_DEFS.map((m) => [m.path, m]));

const APP_INFO = {
  app: "AgentBridge Hospitality",
  description:
    "A full-service hospitality platform covering reservations, CRM, front-office operations, " +
    "task management, housekeeping, and finance. " +
    "Use explore() to navigate the module tree and discover available functions.",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function effectiveParallelSafe(op: Operation<any, any>): boolean {
  if (op.parallelSafe !== undefined) return op.parallelSafe;
  return op.permission === "read";
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fnSummary(op: Operation<any, any>): FnSummary {
  return {
    name: op.name, title: op.title, description: op.description,
    permission: op.permission, parallelSafe: effectiveParallelSafe(op),
    requiresConfirmation: op.requiresConfirmation,
  };
}

function isChildOf(childPath: string, parentPath: string): boolean {
  return childPath === parentPath || childPath.startsWith(parentPath + ".");
}

function directChildrenOf(parentPath: string): ModuleNode[] {
  return MODULE_DEFS.filter((m) => {
    if (m.path === parentPath) return false;
    if (!isChildOf(m.path, parentPath)) return false;
    const rest = m.path.slice(parentPath.length + 1);
    return !rest.includes(".");
  });
}

function topLevelModules(): ModuleNode[] {
  return MODULE_DEFS.filter((m) => !m.path.includes("."));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function fnsForModule(path: string, role: Role, ops: Operation<any, any>[]): FnSummary[] {
  return ops
    .filter((op) => op.module === path && !op.alwaysOn && roleSatisfies(role, op.roles))
    .map(fnSummary);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function getNode(path: string, role: Role, ops: Operation<any, any>[]): ExploreNode | null {
  const mod = moduleByPath.get(path);
  if (!mod) return null;
  return {
    path: mod.path, title: mod.title, description: mod.description,
    submodules: directChildrenOf(path),
    functions: fnsForModule(path, role, ops),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function expandWildcard(pattern: string, role: Role, ops: Operation<any, any>[]): ExploreNode[] {
  if (pattern === "*") {
    return MODULE_DEFS.map((m) => ({
      path: m.path, title: m.title, description: m.description,
      submodules: directChildrenOf(m.path),
      functions: fnsForModule(m.path, role, ops),
    }));
  }
  const base = pattern.slice(0, -2);
  return MODULE_DEFS
    .filter((m) => m.path !== base && isChildOf(m.path, base))
    .map((m) => ({
      path: m.path, title: m.title, description: m.description,
      submodules: directChildrenOf(m.path),
      functions: fnsForModule(m.path, role, ops),
    }));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function platformManifest(role: Role, ops: Operation<any, any>[]): PlatformManifest {
  const visible = topLevelModules().filter((m) =>
    ops.some((op) => op.module && isChildOf(op.module, m.path) && !op.alwaysOn && roleSatisfies(role, op.roles))
  );
  return { ...APP_INFO, modules: visible };
}
