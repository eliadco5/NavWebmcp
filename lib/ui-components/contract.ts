import { z } from "zod";

// Wire shapes of the UI-component extension (NavWebMcp 1.3.0, docs/ui-components.md).
// Client- and server-safe: used by the in-page registry, the relay routes, and the
// ui_* operations' input/output schemas.

/** Standard component kinds. Each kind fixes the overall shape of `state`, so an
 *  agent learns it once (see lib/ui-components/kinds/). */
export const UI_KINDS = ["table", "tabs"] as const;
export type UiKind = (typeof UI_KINDS)[number];

export const UI_ERROR = {
  NOT_FOUND: "UI_COMPONENT_NOT_FOUND",
  STALE: "UI_STALE_STATE",
  INVALID_PATCH: "UI_INVALID_PATCH",
  UNKNOWN_ACTION: "UI_UNKNOWN_ACTION",
  NO_PAGE: "UI_NO_ACTIVE_PAGE",
  TIMEOUT: "UI_TIMEOUT",
} as const;

const COMPONENT_ID_RE = /^[a-z][a-z0-9_.-]*$/i;

// Factories (not shared instances) for the same reason as lib/operations/schemas.ts:
// a reused instance would be emitted as a $ref by the MCP SDK's converter.
export const ComponentId = () =>
  z.string().min(1).max(100).regex(COMPONENT_ID_RE, "Letters, digits, '.', '_' or '-', starting with a letter");
export const TabRef = () => z.string().min(1).max(64);

export const UiActionInfoSchema = z.object({
  name: z.string(),
  description: z.string(),
});

export const UiViewSchema = z.object({
  total: z.number().int().optional().describe("Rows matching the current state"),
  shown: z.number().int().optional().describe("Rows currently rendered"),
});

export const UiComponentContractSchema = z.object({
  id: z.string().describe("Stable component id, e.g. tasks.table"),
  kind: z.enum(UI_KINDS),
  title: z.string(),
  description: z.string().optional(),
  stateSchema: z.record(z.unknown()).describe("JSON Schema of the full component state; a ui_set_state patch must merge into a value that matches it"),
  state: z.record(z.unknown()).describe("Current state, exactly what the user sees"),
  version: z.number().int().describe("Bumped on every state change, by the user or an agent"),
  actions: z.array(UiActionInfoSchema),
  view: UiViewSchema.optional(),
});
export type UiComponentContract = z.infer<typeof UiComponentContractSchema>;

export const UiSetStateResultSchema = {
  componentId: z.string(),
  state: z.record(z.unknown()),
  version: z.number().int(),
};
export type UiSetStateResult = { componentId: string; state: Record<string, unknown>; version: number };

export const UiActionResultSchema = {
  componentId: z.string(),
  action: z.string(),
  state: z.record(z.unknown()).describe("Component state after the action"),
  version: z.number().int(),
};
export type UiActionResult = { componentId: string; action: string; state: Record<string, unknown>; version: number };

/** One open browser tab's published components. */
export const UiPageSnapshotSchema = z.object({
  tabId: TabRef(),
  activeTab: z.string().max(64).nullable(),
  visible: z.boolean(),
  focusedAt: z.number().int(),
  components: z.array(UiComponentContractSchema).max(50),
});
export type UiPageSnapshot = z.infer<typeof UiPageSnapshotSchema>;

export const UiCommandSchema = z.discriminatedUnion("type", [
  z.object({
    cmdId: z.string().max(64),
    type: z.literal("set_state"),
    componentId: z.string().max(100),
    patch: z.record(z.unknown()),
    expectedVersion: z.number().int().optional(),
  }),
  z.object({
    cmdId: z.string().max(64),
    type: z.literal("action"),
    componentId: z.string().max(100),
    action: z.string().max(64),
    args: z.record(z.unknown()).optional(),
  }),
]);
export type UiCommand = z.infer<typeof UiCommandSchema>;
