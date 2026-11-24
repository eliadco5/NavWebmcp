import type { Operation } from "@/lib/operations/types";
import type { Role } from "@/lib/auth";
import { roleSatisfies } from "@/lib/auth";
import { PROTOCOL_VERSION } from "@/lib/protocol";
import { creditCost } from "@/lib/credits/policy";
import { inputObject, outputObject, toJsonSchema } from "@/lib/schema";

/** DJB2 hash over a string → 8-char hex. Stable across calls for the same input. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h >>>= 0; // keep 32-bit unsigned
  }
  return h.toString(16).padStart(8, "0");
}

/** JSON.stringify with object keys sorted at every level, so key order never moves the hash. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    // JSON Schema's `required` is a set; its order follows the Zod shape's key order.
    return `{${entries.map(([k, v]) => {
      const val = k === "required" && Array.isArray(v) ? [...v].sort() : v;
      return `${JSON.stringify(k)}:${canonicalJson(val)}`;
    }).join(",")}}`;
  }
  return JSON.stringify(value);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const fingerprintCache = new WeakMap<Operation<any, any>, string>();

/**
 * Stable canonical string for an operation. Covers everything an agent relies on:
 * the full published input and output JSON Schemas (types, required-ness, enums,
 * bounds, descriptions), not just their key names, plus every flag that changes
 * how the op must be called, and its credit cost (a cost change is drift an agent
 * that planned its pacing on the cached manifest should see). Hashing only key
 * names missed a field changing type or becoming required, so agents kept
 * calling with a stale cached schema.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function opFingerprint(op: Operation<any, any>): string {
  const cached = fingerprintCache.get(op);
  if (cached !== undefined) return cached;
  const fp = canonicalJson({
    name: op.name,
    permission: op.permission,
    roles: [...op.roles].sort(),
    module: op.module ?? null,
    parallelSafe: op.parallelSafe ?? null,
    requiresConfirmation: op.requiresConfirmation ?? false,
    untrustedOutput: op.untrustedOutput ?? false,
    dispatchesOps: op.dispatchesOps ?? false,
    alwaysOn: op.alwaysOn ?? false,
    runsInPage: op.runsInPage ?? false,
    credits: creditCost(op),
    input: toJsonSchema(inputObject(op.inputSchema)),
    output: toJsonSchema(outputObject(op.outputSchema ?? {}, op.openOutput)),
  });
  fingerprintCache.set(op, fp);
  return fp;
}

/**
 * Short content hash over a list of operations (sorted by name for stability).
 * Not a protocol version — see lib/protocol.ts. Changes when the registry drifts
 * (an operation is added, removed, or its shape changes); used as a cache-bust key.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function computeCapabilityHash(ops: Operation<any, any>[]): string {
  const sorted = [...ops].sort((a, b) => a.name.localeCompare(b.name));
  const fingerprint = sorted.map(opFingerprint).join(";");
  return djb2(fingerprint);
}

/** Operations visible to a given role. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function visibleOps(role: Role, registry: Operation<any, any>[]): Operation<any, any>[] {
  return registry.filter((op) => roleSatisfies(role, op.roles));
}

export interface CapabilityManifestTool {
  name: string;
  title: string;
  permission: "read" | "write";
  roles: Role[];
  requiresConfirmation: boolean;
  /** Credit cost of one call on its own (lib/credits/policy.ts creditCost). */
  credits: number;
}

/** The manifest shape returned by getCapabilities. This is the observable protocol
 * surface that lib/protocol.ts's bump rules refer to. */
export interface CapabilityManifest {
  /** Semver of the NavWebMcp protocol contract. Global — identical for every role. */
  protocolVersion: string;
  /** 8-hex content hash of the ops visible to THIS role. Cache-bust key. */
  capabilityHash: string;
  count: number;
  tools: CapabilityManifestTool[];
}

/** The manifest an agent receives from getCapabilities. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function capabilityManifest(role: Role, registry: Operation<any, any>[]): CapabilityManifest {
  const ops = visibleOps(role, registry);
  return {
    protocolVersion: PROTOCOL_VERSION,
    capabilityHash: computeCapabilityHash(ops),
    count: ops.length,
    tools: ops.map((op) => ({
      name: op.name,
      title: op.title,
      permission: op.permission,
      roles: op.roles,
      requiresConfirmation: op.requiresConfirmation ?? false,
      credits: creditCost(op),
    })),
  };
}
