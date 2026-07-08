import { auditLog } from "@/lib/auditlog";

export function GET() {
  return Response.json(auditLog.getEntries());
}
