import { getAttachment } from "./attachments";
import { AttachmentKind } from "./types";

export function errorResponse(status: number, code: string, message: string): Response {
  return Response.json({ success: false, error: { code, message } }, { status });
}

/** Streams one stored attachment back (callers do the auth check). */
export async function attachmentResponse(reportId: string, kindRaw: string): Promise<Response> {
  const kind = AttachmentKind.safeParse(kindRaw);
  if (!kind.success) return errorResponse(400, "INVALID_INPUT", `Unknown attachment kind ${kindRaw}.`);
  const att = await getAttachment(reportId, kind.data);
  if (!att) return errorResponse(404, "NOT_FOUND", `No ${kind.data} for report ${reportId}.`);
  return new Response(new Uint8Array(att.data), {
    headers: {
      "Content-Type": att.mime,
      "Content-Length": String(att.data.length),
      "Cache-Control": "private, max-age=300",
      // The replay is gzip bytes the player decompresses itself — don't let
      // anything treat it as Content-Encoding.
      "X-Content-Type-Options": "nosniff",
    },
  });
}
