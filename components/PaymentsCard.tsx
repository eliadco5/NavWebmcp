"use client";

import { useCallback, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";

type PaymentMethod = "cash" | "credit_card" | "debit_card" | "digital_wallet";

interface Payment {
  paymentId: string;
  date: string;
  amount: number;
  method: PaymentMethod;
  category: string;
  reservationId: string | null;
  guestId: string | null;
  covers: number;
  status: "completed" | "refunded" | "partial_refund";
  timestamp: string;
}

interface Adjustment {
  adjustmentId: string;
  type: string;
  amount: number;
  reason: string;
  timestamp: string;
}

const METHODS: PaymentMethod[] = ["cash", "credit_card", "debit_card", "digital_wallet"];

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

export function PaymentsCard() {
  const { call } = useBridge();
  const [date, setDate] = useState(todayISO());
  const [method, setMethod] = useState("");
  const [payments, setPayments] = useState<Payment[]>([]);
  const [summary, setSummary] = useState<{ count: number; total: number } | null>(null);

  const [detail, setDetail] = useState<{ payment: Payment; adjustments: Adjustment[] } | null>(null);
  const [refunding, setRefunding] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState("");
  const [refundReason, setRefundReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const search = useCallback(async () => {
    const params: Record<string, unknown> = { date };
    if (method) params.method = method;
    const res = await call("listPayments", params) as {
      success: boolean;
      data?: { payments: Payment[]; count: number; total: number };
    };
    if (res.success && res.data) {
      setPayments(res.data.payments);
      setSummary({ count: res.data.count, total: res.data.total });
    }
  }, [call, date, method]);

  // Load today's payments on mount — an admin landing on this tab should see
  // real numbers immediately, not an empty state waiting for a manual search.
  useEffect(() => { search(); }, [search]);

  async function viewDetail(paymentId: string) {
    setBusy(paymentId);
    try {
      const res = await call("getPaymentRecord", { paymentId }) as {
        success: boolean;
        data?: { payment: Payment; adjustments: Adjustment[] };
      };
      if (res.success && res.data) setDetail(res.data);
    } finally {
      setBusy(null);
    }
  }

  async function handleRefund(paymentId: string) {
    if (refundReason.trim().length < 5) { setError("Reason must be at least 5 characters."); return; }
    setBusy(paymentId);
    setError(null);
    try {
      // issueRefund carries requiresConfirmation:true — the ConfirmationDialog
      // in providers.tsx intercepts this call before it reaches the server.
      const res = await call("issueRefund", {
        paymentId,
        reason: refundReason.trim(),
        ...(refundAmount && { amount: Number(refundAmount) }),
      }) as { success: boolean; error?: { message: string } };
      if (!res.success) setError(res.error?.message ?? "Failed to issue refund");
      else {
        setRefunding(null);
        setRefundAmount("");
        setRefundReason("");
        await search();
        if (detail) await viewDetail(paymentId);
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 17, fontWeight: 600, marginBottom: 4 }}>
        Payments
        <span style={{ marginLeft: 8, fontSize: 12, fontWeight: 400, color: "#9ca3af" }}>listPayments / getPaymentRecord / issueRefund</span>
      </h2>

      <div className="field-grid" style={{ marginBottom: 14 }}>
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="">Any method</option>
          {METHODS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
        <button type="button" onClick={search} style={{ background: "#4f46e5", color: "#fff" }}>Search</button>
      </div>

      {summary && (
        <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 10 }}>
          {summary.count} payment(s) · ${summary.total.toFixed(2)} total
        </p>
      )}

      {error && <p style={{ color: "#ef4444", fontSize: 13, marginBottom: 10 }}>{error}</p>}

      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {payments.map((p) => (
          <div key={p.paymentId} style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <div className="row">
              <button type="button" onClick={() => viewDetail(p.paymentId)} style={{ background: "none", border: "none", padding: 0, textAlign: "left", cursor: "pointer" }}>
                <span style={{ fontSize: 13 }}>
                  <strong>{p.paymentId}</strong> · ${p.amount.toFixed(2)} · {p.method}
                </span>
              </button>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                <span className={`badge ${p.status === "completed" ? "badge-ok" : "badge-write"}`}>{p.status}</span>
                {p.status === "completed" && (
                  <button
                    type="button"
                    onClick={() => setRefunding(refunding === p.paymentId ? null : p.paymentId)}
                    style={{ fontSize: 11, padding: "3px 10px", background: "#fee2e2", color: "#991b1b" }}
                  >
                    Refund
                  </button>
                )}
              </div>
            </div>

            {refunding === p.paymentId && (
              <div className="row" style={{ background: "#fff", flexDirection: "column", alignItems: "stretch", gap: 8 }}>
                <div className="field-grid">
                  <input
                    type="number"
                    placeholder="Amount (blank = full)"
                    value={refundAmount}
                    onChange={(e) => setRefundAmount(e.target.value)}
                  />
                  <input placeholder="Reason (min 5 chars)" value={refundReason} onChange={(e) => setRefundReason(e.target.value)} />
                </div>
                <button
                  type="button"
                  disabled={busy === p.paymentId}
                  onClick={() => handleRefund(p.paymentId)}
                  style={{ background: "#991b1b", color: "#fff" }}
                >
                  {busy === p.paymentId ? "Refunding…" : "Confirm Refund"}
                </button>
              </div>
            )}

            {detail?.payment.paymentId === p.paymentId && (
              <div className="row" style={{ background: "#fff", flexDirection: "column", alignItems: "stretch", fontSize: 12, color: "#6b7280" }}>
                <span>category: {detail.payment.category} · covers: {detail.payment.covers}</span>
                {detail.adjustments.length > 0 && (
                  <span>adjustments: {detail.adjustments.map((a) => `${a.type} $${a.amount.toFixed(2)}`).join(", ")}</span>
                )}
              </div>
            )}
          </div>
        ))}
        {payments.length === 0 && <p style={{ color: "#9ca3af", fontSize: 13 }}>No payments for this date.</p>}
      </div>
    </div>
  );
}
