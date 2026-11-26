import { z } from "zod";
import { getModelContext } from "./webmcp-polyfill";
import type { ModelContextLike, ToolAnnotations } from "./webmcp-polyfill";
import { inputObject, envelopeSchema, outputObject, toJsonSchema } from "./schema";
import { auditLog } from "./auditlog";
import { fail, invalidInput, type ActionPreview, type ConfirmationInfo } from "./result";
import type { OperationContext } from "./operations/types";
import type { Role } from "./auth";
import { roleSatisfies } from "./auth";
import { PROTOCOL_NAME, PROTOCOL_VERSION } from "./protocol";

export interface AgentBridgeRegistration {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodRawShape;
  /** Shape of the success `data`; published wrapped in the Result envelope. */
  outputSchema?: z.ZodRawShape;
  permission: "read" | "write";
  roles: Role[];
  requiresConfirmation?: boolean;
  untrustedOutput?: boolean;
  dispatchesOps?: boolean;
  /** See Operation.openOutput. */
  openOutput?: boolean;
  tags?: string[];
  /** `signal` aborts when the WebMCP caller cancels the execution. */
  handler: (input: Record<string, unknown>, ctx: OperationContext, options?: { signal?: AbortSignal }) => Promise<unknown>;
}

export function webmcpAnnotations(
  reg: Pick<AgentBridgeRegistration, "permission" | "requiresConfirmation" | "untrustedOutput" | "dispatchesOps">
): ToolAnnotations {
  return {
    readOnlyHint: reg.permission === "read" && !reg.dispatchesOps,
    consequentialHint: reg.requiresConfirmation === true || reg.dispatchesOps === true,
    // invoke relays whatever the called op returns, which may be user-written text.
    untrustedContentHint: reg.untrustedOutput === true || reg.dispatchesOps === true,
  };
}

export type ConfirmationHandler = (
  operationName: string,
  input: Record<string, unknown>,
  /** What the server says the action would do (NavWebMcp ≥ 2.6.0). */
  preview?: ActionPreview
) => Promise<boolean>;

/** The approval a result asks for: CONFIRMATION_REQUIRED (or STALE) with a token. */
function confirmationAsked(result: unknown): ConfirmationInfo | undefined {
  const r = result as { success?: boolean; error?: { code?: string; confirmation?: ConfirmationInfo } } | null;
  if (!r || r.success !== false) return undefined;
  const code = r.error?.code;
  if (code !== "CONFIRMATION_REQUIRED" && code !== "CONFIRMATION_STALE") return undefined;
  return r.error?.confirmation?.token ? r.error.confirmation : undefined;
}

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

    // execute() resolves to the full Result envelope, so that is what the
    // published outputSchema describes.
    const registered = this.mc.registerTool({
      name: reg.name,
      title: reg.title,
      description: reg.description,
      inputSchema: toJsonSchema(inputObject(reg.inputSchema)),
      ...(reg.outputSchema && { outputSchema: toJsonSchema(envelopeSchema(reg.outputSchema, reg.openOutput)) }),
      annotations: webmcpAnnotations(reg),
      execute: async (input: Record<string, unknown>, options?: { signal?: AbortSignal }) => {
        return this.call(reg.name, input, { signal: options?.signal });
      },
    });
    // A native implementation can reject (e.g. a schema it refuses to serialize);
    // surface that instead of leaving an unhandled rejection.
    Promise.resolve(registered).catch((err: unknown) => {
      console.warn(`[AgentBridge] registerTool('${reg.name}') was rejected:`, err);
    });
  }

  async call(
    name: string,
    input: Record<string, unknown> = {},
    options: { signal?: AbortSignal } = {}
  ): Promise<unknown> {
    const { signal } = options;
    const reg = this.registrations.find((r) => r.name === name);
    if (!reg) throw new Error(`Operation "${name}" not registered`);

    const userId = this.getUserId();
    const role = this.getUserRole();
    if (!userId || !role) {
      return fail("UNAUTHENTICATED", "A valid user token is required.");
    }

    if (!roleSatisfies(role, reg.roles)) {
      return fail("FORBIDDEN", `Role '${role}' is not permitted to call '${name}'.`);
    }

    const parsed = inputObject(reg.inputSchema).safeParse(input);
    if (!parsed.success) {
      return invalidInput(parsed.error.issues);
    }
    const ctx: OperationContext = { userId, role, token: "" };
    const args = parsed.data as Record<string, unknown>;

    // Confirmation (NavWebMcp 2.6.0): the server decides, and says what the
    // action would do. A call it won't run yet answers CONFIRMATION_REQUIRED
    // with a preview and a token; the dialog shows the preview, and an approval
    // re-sends the call with that token, which approves exactly these arguments.
    //
    // An agent that self-declares confirm: true is trusted as before, unless the
    // server requires tokens (REQUIRE_CONFIRMATION_TOKEN); then its call comes
    // back CONFIRMATION_REQUIRED and the user is asked here. A genuinely
    // autonomous in-page agent never hangs on a dialog nobody asked for.
    let result = await this.dispatch(reg, args, ctx, signal);
    const asked = reg.requiresConfirmation ? confirmationAsked(result) : undefined;
    if (asked) {
      const approved = await this.confirmationHandler(name, input, asked.preview);
      if (!approved) {
        const denial = fail("CONFIRMATION_DENIED", "User denied the action.");
        auditLog.record(name, input, false, "ui", denial.error);
        return denial;
      }
      // The caller may have cancelled while the dialog was open; a cancelled
      // execution must not reach the server afterwards.
      if (signal?.aborted) return fail("CANCELLED", "The caller cancelled this call.");
      const withToken: Record<string, unknown> = { ...args, confirmationToken: asked.token };
      delete withToken.confirm;
      result = await this.dispatch(reg, withToken, ctx, signal);
    }
    const success = (result as { success?: boolean }).success !== false;
    const output = success ? (result as { data?: unknown }).data : (result as { error?: unknown }).error;
    auditLog.record(name, input, success, "ui", output);
    return result;
  }

  private dispatch(reg: AgentBridgeRegistration, args: Record<string, unknown>, ctx: OperationContext, signal?: AbortSignal) {
    if (signal?.aborted) return Promise.resolve(fail("CANCELLED", "The caller cancelled this call."));
    return reg.handler(args, ctx, { signal });
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
        inputSchema: toJsonSchema(inputObject(r.inputSchema)),
        ...(r.outputSchema && { outputSchema: toJsonSchema(outputObject(r.outputSchema, r.openOutput)) }),
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
