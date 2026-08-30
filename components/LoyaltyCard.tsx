"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

interface LoyaltyAccount {
  guestId: string;
  tier: "bronze" | "silver" | "gold" | "platinum";
  pointBalance: number;
  lifetimePoints: number;
  redemptionHistory: { date: string; pointsRedeemed: number; description: string }[];
}

const TIER_COLORS: Record<LoyaltyAccount["tier"], { bg: string; text: string }> = {
  bronze: { bg: "#fef3c7", text: "#92400e" },
  silver: { bg: "#e5e7eb", text: "#374151" },
  gold: { bg: "#fde68a", text: "#92400e" },
  platinum: { bg: "#ede9fe", text: "#5b21b6" },
};

export function LoyaltyCard({ guestId, canAward }: { guestId: string | null; canAward: boolean }) {
  const { call } = useBridge();
  const [loyalty, setLoyalty] = useState<LoyaltyAccount | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [points, setPoints] = useState(100);
  const [reason, setReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [upgradeNote, setUpgradeNote] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!guestId) { setLoyalty(null); return; }
    setNotFound(false);
    const res = await call("getLoyaltyStatus", { guestId }) as { success: boolean; data?: { loyalty: LoyaltyAccount } };
    if (res.success && res.data) setLoyalty(res.data.loyalty);
    else { setLoyalty(null); setNotFound(true); }
  }, [call, guestId]);

  useEffect(() => { refresh(); }, [refresh]);

  async function handleAward(e: React.FormEvent) {
    e.preventDefault();
    if (!guestId || !reason.trim()) return;
    setLoading(true);
    setError(null);
    setUpgradeNote(null);
    try {
      const res = await call("addLoyaltyPoints", { guestId, points, reason: reason.trim() }) as {
        success: boolean;
        data?: { tierUpgrade: boolean; currentTier: string };
        error?: { message: string };
      };
      if (!res.success) setError(res.error?.message ?? "Failed to award points");
      else {
        setReason("");
        if (res.data?.tierUpgrade) setUpgradeNote(`Tier upgraded to ${res.data.currentTier}!`);
        await refresh();
      }
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Loyalty
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>getLoyaltyStatus / addLoyaltyPoints</span>
      </h2>
      {!guestId ? (
        <p style={{ color: "#9ca3af", fontSize: 13 }}>Pick a guest to view loyalty status.</p>
      ) : notFound ? (
        <p style={{ color: "#9ca3af", fontSize: 13 }}>No loyalty account for this guest.</p>
      ) : !loyalty ? (
        <p style={{ color: "#9ca3af", fontSize: 13 }}>Loading…</p>
      ) : (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <span
              className="badge"
              style={{ background: TIER_COLORS[loyalty.tier].bg, color: TIER_COLORS[loyalty.tier].text }}
            >
              {loyalty.tier}
            </span>
            <span style={{ fontSize: 13 }}>{loyalty.pointBalance} pts · {loyalty.lifetimePoints} lifetime</span>
          </div>
          {loyalty.redemptionHistory.length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginBottom: 12 }}>
              {loyalty.redemptionHistory.map((r, i) => (
                <div key={i} className="row">
                  <span style={{ fontSize: 12 }}>{r.description}</span>
                  <span style={{ fontSize: 12, color: "#6b7280" }}>-{r.pointsRedeemed} pts · {r.date}</span>
                </div>
              ))}
            </div>
          )}
          {canAward && (
            <form onSubmit={handleAward} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
              <div className="field-grid">
                <input type="number" value={points} onChange={(e) => setPoints(Number(e.target.value))} min={1} />
                <input placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} />
              </div>
              {error && <p style={{ color: "#ef4444", fontSize: 13 }}>{error}</p>}
              {upgradeNote && <p style={{ color: "#166534", fontSize: 13 }}>{upgradeNote}</p>}
              <button type="submit" disabled={loading} style={{ background: "#4f46e5", color: "#fff" }}>
                {loading ? "Awarding…" : "Award Points"}
              </button>
            </form>
          )}
        </>
      )}
    </div>
  );
}
