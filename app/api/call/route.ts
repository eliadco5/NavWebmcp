import { NextRequest } from "next/server";
import { cookies } from "next/headers";
import { registry } from "@/lib/operations";
import { inputObject, checkOutput } from "@/lib/schema";
import { auditLog } from "@/lib/auditlog";
import { roleSatisfies } from "@/lib/auth";
import { getOrProvisionUser } from "@/lib/auth-tokens";
import { withSharedState } from "@/lib/shared-state";

export const dynamic = "force-dynamic";

export const POST = withSharedState(async function POST(req: NextRequest) {
  const cookieStore = await cookies();
  const { user } = getOrProvisionUser(cookieStore);
  if (!user) {
    return Response.json(
      { success: false, error: { code: "UNAUTHENTICATED", message: "Login required." } },
      { status: 401 }
    );
  }

  const { name, params } = await req.json();

  const op = registry.find((o) => o.name === name);
  if (!op) {
    return Response.json(
      { success: false, error: { code: "NOT_FOUND", message: `Operation "${name}" not found` } },
      { status: 404 }
    );
  }

  // RBAC: reject if user's role is not permitted for this operation
  if (!roleSatisfies(user.role, op.roles)) {
    return Response.json(
      { success: false, error: { code: "FORBIDDEN", message: `Role '${user.role}' is not permitted to call '${op.name}'.` } },
      { status: 403 }
    );
  }

  const parsed = inputObject(op.inputSchema).safeParse(params ?? {});
  if (!parsed.success) {
    return Response.json({
      success: false,
      error: {
        code: "INVALID_INPUT",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
  }

  const result = await op.handler(parsed.data, { userId: user.id, role: user.role, token: "" });
  const success = result.success;
  const output = result.success ? result.data : result.error;
  if (result.success) checkOutput(op.name, op.outputSchema, result.data);
  auditLog.record(name, params ?? {}, success, "ui", output);

  return Response.json(result);
});
