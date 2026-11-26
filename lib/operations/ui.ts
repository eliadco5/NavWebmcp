import { z } from "zod";
import { defineOperation } from "./types";
import { ok, fail, type Result } from "@/lib/result";
import {
  UI_ERROR,
  UI_KINDS,
  ComponentId,
  TabRef,
  UiComponentContractSchema,
  UiViewSchema,
  UiSetStateResultSchema,
  UiActionResultSchema,
  type UiCommand,
  type UiSetStateResult,
  type UiActionResult,
} from "@/lib/ui-components/contract";
import { uiRelay, type UiRelayPort } from "@/lib/ui-relay/port";

// The four ui_* meta-ops (NavWebMcp 1.3.0, docs/ui-components.md).
//
// These handlers are the SERVER implementation, used by external MCP clients
// (and by invoke): they read the caller's published page snapshots and relay
// changes to the caller's open tab. In the page itself, lib/adapters/webmcp.ts
// routes the same ops to lib/ui-components/local.ts instead (`runsInPage`), so
// an in-page agent acts on the live registry with no round trip.

const ALL_ROLES = ["customer", "support", "admin"] as const;

const noPage = () =>
  fail(UI_ERROR.NO_PAGE, "The user has no open app tab to operate. Ask them to open the app, then retry.");

const tabIdField = () => TabRef().optional().describe("A browser tab from ui_list; omit for the one in view");

/** The relay, or a failure when this process has no relay installed (it is
 *  installed by server entry points; see lib/ui-relay/port.ts). */
function port(): UiRelayPort | Result<never> {
  return uiRelay() ?? fail(UI_ERROR.NO_PAGE, "The UI relay is not available on this surface.");
}
const isFailure = (x: UiRelayPort | Result<never>): x is Result<never> => "success" in x;

async function relay<T>(userId: string, tabId: string | undefined, cmd: UiCommand): Promise<Result<T>> {
  const r = port();
  if (isFailure(r)) return r;
  const page = await r.pickPage(userId, tabId);
  if (!page) return noPage();
  await r.enqueueCommand(userId, page.tabId, cmd);
  const result = await r.awaitResult(userId, cmd.cmdId);
  if (!result) {
    return fail(UI_ERROR.TIMEOUT, "The user's tab did not respond in time (it may be closed or asleep). Nothing is known to have changed; check with ui_get_state.");
  }
  return result as Result<T>;
}

const newCmdId = () => `cmd_${crypto.randomUUID()}`;

export const uiList = defineOperation({
  name: "ui_list",
  title: "List UI Components",
  description:
    "The UI components on the user's screen (tables, the tab bar) with state, stateSchema and actions. " +
    "Use ui_* when the user should see the result; business operations when only you need the data.",
  permission: "read",
  roles: [...ALL_ROLES],
  alwaysOn: true,
  runsInPage: true,
  // Served over MCP by relaying to the user's tab and waiting for it (up to 8 s).
  credits: { weight: 2 },
  tags: ["ui"],
  inputSchema: {
    kind: z.enum(UI_KINDS).optional().describe("Only this kind"),
    tabId: tabIdField(),
  },
  outputSchema: {
    tabId: z.string().describe("The browser tab these components live in"),
    activeTab: z.string().nullable().describe("The app tab (page) the user is on"),
    openTabs: z.number().int().describe("How many of the user's browser tabs are open"),
    components: z.array(UiComponentContractSchema),
  },
  async handler({ kind, tabId }, ctx) {
    const r = port();
    if (isFailure(r)) return r;
    const page = await r.pickPage(ctx.userId, tabId);
    if (!page) return noPage();
    const openTabs = (await r.livePages(ctx.userId)).length;
    return ok({
      tabId: page.tabId,
      activeTab: page.activeTab,
      openTabs,
      components: page.components.filter((c) => !kind || c.kind === kind),
    });
  },
});

