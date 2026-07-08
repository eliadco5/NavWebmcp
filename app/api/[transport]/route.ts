import { createMcpHandler } from "mcp-handler";
import { registerMcpTools } from "@/lib/adapters/mcp";

const handler = createMcpHandler(
  (server) => {
    registerMcpTools(server);
  },
  {},
  {
    basePath: "/api",
    maxDuration: 60,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
