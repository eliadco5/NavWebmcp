"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

interface CapabilityTool {
  name: string;
  title: string;
  permission: "read" | "write";
  roles: string[];
  requiresConfirmation: boolean;
}

interface Manifest {
  protocolVersion: string;
  capabilityHash: string;
  count: number;
  tools: CapabilityTool[];
}

// Switching role and watching this list change (fewer rows as customer, more
// as admin) is the RBAC proof in one screen — no other panel shows the whole
// role-scoped tool set at once.
export function CapabilitiesCard() {
  const { call, user } = useBridge();
  const [manifest, setManifest] = useState<Manifest | null>(null);

  const refresh = useCallback(async () => {
    const res = await call("getCapabilities") as { success: boolean; data?: Manifest };
    if (res.success && res.data) setManifest(res.data);
  }, [call]);

  useEffect(() => { refresh(); }, [refresh, user?.role]);

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Capabilities
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>getCapabilities</span>
      </h2>
      {!manifest ? (
        <p style={{ color: "#9ca3af", fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>
            protocol {manifest.protocolVersion} · hash {manifest.capabilityHash} · {manifest.count} tools visible to <strong>{user?.role}</strong>
          </p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6, maxHeight: 360, overflowY: "auto" }}>
            {manifest.tools.map((t) => (
              <div key={t.name} className="row">
                <span style={{ fontSize: 13 }}>{t.name}</span>
                <div style={{ display: "flex", gap: 6 }}>
                  <span className={`badge ${t.permission === "write" ? "badge-write" : "badge-read"}`}>{t.permission}</span>
                  {t.requiresConfirmation && <span className="badge badge-err">confirm</span>}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
