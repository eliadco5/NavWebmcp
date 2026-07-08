/**
 * AgentBridge SDK — developer-ergonomic wrapper over document.modelContext.
 * Adds: permission scopes, tags, output-schema, confirmation gates,
 *       domain event subscriptions, batch execution, and manifest generation.
 */
import { zodToJsonSchema } from "zod-to-json-schema";
import { z } from "zod";
import { installWebMCPPolyfill } from "./webmcp-polyfill";
import type { StoreEvent } from "./store";
import { auditLog } from "./auditlog";

export interface AgentBridgeRegistration {
  name: string;
  title?: string;
  description: string;
  inputSchema: z.ZodRawShape;
  permission: "read" | "write";
  requiresConfirmation?: boolean;
  tags?: string[];
  handler: (input: Record<string, unknown>) => Promise<unknown>;
}

export type ConfirmationHandler = (
  operationName: string,
  input: Record<string, unknown>
) => Promise<boolean>;

export interface AgentBridgeOptions {
  onConfirmation?: ConfirmationHandler;
}

export class AgentBridge {
  private registrations: AgentBridgeRegistration[] = [];
  private storeListeners: Array<() => void> = [];
  private confirmationHandler: ConfirmationHandler;

  constructor(options: AgentBridgeOptions = {}) {
    installWebMCPPolyfill();
    this.confirmationHandler =
      options.onConfirmation ?? (() => Promise.resolve(true));
  }

  register(reg: AgentBridgeRegistration): void {
    this.registrations.push(reg);

    const jsonSchema = zodToJsonSchema(z.object(reg.inputSchema), {
      $refStrategy: "none",
    });

    document.modelContext.registerTool({
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

    // Input validation
    const schema = z.object(reg.inputSchema);
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      return {
        success: false,
        error: {
          code: "INVALID_INPUT",
          message: parsed.error.issues.map((i) => i.message).join("; "),
        },
      };
    }

    // Confirmation gate
    if (reg.requiresConfirmation) {
      const approved = await this.confirmationHandler(name, input);
      if (!approved) {
        auditLog.record(name, input, false, "ui");
        return {
          success: false,
          error: { code: "CONFIRMATION_DENIED", message: "User denied the action." },
        };
      }
    }

    const result = await reg.handler(parsed.data as Record<string, unknown>);
    const success = (result as { success?: boolean }).success !== false;
    auditLog.record(name, input, success, "ui");
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
      version: "1.0",
      operations: this.registrations.map((r) => ({
        name: r.name,
        title: r.title,
        description: r.description,
        permission: r.permission,
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
      authenticated: true,
      locale: "en-US",
    };
  }

  subscribe(
    eventType: StoreEvent["type"],
    callback: (event: StoreEvent) => void
  ): () => void {
    // Dynamically import the store to avoid importing it in SSR contexts
    let unsubscribe = () => {};
    import("./store").then(({ store }) => {
      unsubscribe = store.on((event) => {
        if (event.type === eventType) callback(event);
      });
    });
    const cleanup = () => unsubscribe();
    this.storeListeners.push(cleanup);
    return cleanup;
  }

  destroy(): void {
    for (const cleanup of this.storeListeners) cleanup();
    this.storeListeners = [];
  }
}
