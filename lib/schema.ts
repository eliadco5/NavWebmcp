import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// Client-safe: imported by lib/agentbridge.ts, which runs in the browser.

/** Strict input object: unknown keys are rejected, matching the
 *  `additionalProperties: false` every published input schema advertises. */
export function inputObject<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

export function outputObject<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape);
}

/**
 * Rebuild a Zod v3 schema so that no sub-schema instance occurs twice. The MCP
 * SDK converts with zod-to-json-schema's default $refStrategy, which detects
 * repeats by `_def` identity and emits them as JSON-pointer `$ref`s (e.g. a
 * shared LoyaltyTier enum, or ModuleNodeSchema reused inside explore's output).
 * Cloning every occurrence makes the SDK inline them, matching toJsonSchema().
 */
export function inlineSchema<T extends z.ZodTypeAny>(schema: T): T {
  const def = (schema as unknown as { _def: Record<string, unknown> })._def;
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(def)) {
    if (key === "shape" && typeof value === "function") {
      const shape = Object.fromEntries(
        Object.entries((value as () => z.ZodRawShape)()).map(([k, s]) => [k, inlineSchema(s)])
      );
      next[key] = () => shape;
    } else {
      next[key] = inlineValue(value);
    }
  }
  const Ctor = schema.constructor as new (def: Record<string, unknown>) => T;
  return new Ctor(next);
}

function inlineValue(value: unknown): unknown {
  if (value instanceof z.ZodType) return inlineSchema(value);
  if (Array.isArray(value)) return value.map(inlineValue);
  if (value instanceof Map) return new Map([...value].map(([k, v]) => [k, inlineValue(v)]));
  return value;
}

export function toJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  return zodToJsonSchema(schema, { $refStrategy: "none" }) as Record<string, unknown>;
}

export const ErrorSchema = z.object({
  code: z.string().describe("Machine-readable error code, e.g. NOT_FOUND or FORBIDDEN"),
  message: z.string().describe("Human-readable explanation"),
});

/** The Result envelope the in-page surface (WebMCP execute) actually returns. */
export function envelopeSchema(dataShape: z.ZodRawShape) {
  return z.discriminatedUnion("success", [
    z.object({ success: z.literal(true), data: outputObject(dataShape) }),
    z.object({ success: z.literal(false), error: ErrorSchema }),
  ]);
}

/** Log-only output check. A mismatch is a bug for the contract test to catch;
 *  at runtime the data is still returned. */
export function checkOutput(opName: string, outputSchema: z.ZodRawShape, data: unknown): void {
  const parsed = outputObject(outputSchema).safeParse(data);
  if (!parsed.success) {
    console.warn(
      `[output-schema] '${opName}' returned data that does not match its outputSchema:`,
      parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")
    );
  }
}
