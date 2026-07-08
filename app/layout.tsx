import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AgentBridge Booking Demo",
  description: "A booking app an AI agent can operate via AgentBridge + WebMCP",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
