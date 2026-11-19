import { defineOperation } from "./types";
import { ok } from "@/lib/result";
import { registry } from "./registry";
import { capabilityManifest } from "@/lib/capabilities";
import { z } from "zod";
import { CapabilityToolSchema } from "./schemas";

export const getCapabilities = defineOperation({
  name: "getCapabilities",
  title: "Get Capabilities",
  description:
    "Return the list of tools available to the caller's role, along with protocolVersion " +
    "(semver of the protocol contract, same for every role) and capabilityHash (8-hex " +
    "content hash of THIS role's tool set). Cache the manifest keyed on both; re-fetch " +
    "when either changes.",
  permission: "read",
  roles: ["customer", "support", "admin"],
  alwaysOn: true,
  tags: ["meta"],
  inputSchema: {},
  outputSchema: {
    protocolVersion: z.string().describe("Semver of the NavWebMcp protocol contract"),
    capabilityHash: z.string().describe("8-hex content hash of this role's tool set"),
    count: z.number().int(),
    tools: z.array(CapabilityToolSchema),
  },
  async handler(_input, ctx) {
    return ok(capabilityManifest(ctx.role, registry));
  },
});
