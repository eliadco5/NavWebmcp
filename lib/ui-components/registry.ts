import type { z } from "zod";
import { ok, fail, type Result } from "@/lib/result";
import { toJsonSchema } from "@/lib/schema";
import {
  UI_ERROR,
  type UiKind,
  type UiCommand,
  type UiComponentContract,
  type UiSetStateResult,
  type UiActionResult,
} from "./contract";

// The in-page side of the UI-component extension. Components register a typed
// state contract here while mounted (lib/ui-components/useAgentComponent.ts).
// applyCommand() is the ONE place an agent's change is validated and applied,
// whether it came from an in-page agent (lib/ui-components/local.ts) or from an
// external MCP client through the server relay (lib/ui-relay/client.ts).

type State = Record<string, unknown>;

export interface UiActionDef {
  description: string;
  /** `set` applies a new full state the same way an agent patch does (validated
   *  by the caller). ui_action returns the state as it stands once run() settles. */
  run: (args: Record<string, unknown>, set: (next: Record<string, unknown>) => void) => unknown | Promise<unknown>;
}

export interface UiComponentRegistration {
  id: string;
  kind: UiKind;
  title: string;
  description?: string;
  schema: z.ZodType<State>;
  getState: () => State;
  setState: (next: State) => void;
  actions?: Record<string, UiActionDef>;
  getView?: () => { total?: number; shown?: number } | undefined;
}

interface Entry {
  reg: UiComponentRegistration;
  stateSchema: Record<string, unknown>;
  version: number;
  lastJson: string;
}

const isPlainObject = (v: unknown): v is State =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Merge `patch` into `base`: plain objects merge recursively, everything else
 * (arrays included) replaces, and `null` removes the key — which is how an agent
 * clears an optional filter.
 */
export function mergePatch(base: State, patch: State): State {
  const out: State = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete out[key];
    else if (isPlainObject(value) && isPlainObject(out[key])) out[key] = mergePatch(out[key] as State, value);
    else out[key] = value;
  }
  return out;
}

export class UiComponentRegistry {
  private entries = new Map<string, Entry>();
  private listeners = new Set<() => void>();

  /** Returns the unregister function. Re-registering an id replaces the entry
   *  (React StrictMode mounts twice); a stale unregister never removes its successor. */
  register(reg: UiComponentRegistration): () => void {
    const entry: Entry = {
      reg,
      stateSchema: toJsonSchema(reg.schema),
      version: 1,
      lastJson: JSON.stringify(reg.getState()),
    };
    this.entries.set(reg.id, entry);
    this.emit();
    return () => {
      if (this.entries.get(reg.id) === entry) {
        this.entries.delete(reg.id);
        this.emit();
      }
    };
  }

  /** Call after the component's state (or view) may have changed. Bumps the
   *  version only when the state really differs from the last one recorded. */
  touch(id: string): void {
    const entry = this.entries.get(id);
    if (!entry) return;
    const json = JSON.stringify(entry.reg.getState());
    if (json !== entry.lastJson) {
      entry.lastJson = json;
      entry.version++;
    }
    this.emit();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  list(kind?: UiKind): UiComponentContract[] {
    return [...this.entries.values()]
      .filter((e) => !kind || e.reg.kind === kind)
      .map((e) => this.contract(e));
  }

  get(id: string): UiComponentContract | undefined {
    const entry = this.entries.get(id);
    return entry && this.contract(entry);
  }

  /** The active domain tab, read from the first mounted `tabs` component. */
  activeTab(): string | null {
    const tabs = [...this.entries.values()].find((e) => e.reg.kind === "tabs");
    const value = tabs?.reg.getState().activeTab;
    return typeof value === "string" ? value : null;
  }

  async applyCommand(cmd: UiCommand): Promise<Result<UiSetStateResult | UiActionResult>> {
    const entry = this.entries.get(cmd.componentId);
    if (!entry) {
      const ids = [...this.entries.keys()].join(", ") || "none";
      return fail(UI_ERROR.NOT_FOUND, `No mounted component '${cmd.componentId}'. Mounted: ${ids}. It may be on another tab: switch tabs via app.nav first.`);
    }
    return cmd.type === "set_state"
      ? this.setState(entry, cmd.patch, cmd.expectedVersion)
      : this.runAction(entry, cmd.action, cmd.args ?? {});
  }

  private setState(entry: Entry, patch: State, expectedVersion?: number): Result<UiSetStateResult> {
    if (expectedVersion !== undefined && expectedVersion !== entry.version) {
      return fail(UI_ERROR.STALE, `'${entry.reg.id}' is at version ${entry.version}, not ${expectedVersion}: the user changed it. Re-read with ui_get_state.`);
    }
    const merged = mergePatch(entry.reg.getState(), patch);
    const parsed = entry.reg.schema.safeParse(merged);
    if (!parsed.success) {
      const issues = parsed.error.issues
        .map((i) => (i.path.length ? `${i.path.join(".")}: ${i.message}` : i.message))
        .join("; ");
      return fail(UI_ERROR.INVALID_PATCH, `Patch does not fit '${entry.reg.id}' (see its stateSchema): ${issues}`);
    }
    entry.reg.setState(parsed.data);
    const json = JSON.stringify(parsed.data);
    if (json !== entry.lastJson) {
      entry.lastJson = json;
      entry.version++;
    }
    this.emit();
    return ok({ componentId: entry.reg.id, state: parsed.data, version: entry.version });
  }

  private async runAction(entry: Entry, action: string, args: State): Promise<Result<UiActionResult>> {
    const def = entry.reg.actions?.[action];
    if (!def) {
      const names = Object.keys(entry.reg.actions ?? {}).join(", ") || "none";
      return fail(UI_ERROR.UNKNOWN_ACTION, `'${entry.reg.id}' has no action '${action}'. Available: ${names}.`);
    }
    await def.run(args, (next) => entry.reg.setState(next));
    // getState() already reflects a change the action made through the hook's
    // setter (useAgentComponent updates its ref eagerly, before React re-renders).
    const state = entry.reg.getState();
    const json = JSON.stringify(state);
    if (json !== entry.lastJson) {
      entry.lastJson = json;
      entry.version++;
    }
    this.emit();
    return ok({ componentId: entry.reg.id, action, state, version: entry.version });
  }

  private contract(entry: Entry): UiComponentContract {
    const view = entry.reg.getView?.();
    return {
      id: entry.reg.id,
      kind: entry.reg.kind,
      title: entry.reg.title,
      ...(entry.reg.description && { description: entry.reg.description }),
      stateSchema: entry.stateSchema,
      state: entry.reg.getState(),
      version: entry.version,
      actions: Object.entries(entry.reg.actions ?? {}).map(([name, a]) => ({ name, description: a.description })),
      ...(view && { view }),
    };
  }

  private emit(): void {
    for (const l of this.listeners) l();
  }
}

declare global {
  // eslint-disable-next-line no-var
  var __uiComponentRegistry: UiComponentRegistry | undefined;
}

/** Page-lifetime singleton. */
export function getUiRegistry(): UiComponentRegistry {
  return (globalThis.__uiComponentRegistry ??= new UiComponentRegistry());
}
