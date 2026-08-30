"use client";

import { useState, useEffect, useCallback } from "react";

type Role = "customer" | "support" | "admin";

interface UserRow {
  id: string;
  username: string;
  displayName: string;
  role: Role;
}

const ROLE_COLORS: Record<Role, { bg: string; text: string }> = {
  customer: { bg: "#e0f2fe", text: "#0369a1" },
  support:  { bg: "#ede9fe", text: "#5b21b6" },
  admin:    { bg: "#fef3c7", text: "#92400e" },
};

// Read-only roster. Role changes now happen via the switcher in the header
// (POST /api/switch-role, re-signs the caller's own cookie) rather than a PATCH
// here — that PATCH mutated a module-level USERS constant in place, which
// can't work once auth is stateless/HMAC-signed across serverless instances.
export function UsersPanel() {
  const [users, setUsers] = useState<UserRow[]>([]);

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/users");
    if (r.ok) {
      const data = await r.json();
      if (data.success) setUsers(data.users);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Demo Users
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>read-only · admin</span>
      </h2>
      <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 14 }}>
        Use the role switcher in the header to change your own role — these are the seeded demo accounts, not editable here.
      </p>
      <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        {users.map((u) => (
          <div key={u.id} style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "8px 12px", background: "#f9fafb", borderRadius: 6,
          }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div style={{
                width: 32, height: 32, borderRadius: "50%",
                background: ROLE_COLORS[u.role].bg,
                color: ROLE_COLORS[u.role].text,
                display: "flex", alignItems: "center", justifyContent: "center",
                fontWeight: 700, fontSize: 13,
              }}>
                {u.displayName[0]}
              </div>
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{u.displayName}</div>
                <div style={{ fontSize: 11, color: "#9ca3af" }}>@{u.username}</div>
              </div>
            </div>
            <span style={{
              fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 12,
              background: ROLE_COLORS[u.role].bg, color: ROLE_COLORS[u.role].text,
            }}>
              {u.role}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
