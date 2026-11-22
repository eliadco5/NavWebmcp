import { z } from "zod";

// Shared between the browser (which builds the bundle) and the server (which
// validates and stores it). Every free-text and blob field is capped so a
// single report can't blow up the shared-state snapshot in Redis.

export const BUG_CATEGORIES = [
  "wrong-label", "wrong-value", "missing-data", "layout", "error", "other",
] as const;
export const BugCategory = z.enum(BUG_CATEGORIES);
export type BugCategory = z.infer<typeof BugCategory>;

export const CATEGORY_LABELS: Record<BugCategory, string> = {
  "wrong-label": "Wrong label / title",
  "wrong-value": "Wrong value",
  "missing-data": "Missing data",
  layout: "Layout / visual",
  error: "Error / crash",
  other: "Other",
};

export const BugStatus = z.enum(["open", "triaged", "fixed"]);
export type BugStatus = z.infer<typeof BugStatus>;

const Text = (max: number) => z.string().max(max);

export const ConsoleEntrySchema = z.object({
  level: z.enum(["log", "info", "warn", "error", "debug"]),
  ts: z.string(),
  message: Text(4_000),
  stack: Text(4_000).optional(),
});
export type ConsoleEntry = z.infer<typeof ConsoleEntrySchema>;

export const NetworkEntrySchema = z.object({
  method: Text(10),
  url: Text(2_000),
  status: z.number().int().nullable(),
  durationMs: z.number(),
  ts: z.string(),
  requestBody: Text(25_000).optional(),
  responseBody: Text(25_000).optional(),
  error: Text(1_000).optional(),
  /** Set for POST /api/call — the business-level op this request ran. */
  op: z.object({
    name: Text(100),
    params: z.unknown(),
    success: z.boolean().nullable(),
    errorCode: Text(100).optional(),
  }).optional(),
});
export type NetworkEntry = z.infer<typeof NetworkEntrySchema>;

export const ProvenanceSchema = z.object({
  op: Text(100),
  field: Text(300).optional(),
  entity: Text(200).optional(),
  params: z.unknown().optional(),
  /** Value found in the last response of `op` at `field` (for `entity`). */
  apiValue: z.unknown().optional(),
  apiValueFound: z.boolean(),
  uiText: Text(2_000),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const ElementInfoSchema = z.object({
  selector: Text(2_000),
  tag: Text(50),
  id: Text(200).optional(),
  classes: z.array(Text(200)).max(50),
  text: Text(2_000),
  outerHTML: Text(4_000),
  rect: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  styles: z.record(Text(500)),
  a11y: z.object({
    role: Text(100).optional(),
    ariaLabel: Text(500).optional(),
    label: Text(500).optional(),
    value: Text(2_000).optional(),
    placeholder: Text(500).optional(),
  }),
  componentStack: z.array(Text(200)).max(30),
  component: Text(200).optional(),
  provenance: ProvenanceSchema.optional(),
});
export type ElementInfo = z.infer<typeof ElementInfoSchema>;

export const AuditSummarySchema = z.object({
  timestamp: Text(50),
  operation: Text(100),
  success: z.boolean(),
  source: Text(20),
  input: z.unknown().optional(),
});

/** What the browser sends. The server adds id/createdAt/reporter/status. */
export const BugReportInputSchema = z.object({
  category: BugCategory,
  description: Text(4_000).min(1),
  expected: Text(1_000).optional(),
  actual: Text(1_000).optional(),
  page: z.object({
    url: Text(2_000),
    tab: Text(100).optional(),
    viewport: z.object({ width: z.number(), height: z.number() }),
    userAgent: Text(500),
    storeVersion: z.number().optional(),
  }),
  element: ElementInfoSchema.optional(),
  console: z.array(ConsoleEntrySchema).max(250).default([]),
  network: z.array(NetworkEntrySchema).max(120).default([]),
  recentAudit: z.array(AuditSummarySchema).max(50).default([]),
  /** JPEG/PNG data URL, ~1 MB cap. */
  screenshot: z.string().max(1_000_000).regex(/^data:image\/(jpeg|png);base64,/).optional(),
});
export type BugReportInput = z.infer<typeof BugReportInputSchema>;

export const SinkResultSchema = z.object({
  sink: z.string(),
  ok: z.boolean(),
  ref: z.string().optional(),
  url: z.string().optional(),
  error: z.string().optional(),
});
export type SinkResult = z.infer<typeof SinkResultSchema>;

export const ReplayCallSchema = z.object({
  name: z.string(),
  params: z.unknown(),
  success: z.boolean().nullable(),
});

/** Server-assigned fields, added on submit. */
export const BugReportMetaShape = {
  id: z.string(),
  createdAt: z.string(),
  reporter: z.object({ userId: z.string(), role: z.string(), displayName: z.string() }),
  status: BugStatus,
  /** Replayable business calls derived from `network` — feed to invoke(). */
  calls: z.array(ReplayCallSchema),
  sinks: z.array(SinkResultSchema),
};

export const BugReportSchema = BugReportInputSchema.extend(BugReportMetaShape);
export type BugReport = z.infer<typeof BugReportSchema>;

/** Extracts the replayable /api/call list from a network log. */
export function callsFromNetwork(network: NetworkEntry[]): BugReport["calls"] {
  return network
    .filter((n) => n.op)
    .map((n) => ({ name: n.op!.name, params: n.op!.params, success: n.op!.success }));
}
