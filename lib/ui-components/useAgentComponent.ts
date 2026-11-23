"use client";

import { useEffect, useRef } from "react";
import type { z } from "zod";
import { getUiRegistry, type UiActionDef } from "./registry";
import type { UiKind } from "./contract";

export interface AgentComponentOptions<S extends Record<string, unknown>> {
  /** Stable, page-unique id, e.g. "tasks.table". Agents address the component by it. */
  id: string;
  kind: UiKind;
  title: string;
  description?: string;
  /** Validates the FULL state after an agent's patch is merged in. */
  schema: z.ZodType<S>;
  state: S;
  setState: (next: S) => void;
  /** When given, a `reset` action is added that restores it. */
  initialState?: S;
  actions?: Record<string, UiActionDef>;
  /** What the user currently sees, e.g. { total: 12, shown: 12 }. */
  view?: { total?: number; shown?: number };
}

/**
 * Make a component agent-operable: while mounted it publishes its state contract
 * to the page's UiComponentRegistry, and ui_set_state / ui_action calls (from an
 * in-page agent or relayed from an external MCP client) change it through
 * `setState` — exactly as if the user had used the controls. The component keeps
 * owning its state; agents never touch the DOM.
 */
export function useAgentComponent<S extends Record<string, unknown>>(opts: AgentComponentOptions<S>): void {
  const stateRef = useRef(opts.state);
  stateRef.current = opts.state;
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const registry = getUiRegistry();
    // Update the ref eagerly so the registry reports the new state before React
    // re-renders (a ui_set_state result, or the state after an action).
    const set = (next: Record<string, unknown>) => {
      stateRef.current = next as S;
      optsRef.current.setState(next as S);
    };
    const { initialState, actions = {} } = optsRef.current;
    const allActions: Record<string, UiActionDef> = { ...actions };
    if (initialState && !allActions.reset) {
      allActions.reset = {
        description: "Restore the default state (clears filters and sort)",
        run: (_args, setState) => setState(initialState),
      };
    }
    return registry.register({
      id: opts.id,
      kind: opts.kind,
      title: opts.title,
      description: opts.description,
      schema: opts.schema as unknown as z.ZodType<Record<string, unknown>>,
      getState: () => stateRef.current,
      setState: set,
      actions: allActions,
      getView: () => optsRef.current.view,
    });
    // Registration is per id + schema (keep the schema referentially stable:
    // module-level, or useMemo). State, setters and view are read through refs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.id, opts.schema]);

  const viewKey = `${opts.view?.total}:${opts.view?.shown}`;
  useEffect(() => {
    getUiRegistry().touch(opts.id);
  }, [opts.id, opts.state, viewKey]);
}
