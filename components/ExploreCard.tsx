"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

interface ModuleNode { path: string; title: string; description: string }
interface FnSummary { name: string; title: string; description: string; permission: "read" | "write"; requiresConfirmation?: boolean }
interface ExploreNode { path: string; title: string; description: string; submodules: ModuleNode[]; functions: FnSummary[] }
interface PlatformManifest { app: string; description: string; modules: ModuleNode[] }

// Makes progressive tool disclosure visible to a human: this is the same
// explore() call an agent makes to navigate the module tree without ever
// loading the full 56-operation schema set up front.
export function ExploreCard() {
  const { call } = useBridge();
  const [path, setPath] = useState<string | null>(null);
  const [root, setRoot] = useState<PlatformManifest | null>(null);
  const [node, setNode] = useState<ExploreNode | null>(null);
  const [schema, setSchema] = useState<{ name: string; inputSchema: unknown } | null>(null);

  const load = useCallback(async (p: string | null) => {
    const res = await call("explore", p ? { path: p } : {}) as { success: boolean; data?: PlatformManifest | ExploreNode };
    if (!res.success || !res.data) return;
    if (p === null) setRoot(res.data as PlatformManifest);
    else setNode(res.data as ExploreNode);
  }, [call]);

  useEffect(() => { load(null); }, [load]);
  useEffect(() => { if (path !== null) load(path); }, [path, load]);

  async function describeFn(name: string) {
    const res = await call("describe_tool", { name }) as { success: boolean; data?: { name: string; inputSchema: unknown } };
    if (res.success && res.data) setSchema(res.data);
  }

  const crumbs = path ? path.split(".") : [];

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Explore
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>explore / describe_tool</span>
      </h2>

      <div style={{ display: "flex", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        <button type="button" onClick={() => { setPath(null); setSchema(null); }} style={{ fontSize: 12, background: "#f3f4f6", color: "#374151" }}>
          root
        </button>
        {crumbs.map((_, i) => {
          const sub = crumbs.slice(0, i + 1).join(".");
          return (
            <button key={sub} type="button" onClick={() => { setPath(sub); setSchema(null); }} style={{ fontSize: 12, background: "#f3f4f6", color: "#374151" }}>
              {crumbs[i]}
            </button>
          );
        })}
      </div>

      {path === null ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {root?.modules.map((m) => (
            <button
              key={m.path}
              type="button"
              onClick={() => setPath(m.path)}
              className="row"
              style={{ textAlign: "left", cursor: "pointer" }}
            >
              <span style={{ fontSize: 13 }}><strong>{m.title}</strong></span>
              <span style={{ fontSize: 11, color: "#6b7280" }}>{m.path}</span>
            </button>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          {node?.submodules.map((m) => (
            <button key={m.path} type="button" onClick={() => setPath(m.path)} className="row" style={{ textAlign: "left", cursor: "pointer" }}>
              <span style={{ fontSize: 13 }}>{m.title}</span>
              <span style={{ fontSize: 11, color: "#6b7280" }}>{m.path}</span>
            </button>
          ))}
          {node?.functions.map((f) => (
            <button key={f.name} type="button" onClick={() => describeFn(f.name)} className="row" style={{ textAlign: "left", cursor: "pointer" }}>
              <span style={{ fontSize: 13 }}>{f.name}</span>
              <span className={`badge ${f.permission === "write" ? "badge-write" : "badge-read"}`}>{f.permission}</span>
            </button>
          ))}
        </div>
      )}

      {schema && (
        <pre style={{ marginTop: 12, fontSize: 11, background: "#f3f4f6", borderRadius: 6, padding: 10, overflowX: "auto" }}>
          {JSON.stringify(schema, null, 2)}
        </pre>
      )}
    </div>
  );
}
