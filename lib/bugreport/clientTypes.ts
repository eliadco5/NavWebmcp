import type { AttachmentKind, BugReportInput } from "./types";

/** A binary captured in the browser, uploaded after the JSON report. */
export interface CapturedFile {
  kind: AttachmentKind;
  blob: Blob;
  /** data: URL for images, so the dialog can preview and JSON downloads embed them. */
  previewUrl?: string;
}

/** Everything captured automatically; the dialog adds the user's words. */
export type CapturedBase = Omit<BugReportInput, "category" | "description" | "expected" | "actual" | "screenshot"> & {
  files: CapturedFile[];
};

/** data: URL → Blob without fetch() (the CSP's connect-src doesn't allow data:). */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [meta, b64] = dataUrl.split(",", 2);
  const mime = /data:([^;]+)/.exec(meta)?.[1] ?? "application/octet-stream";
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type: mime });
}

export function imageFile(kind: AttachmentKind, dataUrl: string | undefined): CapturedFile[] {
  return dataUrl ? [{ kind, blob: dataUrlToBlob(dataUrl), previewUrl: dataUrl }] : [];
}

export const FILE_LABELS: Record<AttachmentKind, string> = {
  screenshot: "Screenshot",
  before: "Before screenshot",
  after: "After screenshot",
  replay: "DOM replay",
  video: "Screen video",
};

export function formatBytes(n: number): string {
  return n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`;
}
