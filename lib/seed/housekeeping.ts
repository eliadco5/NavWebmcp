import { singleton, singletonMap, resetMap, resetArray, isoAt } from "./store";

export type TableStatusRecord = {
  tableId: string;
  status: "clean" | "dirty" | "in-progress";
  lastUpdated: string;
  updatedBy: string;
};

const HOUSEKEEPING_TABLE_STATUS_KEY = "__housekeepingTableStatus";
function buildHousekeepingTableStatus(): [string, TableStatusRecord][] {
  return [
    ["t_01", { tableId: "t_01", status: "clean", lastUpdated: isoAt(0, 8), updatedBy: "staff_maria" }],
    ["t_02", { tableId: "t_02", status: "dirty", lastUpdated: isoAt(0, 9, 15), updatedBy: "staff_jose" }],
    ["t_03", { tableId: "t_03", status: "in-progress", lastUpdated: isoAt(0, 9, 30), updatedBy: "staff_maria" }],
    ["t_04", { tableId: "t_04", status: "clean", lastUpdated: isoAt(0, 7, 45), updatedBy: "staff_carlos" }],
    ["t_05", { tableId: "t_05", status: "dirty", lastUpdated: isoAt(0, 9), updatedBy: "staff_jose" }],
  ];
}
export function housekeepingTableStatus(): Map<string, TableStatusRecord> {
  return singletonMap(HOUSEKEEPING_TABLE_STATUS_KEY, buildHousekeepingTableStatus);
}
export function resetHousekeepingTableStatus(): void {
  resetMap(HOUSEKEEPING_TABLE_STATUS_KEY, buildHousekeepingTableStatus);
}

export type ScheduleItem = {
  id: string;
  tableId: string;
  scheduledTime: string;
  assignee: string;
  task: string;
  done: boolean;
  completedAt?: string;
};

const HOUSEKEEPING_SCHEDULE_KEY = "__housekeepingScheduleItems";
function buildHousekeepingSchedule(): ScheduleItem[] {
  return [
    { id: "sched_001", tableId: "t_01", scheduledTime: "08:00", assignee: "staff_maria", task: "Full sanitize", done: true, completedAt: isoAt(0, 8, 12) },
    { id: "sched_002", tableId: "t_02", scheduledTime: "09:00", assignee: "staff_jose", task: "Wipe and reset", done: false },
    { id: "sched_003", tableId: "t_03", scheduledTime: "09:30", assignee: "staff_maria", task: "Deep clean", done: false },
    { id: "sched_004", tableId: "t_04", scheduledTime: "10:00", assignee: "staff_carlos", task: "Standard clean", done: false },
    { id: "sched_005", tableId: "t_05", scheduledTime: "10:30", assignee: "staff_jose", task: "Wipe and reset", done: false },
  ];
}
export function housekeepingScheduleItems(): ScheduleItem[] {
  return singleton(HOUSEKEEPING_SCHEDULE_KEY, buildHousekeepingSchedule);
}
export function resetHousekeepingSchedule(): void {
  resetArray(HOUSEKEEPING_SCHEDULE_KEY, buildHousekeepingSchedule);
}

export type InspectionRecord = {
  id: string;
  tableId: string;
  inspector: string;
  result: "pass" | "fail";
  notes: string;
  timestamp: string;
};

const HOUSEKEEPING_INSPECTIONS_KEY = "__housekeepingInspections";
function buildHousekeepingInspections(): InspectionRecord[] {
  return [
    { id: "insp_001", tableId: "t_01", inspector: "admin_paula", result: "pass", notes: "Surface clean, no residue.", timestamp: isoAt(0, 8, 20) },
    { id: "insp_002", tableId: "t_02", inspector: "admin_paula", result: "fail", notes: "Sticky residue under edge, needs re-clean.", timestamp: isoAt(0, 9, 5) },
    { id: "insp_003", tableId: "t_04", inspector: "admin_raj", result: "pass", notes: "All clear, ready for service.", timestamp: isoAt(0, 8) },
  ];
}
export function housekeepingInspections(): InspectionRecord[] {
  return singleton(HOUSEKEEPING_INSPECTIONS_KEY, buildHousekeepingInspections);
}
export function resetHousekeepingInspections(): void {
  resetArray(HOUSEKEEPING_INSPECTIONS_KEY, buildHousekeepingInspections);
}
