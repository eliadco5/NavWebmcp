"use client";

import { DEMO_USERS } from "@/lib/constants";

/** GET/DELETE an /api/admin route; returns `data` or throws with the server's message. */
export async function adminApi<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin/${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.success === false) throw new Error(body?.error?.message ?? `Request failed (${res.status})`);
  return body.data as T;
}

export const userName = (id: string) => DEMO_USERS.find((u) => u.id === id)?.name ?? id;

/** Series colors: reference categorical palette slots 1–3, validated on white
 *  (dataviz validate_palette.js; aqua is < 3:1, so charts using it carry a
 *  legend and a table view). Fixed per entity, never by rank. */
export const ACTOR_COLOR = { human: "#2a78d6", agent: "#eb6834", system: "#1baf7a" } as const;
export const ACTOR_LABEL = { human: "People", agent: "Agents", system: "System" } as const;
export type ActorKind = keyof typeof ACTOR_COLOR;

export const INK = { primary: "#0b0b0b", secondary: "#52514e", muted: "#898781", grid: "#e1e0d9", axis: "#c3c2b7" };

export function fmtTime(iso?: string) {
  return iso ? new Date(iso).toLocaleString() : "—";
}

export function ago(iso?: string) {
  if (!iso) return "never";
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function ActorChip({ type, name }: { type: ActorKind; name?: string }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12, color: INK.secondary, whiteSpace: "nowrap" }}>
      <span aria-hidden="true" style={{ width: 8, height: 8, borderRadius: 2, background: ACTOR_COLOR[type] }} />
      {type === "agent" ? `Agent${name ? ` · ${name}` : ""}` : type === "human" ? "Person" : "System"}
    </span>
  );
}

/** Status ships with an icon and a label, never color alone. */
export function Status({ kind, label }: { kind: "good" | "warning" | "critical"; label: string }) {
  const style = {
    good: { bg: "#dcfce7", fg: "#166534", icon: "✓" },
    warning: { bg: "#fef3c7", fg: "#92400e", icon: "!" },
    critical: { bg: "#fee2e2", fg: "#991b1b", icon: "✕" },
  }[kind];
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4, background: style.bg, color: style.fg, borderRadius: 99, padding: "2px 8px", fontSize: 12, fontWeight: 600 }}>
      <span aria-hidden="true">{style.icon}</span>{label}
    </span>
  );
}

export function SectionTitle({ children, hint }: { children: React.ReactNode; hint?: string }) {
  return (
    <div style={{ marginBottom: 12 }}>
      <h2 style={{ fontSize: 17, fontWeight: 600 }}>{children}</h2>
      {hint && <p style={{ fontSize: 13, color: INK.secondary, marginTop: 2 }}>{hint}</p>}
    </div>
  );
}

export const th: React.CSSProperties = { textAlign: "left", fontSize: 11, fontWeight: 600, color: INK.muted, padding: "6px 8px", borderBottom: `1px solid ${INK.grid}`, whiteSpace: "nowrap" };
export const td: React.CSSProperties = { fontSize: 13, padding: "7px 8px", borderBottom: `1px solid #f1f0ec`, verticalAlign: "top" };
