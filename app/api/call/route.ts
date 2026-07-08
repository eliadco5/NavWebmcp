import { NextRequest } from "next/server";
import { z } from "zod";
import { registry } from "@/lib/operations";
import { auditLog } from "@/lib/auditlog";

export async function POST(req: NextRequest) {
  const { name, params } = await req.json();

  const op = registry.find((o) => o.name === name);
  if (!op) {
    return Response.json(
      { success: false, error: { code: "NOT_FOUND", message: `Operation "${name}" not found` } },
      { status: 404 }
    );
  }

  const schema = z.object(op.inputSchema);
  const parsed = schema.safeParse(params ?? {});
  if (!parsed.success) {
    return Response.json({
      success: false,
      error: {
        code: "INVALID_INPUT",
        message: parsed.error.issues.map((i) => i.message).join("; "),
      },
    });
  }

  const result = await op.handler(parsed.data);
  const success = (result as { success?: boolean }).success !== false;
  auditLog.record(name, params ?? {}, success, "ui");

  return Response.json(result);
}
