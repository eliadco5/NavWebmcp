"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function LoginForm() {
  const router = useRouter();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = await res.json();
      if (data.success) {
        router.replace("/");
      } else {
        setError(data.error?.message ?? "Login failed.");
      }
    } catch {
      setError("Network error. Please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="card" style={{ width: 360, padding: 36 }}>
      <h1 style={{ fontSize: 22, fontWeight: 700, marginBottom: 6 }}>AgentBridge Booking</h1>
      <p style={{ fontSize: 13, color: "#6b7280", marginBottom: 24 }}>
        Sign in to book and manage reservations.
      </p>

      <form onSubmit={handleSubmit} style={{ display: "flex", flexDirection: "column", gap: 14 }}>
        <div>
          <label style={{ fontSize: 13, color: "#374151", display: "block", marginBottom: 4 }}>
            Username
          </label>
          <input
            type="text"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div>
          <label style={{ fontSize: 13, color: "#374151", display: "block", marginBottom: 4 }}>
            Password
          </label>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && <p style={{ color: "#ef4444", fontSize: 13 }}>{error}</p>}
        <button
          type="submit"
          disabled={loading}
          style={{ background: "#4f46e5", color: "#fff", marginTop: 4 }}
        >
          {loading ? "Signing in…" : "Sign in"}
        </button>
      </form>
    </div>
  );
}
