/**
 * WebMCP polyfill — installs `document.modelContext` if the browser does not
 * natively provide it. Mirrors the draft spec:
 *   https://webmachinelearning.github.io/webmcp/
 *
 * Spec IDL:
 *   partial interface Document { readonly attribute ModelContext modelContext; }
 *   interface ModelContext : EventTarget {
 *     Promise<undefined> registerTool(ModelContextTool, ModelContextRegisterToolOptions?);
 *     attribute EventHandler ontoolchange;
 *   }
 */

export interface ModelContextTool {
  name: string;
  title?: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  execute: (input: Record<string, unknown>) => Promise<unknown>;
  annotations?: Record<string, unknown>;
}

export interface ModelContextRegisterToolOptions {
  signal?: AbortSignal;
}

export interface ToolChangeEvent extends Event {
  tool: ModelContextTool;
  action: "registered" | "unregistered";
}

class ModelContextImpl extends EventTarget {
  private tools: Map<string, ModelContextTool> = new Map();
  ontoolchange: ((event: ToolChangeEvent) => void) | null = null;

  async registerTool(
    tool: ModelContextTool,
    options: ModelContextRegisterToolOptions = {}
  ): Promise<void> {
    if (!tool.name || !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name)) {
      throw new DOMException(
        `Tool name "${tool.name}" is invalid. Must match [A-Za-z0-9_.-], 1-128 chars.`,
        "DataError"
      );
    }

    this.tools.set(tool.name, tool);
    this.dispatchToolChange(tool, "registered");

    if (options.signal) {
      options.signal.addEventListener("abort", () => {
        this.tools.delete(tool.name);
        this.dispatchToolChange(tool, "unregistered");
      });
    }
  }

  getTools(): ModelContextTool[] {
    return Array.from(this.tools.values());
  }

  async executeTool(
    name: string,
    input: Record<string, unknown>
  ): Promise<unknown> {
    const tool = this.tools.get(name);
    if (!tool) throw new DOMException(`Tool "${name}" not found`, "NotFoundError");
    return tool.execute(input);
  }

  private dispatchToolChange(
    tool: ModelContextTool,
    action: "registered" | "unregistered"
  ) {
    const event = new Event("toolchange") as ToolChangeEvent;
    Object.defineProperty(event, "tool", { value: tool, enumerable: true });
    Object.defineProperty(event, "action", { value: action, enumerable: true });
    this.dispatchEvent(event);
    this.ontoolchange?.(event);
  }
}

declare global {
  interface Document {
    modelContext: ModelContextImpl;
  }
}

export function installWebMCPPolyfill(): void {
  if (typeof document === "undefined") return;
  if ("modelContext" in document) return; // native or already polyfilled

  Object.defineProperty(document, "modelContext", {
    value: new ModelContextImpl(),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}
