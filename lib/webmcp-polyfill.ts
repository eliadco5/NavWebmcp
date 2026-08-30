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
  /** AgentBridge extension — not part of the WebMCP spec. Behavioral instructions for in-page agents. */
  instructions: string | null = null;
  /** AgentBridge extension — not part of the WebMCP spec. Semver of the NavWebMcp protocol contract. */
  protocolVersion: string | null = null;

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

/**
 * The shape callers should actually assume `document.modelContext` has. Only
 * `registerTool` is guaranteed by the draft spec; `getTools`/`executeTool` are
 * polyfill-only conveniences that don't exist on a native implementation, and
 * `instructions`/`protocolVersion` are AgentBridge extensions a native object
 * may reject outright. Declaring the global as `ModelContextImpl` (i.e. every
 * method required) was a lie for the native case — it's why calling
 * `mc.getTools()` used to compile fine and then throw a TypeError at runtime
 * the moment a real WebMCP implementation showed up. Making them optional here
 * turns that into a build-time reminder to feature-detect at every call site.
 */
export interface ModelContextLike extends EventTarget {
  registerTool(tool: ModelContextTool, options?: ModelContextRegisterToolOptions): Promise<void> | void;
  ontoolchange?: ((event: ToolChangeEvent) => void) | null;
  /** AgentBridge extension — not part of the WebMCP spec. */
  instructions?: string | null;
  /** AgentBridge extension — not part of the WebMCP spec. */
  protocolVersion?: string | null;
  /** Polyfill-only — not part of the WebMCP spec. */
  getTools?(): ModelContextTool[];
  /** Polyfill-only — not part of the WebMCP spec. */
  executeTool?(name: string, input: Record<string, unknown>): Promise<unknown>;
}

declare global {
  interface Document {
    modelContext?: ModelContextLike;
  }
  interface Navigator {
    // The draft has moved the attachment point between `document` and
    // `navigator` at different points in its history; detect both.
    modelContext?: ModelContextLike;
  }
}

export function installWebMCPPolyfill(): void {
  if (typeof document === "undefined") return;
  if ("modelContext" in document) return; // native or already polyfilled
  // A native implementation exposed at navigator.modelContext must never be
  // shadowed by installing the polyfill onto document — that would render fine
  // but leave the real agent-facing surface (navigator) with zero tools, which
  // is a silent failure, not a crash: harder to notice, easier to ship.
  if (typeof navigator !== "undefined" && "modelContext" in navigator) return;

  Object.defineProperty(document, "modelContext", {
    value: new ModelContextImpl(),
    writable: false,
    configurable: false,
    enumerable: true,
  });
}

/** Resolve the live ModelContext, installing the polyfill only as a last resort. */
export function getModelContext(): ModelContextLike {
  if (typeof navigator !== "undefined" && navigator.modelContext) return navigator.modelContext;
  if (typeof document !== "undefined" && document.modelContext) return document.modelContext;
  installWebMCPPolyfill();
  return document.modelContext!;
}
