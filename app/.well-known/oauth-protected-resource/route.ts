import { ALL_SCOPES } from "@/lib/auth";
import { MCP_RESOURCE } from "@/lib/auth-tokens";

/**
 * RFC 9728 Protected Resource Metadata endpoint.
 * MCP clients MUST use this for authorization server discovery.
 * Since this is a self-hosted demo with no external authorization server,
 * authorization_servers is empty — the note is that a real deployment
 * would point to an external OAuth 2.1 authorization server here.
 */
export function GET() {
  const metadata = {
    resource: MCP_RESOURCE,
    authorization_servers: [],   // no external AS in this demo
    scopes_supported: ALL_SCOPES,
    bearer_methods_supported: ["header"],
    resource_documentation: "https://github.com/anthropics/webmcp",
  };

  return new Response(JSON.stringify(metadata), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",  // CORS for MCP clients per spec
      "Cache-Control": "no-store",
    },
  });
}

export function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
}