export const uiGetState = defineOperation({
  name: "ui_get_state",
  title: "Get UI Component State",
  description: "One component's current state and row counts.",
  permission: "read",
  roles: [...ALL_ROLES],
  alwaysOn: true,
  runsInPage: true,
  // Served over MCP by relaying to the user's tab and waiting for it (up to 8 s).
  credits: { weight: 2 },
  tags: ["ui"],
  inputSchema: {
    componentId: ComponentId().describe("From ui_list, e.g. tasks.table"),
    tabId: tabIdField(),
  },
  outputSchema: {
    componentId: z.string(),
    kind: z.enum(UI_KINDS),
    state: z.record(z.unknown()),
    version: z.number().int().describe("Pass as expectedVersion to ui_set_state to avoid overwriting a change the user just made"),
    view: UiViewSchema.optional(),
  },
  async handler({ componentId, tabId }, ctx) {
    const r = port();
    if (isFailure(r)) return r;
    const page = await r.pickPage(ctx.userId, tabId);
    if (!page) return noPage();
    const c = page.components.find((x) => x.id === componentId);
    if (!c) {
      const ids = page.components.map((x) => x.id).join(", ") || "none";
      return fail(UI_ERROR.NOT_FOUND, `No mounted component '${componentId}'. Mounted: ${ids}. It may be on another tab: switch tabs via app.nav first.`);
    }
    return ok({ componentId: c.id, kind: c.kind, state: c.state, version: c.version, ...(c.view && { view: c.view }) });
  },
});

export const uiSetState = defineOperation({
  name: "ui_set_state",
  title: "Set UI Component State",
  description:
    "Change what a component shows (filters, sort, active tab) as the user would. " +
    "patch merges: objects merge, arrays replace, null clears. View only; no confirmation needed.",
  permission: "write",
  roles: [...ALL_ROLES],
  alwaysOn: true,
  runsInPage: true,
  // Served over MCP by relaying to the user's tab and waiting for it (up to 8 s).
  credits: { weight: 3 },
  parallelSafe: false,
  tags: ["ui"],
  inputSchema: {
    componentId: ComponentId().describe("From ui_list, e.g. tasks.table or app.nav"),
    patch: z.record(z.unknown()).describe('e.g. { "filters": { "status": "open" } }'),
    expectedVersion: z.number().int().min(0).optional().describe("Fail with UI_STALE_STATE if it changed since this version"),
    tabId: tabIdField(),
  },
  outputSchema: UiSetStateResultSchema,
  async handler({ componentId, patch, expectedVersion, tabId }, ctx) {
    return relay<UiSetStateResult>(ctx.userId, tabId, {
      cmdId: newCmdId(), type: "set_state", componentId, patch,
      ...(expectedVersion !== undefined && { expectedVersion }),
    });
  },
});

export const uiAction = defineOperation({
  name: "ui_action",
  title: "Run UI Component Action",
  description: "Run a component's action from ui_list, e.g. reset or refresh. View only.",
  permission: "write",
  roles: [...ALL_ROLES],
  alwaysOn: true,
  runsInPage: true,
  // Served over MCP by relaying to the user's tab and waiting for it (up to 8 s).
  credits: { weight: 3 },
  parallelSafe: false,
  tags: ["ui"],
  inputSchema: {
    componentId: ComponentId().describe("From ui_list"),
    action: z.string().min(1).max(64).describe("An action name from ui_list"),
    args: z.record(z.unknown()).optional().describe("Its arguments, if any"),
    tabId: tabIdField(),
  },
  outputSchema: UiActionResultSchema,
  async handler({ componentId, action, args, tabId }, ctx) {
    return relay<UiActionResult>(ctx.userId, tabId, {
      cmdId: newCmdId(), type: "action", componentId, action, ...(args && { args }),
    });
  },
});

export const uiOps = [uiList, uiGetState, uiSetState, uiAction];
