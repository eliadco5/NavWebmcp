import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Client-safe: imported by lib/agentbridge.ts, which runs in the browser.

/** Strict input object: unknown keys are rejected, matching the
 *  `additionalProperties: false` every published input schema advertises. */
export function inputObject<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

/** `open`: the data may carry keys beyond `shape` (see Operation.openOutput). */
export function outputObject<T extends z.ZodRawShape>(shape: T, open = false) {
  return open ? z.object(shape).passthrough() : z.object(shape);
}

/** The one JSON Schema converter for every surface: MCP tools/list,
 *  describe_tool, getCapabilities and WebMCP. Repeated sub-schemas are inlined,
 *  never emitted as `$ref`. */
export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
}

export const ErrorSchema = z.object({
  code: z.string().describe("Machine-readable error code, e.g. NOT_FOUND or FORBIDDEN"),
  message: z.string().describe("Human-readable explanation"),
  retryable: z.boolean().describe("True when re-sending the identical call may succeed"),
  details: z.array(z.object({ path: z.string(), message: z.string() })).optional()
    .describe("Field-level validation failures (INVALID_INPUT)"),
  hint: z.string().optional().describe("One-line next step"),
  suggestions: z.array(z.string()).optional().describe("Candidate values, e.g. did-you-mean operation names"),
  requestId: z.string().optional().describe("The top-level request this call belonged to"),
  callId: z.string().optional().describe("The operation call that failed (audit callId)"),
});

/** The Result envelope the in-page surface (WebMCP execute) actually returns. */
export function envelopeSchema(dataShape: z.ZodRawShape, open = false) {
  return z.discriminatedUnion("success", [
    z.object({ success: z.literal(true), data: outputObject(dataShape, open) }),
    z.object({ success: z.literal(false), error: ErrorSchema }),
  ]);
}

/** Log-only output check. A mismatch is a bug for the contract test to catch;
 *  at runtime the data is still returned. */
export function checkOutput(opName: string, outputSchema: z.ZodRawShape, data: unknown, open = false): void {
  const parsed = outputObject(outputSchema, open).safeParse(data);
  if (!parsed.success) {
    console.warn(
      `[output-schema] '${opName}' returned data that does not match its outputSchema:`,
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    );
  }
}
