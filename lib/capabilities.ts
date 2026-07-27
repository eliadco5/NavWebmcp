import type { Operation } from "@/lib/operations/types";
import type { Role } from "@/lib/auth";
import { roleSatisfies } from "@/lib/auth";
import { PROTOCOL_VERSION } from "@/lib/protocol";

/** DJB2 hash over a string → 8-char hex. Stable across calls for the same input. */
function djb2(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h) ^ s.charCodeAt(i);
    h >>>= 0; // keep 32-bit unsigned
  }
  return h.toString(16).padStart(8, "0");
}

/** Stable canonical string for an operation (name + permission + sorted roles + sorted inputSchema keys). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function opFingerprint(op: Operation<any, any>): string {
  const schemaKeys = Object.keys(op.inputSchema).sort().join(",");
  const roles = [...op.roles].sort().join(",");
  return `${op.name}|${op.permission}|${roles}|${schemaKeys}|${op.module ?? ""}|${op.parallelSafe ?? ""}`;
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
  permission: string;
  roles: Role[];
  requiresConfirmation: boolean;
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
    })),
  };
}
