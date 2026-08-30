"use client";

import { useState } from "react";
import { useBridge } from "@/app/providers";

const REASON_CODES = ["COMP", "DISCOUNT", "ERROR_CORRECTION", "PROMOTION", "SPOILAGE", "OTHER"] as const;

export function AdjustmentsCard() {
  const { call } = useBridge();

  const [reservationId, setReservationId] = useState("");
  const [feeAmount, setFeeAmount] = useState(25);
  const [feeReason, setFeeReason] = useState("");
  const [feeLoading, setFeeLoading] = useState(false);
  const [feeResult, setFeeResult] = useState<string | null>(null);
  const [feeError, setFeeError] = useState<string | null>(null);

  const [amount, setAmount] = useState(0);
  const [reasonCode, setReasonCode] = useState<typeof REASON_CODES[number]>("OTHER");
  const [reason, setReason] = useState("");
  const [adjLoading, setAdjLoading] = useState(false);
  const [adjResult, setAdjResult] = useState<string | null>(null);
  const [adjError, setAdjError] = useState<string | null>(null);

  async function handleNoShowFee(e: React.FormEvent) {
    e.preventDefault();
    if (!reservationId.trim() || feeReason.trim().length < 5) return;
    setFeeLoading(true);
    setFeeError(null);
    setFeeResult(null);
    try {
      // applyNoShowFee carries requiresConfirmation:true — the ConfirmationDialog
      // in providers.tsx intercepts this call before it reaches the server.
      const res = await call("applyNoShowFee", {
        reservationId: reservationId.trim(),
        feeAmount,
        reason: feeReason.trim(),
      }) as { success: boolean; data?: { adjustmentId: string }; error?: { message: string } };
      if (!res.success) setFeeError(res.error?.message ?? "Failed to apply no-show fee");
      else { setFeeResult(`Applied — ${res.data?.adjustmentId}`); setReservationId(""); setFeeReason(""); }
    } finally {
      setFeeLoading(false);
    }
  }

  async function handleManualAdjustment(e: React.FormEvent) {
    e.preventDefault();
    if (amount === 0 || reason.trim().length < 5) return;
    setAdjLoading(true);
    setAdjError(null);
    setAdjResult(null);
    try {
      const res = await call("logManualAdjustment", {
        amount,
        reason: reason.trim(),
        reasonCode,
      }) as { success: boolean; data?: { adjustmentId: string }; error?: { message: string } };
      if (!res.success) setAdjError(res.error?.message ?? "Failed to log adjustment");
      else { setAdjResult(`Logged — ${res.data?.adjustmentId}`); setAmount(0); setReason(""); }
    } finally {
      setAdjLoading(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Adjustments
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>applyNoShowFee / logManualAdjustment</span>
      </h2>

      <form onSubmit={handleNoShowFee} style={{ display: "flex", flexDirection: "column", gap: 10, marginBottom: 20 }}>
        <p style={{ fontSize: 12, color: "#6b7280" }}>No-show fee</p>
        <div className="field-grid">
          <input placeholder="Reservation ID" value={reservationId} onChange={(e) => setReservationId(e.target.value)} />
          <input type="number" value={feeAmount} onChange={(e) => setFeeAmount(Number(e.target.value))} min={1} />
        </div>
        <input placeholder="Reason (min 5 chars)" value={feeReason} onChange={(e) => setFeeReason(e.target.value)} />
        {feeError && <p style={{ color: "#ef4444", fontSize: 13 }}>{feeError}</p>}
        {feeResult && <p style={{ color: "#166534", fontSize: 13 }}>{feeResult}</p>}
        <button type="submit" disabled={feeLoading} style={{ background: "#991b1b", color: "#fff" }}>
          {feeLoading ? "Applying…" : "Apply No-Show Fee"}
        </button>
      </form>

      <form onSubmit={handleManualAdjustment} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <p style={{ fontSize: 12, color: "#6b7280" }}>Manual adjustment</p>
        <div className="field-grid">
          <input type="number" placeholder="Amount (± )" value={amount} onChange={(e) => setAmount(Number(e.target.value))} />
          <select value={reasonCode} onChange={(e) => setReasonCode(e.target.value as typeof reasonCode)}>
            {REASON_CODES.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <input placeholder="Reason (min 5 chars)" value={reason} onChange={(e) => setReason(e.target.value)} />
        {adjError && <p style={{ color: "#ef4444", fontSize: 13 }}>{adjError}</p>}
        {adjResult && <p style={{ color: "#166534", fontSize: 13 }}>{adjResult}</p>}
        <button type="submit" disabled={adjLoading} style={{ background: "#4f46e5", color: "#fff" }}>
          {adjLoading ? "Logging…" : "Log Adjustment"}
        </button>
      </form>
    </div>
  );
}
