import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { getModelContext } from "./webmcp-polyfill";
import type { ModelContextLike } from "./webmcp-polyfill";
import { auditLog } from "./auditlog";
import type { OperationContext } from "./operations/types";
import type { Role } from "./auth";
import { roleSatisfies } from "./auth";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "./protocol";

export interface AgentBridgeRegistration {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodRawShape;
  permission: "read" | "write";
  roles: Role[];
  requiresConfirmation?: boolean;
  tags?: string[];
  handler: (input: Record<string, unknown>, ctx: OperationContext) => Promise<unknown>;
}

export type ConfirmationHandler = (
  operationName: string,
  input: Record<string, unknown>
) => Promise<boolean>;

export interface AgentBridgeOptions {
  onConfirmation?: ConfirmationHandler;
  getUserId?: () => string | null;
  getUserRole?: () => Role | null;
  /** Behavioral instructions exposed on document.modelContext.instructions for in-page agents. */
  instructions?: string;
}

export class AgentBridge {
  private registrations: AgentBridgeRegistration[] = [];
  private confirmationHandler: ConfirmationHandler;
  private getUserId: () => string | null;
  private getUserRole: () => Role | null;
  private mc: ModelContextLike;

  constructor(options: AgentBridgeOptions = {}) {
    // getModelContext() prefers a native implementation over the polyfill and
    // only installs the polyfill as a fallback — see lib/webmcp-polyfill.ts.
    this.mc = getModelContext();
    this.confirmationHandler =
      options.onConfirmation ?? (() => Promise.resolve(true));
    this.getUserId = options.getUserId ?? (() => null);
    this.getUserRole = options.getUserRole ?? (() => null);
    try {
      if (options.instructions !== undefined) {
        this.mc.instructions = options.instructions;
      }
      this.mc.protocolVersion = PROTOCOL_VERSION;
    } catch {
      // instructions/protocolVersion are AgentBridge extensions, not spec —
      // a native implementation is allowed to reject them.
    }
  }

  register(reg: AgentBridgeRegistration): void {
    // Idempotent by name — callers (e.g. initAgentBridge) may re-loop the full
    // registry on every role change to pick up newly-visible ops, so a name
    // already registered here must no-op rather than register twice. The
    // polyfill's own registerTool silently overwrites on a duplicate name, but
    // a native implementation's behavior there is unspecified — dedupe here
    // instead of leaning on that.
    if (this.registrations.some((r) => r.name === reg.name)) return;

    const role = this.getUserRole();
    // Skip registration if the caller's role is not permitted
    if (role && !roleSatisfies(role, reg.roles)) return;

    this.registrations.push(reg);

    const jsonSchema = zodToJsonSchema(z.object(reg.inputSchema), {
      $refStrategy: "none",
    });

    void this.mc.registerTool({
      name: reg.name,
      title: reg.title,
      description: reg.description,
      inputSchema: jsonSchema as Record<string, unknown>,
      execute: async (input: Record<string, unknown>) => {
        return this.call(reg.name, input);
      },
    });
  }

  async call(
    name: string,
    input: Record<string, unknown> = {}
  ): Promise<unknown> {
    const reg = this.registrations.find((r) => r.name === name);
    if (!reg) throw new Error(`Operation "${name}" not registered`);

    const userId = this.getUserId();
    const role = this.getUserRole();
    if (!userId || !role) {
      return {
        success: false,
        error: { code: "UNAUTHENTICATED", message: "A valid user token is required." },
      };
    }

    if (!roleSatisfies(role, reg.roles)) {
      return {
        success: false,
        error: { code: "FORBIDDEN", message: `Role '${role}' is not permitted to call '${name}'.` },
      };
    }

    // Confirmation before validation, not after: some confirmation-requiring ops
    // (cancelReservation, cancelAnyReservation) have a REQUIRED `confirm: boolean`
    // in their own schema — validating first meant a caller who hadn't already
    // included it got INVALID_INPUT before the dialog ever had a chance to show.
    //
    // A caller that HAS already self-declared approval (passed confirm: true for
    // an op whose own schema has that field) skips the dialog entirely and is
    // trusted immediately — this is exactly how the real MCP-over-HTTP surface
    // (lib/adapters/mcp.ts) already treats these same two ops for an external
    // agent: no interactive block, `confirm: true` IS the approval. A genuinely
    // autonomous in-page agent has no way to click a browser dialog, so requiring
    // one on top of an already-self-declared confirm would just hang forever with
    // no signal. The other 4 confirmation-requiring ops (checkOutGuest, deleteTask,
    // issueRefund, applyNoShowFee) have no schema field to self-declare through, so
    // they always show the dialog — it's the only approval channel they have.
    let confirmedInput = input;
    if (reg.requiresConfirmation) {
      const hasOwnConfirmField = "confirm" in reg.inputSchema;
      const selfDeclared = hasOwnConfirmField && input.confirm === true;
      if (!selfDeclared) {
        const approved = await this.confirmationHandler(name, input);
        if (!approved) {
          const denial = { code: "CONFIRMATION_DENIED", message: "User denied the action." };
          auditLog.record(name, input, false, "ui", denial);
          return { success: false, error: denial };
        }
        confirmedInput = { ...input, confirm: true };
      }
    }

    const schema = z.object(reg.inputSchema);
    const parsed = schema.safeParse(confirmedInput);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: "INVALID_INPUT",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        },
      };
    }

    const ctx: OperationContext = { userId, role, token: "" };
    const result = await reg.handler(parsed.data as Record<string, unknown>, ctx);
    const success = (result as { success?: boolean }).success !== false;
    const output = success ? (result as { data?: unknown }).data : (result as { error?: unknown }).error;
    auditLog.record(name, input, success, "ui", output);
    return result;
  }

  async executeBatch(
    calls: Array<{ operation: string; params?: Record<string, unknown> }>
  ): Promise<unknown[]> {
    return Promise.all(calls.map((c) => this.call(c.operation, c.params ?? {})));
  }

  describe(): object {
    return {
      bridge: "AgentBridge",
      protocol: PROTOCOL_NAME,
      protocolVersion: PROTOCOL_VERSION,
      operations: this.registrations.map((r) => ({
        name: r.name,
        title: r.title,
        description: r.description,
        permission: r.permission,
        roles: r.roles,
        tags: r.tags ?? [],
        requiresConfirmation: r.requiresConfirmation ?? false,
        inputSchema: zodToJsonSchema(z.object(r.inputSchema), {
          $refStrategy: "none",
        }),
      })),
    };
  }

  context(): object {
    return {
      page: "booking",
      authenticated: !!this.getUserId(),
      locale: "en-US",
    };
  }

  destroy(): void {
    this.registrations = [];
  }
}
