import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { registry } from "@/lib/operations";
import { auditLog } from "@/lib/auditlog";

/**
 * Registers every operation from the shared registry as an MCP tool on the
 * provided McpServer. Call this inside createMcpHandler (or a test harness).
 */
export function registerMcpTools(server: McpServer) {
  for (const op of registry) {
    const zodShape = op.inputSchema as Record<string, z.ZodTypeAny>;

    server.registerTool(
      op.name,
      {
        title: op.title,
        description: op.description,
        inputSchema: zodShape,
      },
      async (input: Record<string, unknown>) => {
        try {
          const result = await op.handler(input);
          auditLog.record(op.name, input, result.success, "agent");
          if (result.success) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify(result.data, null, 2) }],
            };
          } else {
            return {
              content: [
                {
                  type: "text" as const,
                  text: JSON.stringify(result.error, null, 2),
                },
              ],
              isError: true,
            };
          }
        } catch (err) {
          auditLog.record(op.name, input, false, "agent");
          return {
            content: [{ type: "text" as const, text: String(err) }],
            isError: true,
          };
        }
      }
    );
  }
}
