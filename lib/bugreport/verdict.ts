import type { Provenance } from "./types";

/** Plain-language read of provenance — the reason this feature exists. */
export function provenanceVerdict(p: Provenance, expected?: string): string {
  const where = `${p.op}${p.field ? ` → ${p.field}` : ""}`;
  if (!p.apiValueFound) return `Bound to ${where}, but no matching value was found in the last response — the data may be missing on the server.`;
  if (typeof p.apiValue === "object" && p.apiValue !== null) return `Bound to ${where}. The API response is attached for comparison.`;
  const api = String(p.apiValue);
  if (expected && expected.trim() === api) return `The API already returns "${api}" for ${where} — the UI is showing it wrong (UI bug).`;
  if (p.uiText.includes(api)) return `The UI shows exactly what ${where} returned ("${api}"). If that's wrong, the problem is in the data or business logic, not the screen.`;
  return `The API returned "${api}" for ${where}, but the UI shows "${p.uiText.slice(0, 80)}" — likely a display bug.`;
}
