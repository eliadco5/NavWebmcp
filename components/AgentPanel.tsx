"use client";

import { useState } from "react";
import { useBridge } from "@/app/providers";
import { CapabilitiesCard } from "./CapabilitiesCard";
import { ExploreCard } from "./ExploreCard";

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
      style={{
        fontSize: 11, padding: "2px 8px", borderRadius: 4,
        background: copied ? "#22c55e" : "#312e81", color: "#e0e7ff",
        border: "none", cursor: "pointer",
      }}
    >
      {copied ? "Copied!" : "Copy"}
    </button>
  );
}

function ResetDemoDataCard() {
  const [resetting, setResetting] = useState(false);
  const [done, setDone] = useState(false);

  async function handleReset() {
    setResetting(true);
    setDone(false);
    try {
      const res = await fetch("/api/bench/reset", { method: "POST" });
      if (res.ok) {
        setDone(true);
        setTimeout(() => setDone(false), 2000);
      }
    } finally {
      setResetting(false);
    }
  }

  return (
    <div className="card">
      <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>Reset Demo Data</h2>
      <p style={{ fontSize: 12, color: "#6b7280", marginBottom: 12 }}>
        Restores CRM, tasks, housekeeping, and front-office seed data to their
        initial state — recovery if the demo gets stuck (e.g. every guest checked out).
      </p>
      <button type="button" disabled={resetting} onClick={handleReset} style={{ background: "#f3f4f6", color: "#374151" }}>
        {resetting ? "Resetting…" : done ? "Done!" : "Reset Demo Data"}
      </button>
    </div>
  );
}

export function AgentPanel() {
  const { agentToken } = useBridge();

  // Guarded the same way the MCP Inspector snippet below always was — this one
  // used to read window.location.origin unconditionally, which only survived
  // SSR because agentToken is null server-side and the ?: short-circuits. Any
  // refactor that gives agentToken a non-null initial value turns this into a
  // prerender crash (`window is not defined`).
  const origin = typeof window !== "undefined" ? window.location.origin : "http://localhost:3000";
  const mcpCommand = agentToken
    ? `claude mcp add --transport http booking \\\n  ${origin}/api/mcp \\\n  --header "Authorization: Bearer ${agentToken}"`
    : "";

  return (
    <div className="grid-2">
      <div className="col">
      <div className="card" style={{ background: "#1e1b4b", color: "#e0e7ff" }}>
        <h2 style={{ fontSize: 14, fontWeight: 600, marginBottom: 12 }}>Connect an AI Agent</h2>

        {agentToken && (
          <div style={{ marginBottom: 16 }}>
            <p style={{ fontSize: 12, marginBottom: 4, color: "#a5b4fc" }}>Your agent token:</p>
            <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <code style={{
                background: "#312e81", borderRadius: 4, padding: "4px 8px",
                fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
              }}>
                {agentToken}
              </code>
              <CopyButton text={agentToken} />
            </div>
          </div>
        )}

        <p style={{ fontSize: 12, marginBottom: 8, color: "#a5b4fc" }}>Claude Code:</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <pre style={{ background: "#312e81", borderRadius: 6, padding: 10, fontSize: 11, overflowX: "auto", margin: 0 }}>
            {mcpCommand}
          </pre>
          {mcpCommand && (
            <div style={{ display: "flex", justifyContent: "flex-end" }}>
              <CopyButton text={mcpCommand.replace(/\\\n\s+/g, " ")} />
            </div>
          )}
        </div>

        <p style={{ fontSize: 12, marginTop: 12, marginBottom: 8, color: "#a5b4fc" }}>MCP Inspector:</p>
        <pre style={{ background: "#312e81", borderRadius: 6, padding: 10, fontSize: 11, overflowX: "auto" }}>
          {`npx @modelcontextprotocol/inspector \\\n  ${origin}/api/mcp`}
        </pre>
        <p style={{ fontSize: 11, color: "#818cf8", marginTop: 6 }}>
          Use the Authorization header with your token in the inspector.
        </p>
        <p style={{ fontSize: 11, color: "#818cf8", marginTop: 4 }}>
          Also works with ChatGPT and other MCP-speaking clients — connect to the
          same URL above with the same bearer token.
        </p>
      </div>

      <ResetDemoDataCard />
      </div>
      <div className="col">
        <CapabilitiesCard />
        <ExploreCard />
      </div>
    </div>
  );
}
