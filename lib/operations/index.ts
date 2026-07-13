import { registry } from "./registry";
import { searchAvailability } from "./searchAvailability";
import { createReservation } from "./createReservation";
import { cancelReservation } from "./cancelReservation";
import { listReservations } from "./listReservations";
import { getReservation } from "./getReservation";
import { getContext } from "./getContext";
import { listAllReservations } from "./listAllReservations";
import { cancelAnyReservation } from "./cancelAnyReservation";
import { getCapabilities } from "./getCapabilities";
import { explore } from "./explore";
import { describeTool } from "./describeTool";
import { invoke } from "./invoke";
import { loadTools } from "./loadTools";
import { unloadTools } from "./unloadTools";
// CRM
import { searchGuests } from "./searchGuests";
import { getGuest } from "./getGuest";
import { createGuest } from "./createGuest";
import { updateGuest } from "./updateGuest";
import { getGuestPreferences } from "./getGuestPreferences";
import { updateGuestPreferences } from "./updateGuestPreferences";
import { getLoyaltyStatus } from "./getLoyaltyStatus";
import { addLoyaltyPoints } from "./addLoyaltyPoints";
import { listCommunications } from "./listCommunications";
import { logCommunication } from "./logCommunication";
// Front Office
import { checkInGuest } from "./checkInGuest";
import { getCheckinStatus } from "./getCheckinStatus";
import { checkOutGuest } from "./checkOutGuest";
import { getBillSummary } from "./getBillSummary";
import { getOccupancy } from "./getOccupancy";
import { getWaitTime } from "./getWaitTime";
import { listShiftNotes } from "./listShiftNotes";
import { addShiftNote } from "./addShiftNote";
// Tasks
import { createTask } from "./createTask";
import { updateTask } from "./updateTask";
import { searchTasks } from "./searchTasks";
import { deleteTask } from "./deleteTask";
import { getMyTasks } from "./getMyTasks";
import { completeTask } from "./completeTask";
// Housekeeping
import { getTableCleaningStatus } from "./getTableCleaningStatus";
import { updateTableStatus } from "./updateTableStatus";
import { getTodaySchedule } from "./getTodaySchedule";
import { markScheduleItemDone } from "./markScheduleItemDone";
import { listInspections } from "./listInspections";
import { logInspection } from "./logInspection";
// Finance
import { getDailyRevenueSummary } from "./getDailyRevenueSummary";
import { getWeeklyRevenueSummary } from "./getWeeklyRevenueSummary";
import { getPaymentRecord } from "./getPaymentRecord";
import { listPayments } from "./listPayments";
import { issueRefund } from "./issueRefund";
import { applyNoShowFee } from "./applyNoShowFee";
import { logManualAdjustment } from "./logManualAdjustment";

registry.push(
  // Always-on navigation & meta
  explore, describeTool, invoke, loadTools, unloadTools, getContext, getCapabilities,
  // Reservation
  searchAvailability, createReservation, cancelReservation,
  listReservations, getReservation, listAllReservations, cancelAnyReservation,
  // CRM
  searchGuests, getGuest, createGuest, updateGuest,
  getGuestPreferences, updateGuestPreferences,
  getLoyaltyStatus, addLoyaltyPoints,
  listCommunications, logCommunication,
  // Front Office
  checkInGuest, getCheckinStatus, checkOutGuest, getBillSummary,
  getOccupancy, getWaitTime, listShiftNotes, addShiftNote,
  // Tasks
  createTask, updateTask, searchTasks, deleteTask, getMyTasks, completeTask,
  // Housekeeping
  getTableCleaningStatus, updateTableStatus, getTodaySchedule,
  markScheduleItemDone, listInspections, logInspection,
  // Finance
  getDailyRevenueSummary, getWeeklyRevenueSummary,
  getPaymentRecord, listPayments,
  issueRefund, applyNoShowFee, logManualAdjustment,
);

export { registry };
export type { Operation } from "./types";
