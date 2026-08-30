import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { housekeepingTableStatus } from "@/lib/seed";

const tableStatusMap = housekeepingTableStatus();

export const getTableCleaningStatus = defineOperation({
  name: "getTableCleaningStatus",
  title: "Get Table Cleaning Status",
  description: "Get the cleaning status of all tables (clean, dirty, in-progress).",
  permission: "read",
  roles: ["support", "admin"],
  module: "housekeeping.status",
  inputSchema: {},
  async handler(_input, _ctx) {
    const tables = Array.from(tableStatusMap.values());
    const summary = {
      clean: tables.filter((t) => t.status === "clean").length,
      dirty: tables.filter((t) => t.status === "dirty").length,
      inProgress: tables.filter((t) => t.status === "in-progress").length,
    };
    return ok({ tables, summary });
  },
});
