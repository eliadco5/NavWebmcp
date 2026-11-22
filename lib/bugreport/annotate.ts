// Provenance annotations: tell the bug-report inspector which operation (and
// which field of its output, for which entity) a piece of UI was rendered
// from. With these, "this should show 2, not 1" arrives with the API's actual
// value next to the UI's — so it's immediately a UI bug or a data bug.
//
//   <span {...bugSource("listReservations", "reservations[].partySize", r.id)}>
//     {r.partySize} guests
//   </span>
//
// `field` is a path into the op's success `data`: dot-separated keys, with
// `[]` marking an array whose element is picked by matching `entity` against
// the element's id-like keys (id, guestId, taskId, …, or date for per-day
// rows). Without `entity`, `[]`
// takes the whole array.

export interface BugSourceProps {
  "data-bug-source": string;
  "data-bug-field"?: string;
  "data-bug-entity"?: string;
}

export function bugSource(op: string, field?: string, entity?: string | number): BugSourceProps {
  return {
    "data-bug-source": op,
    ...(field ? { "data-bug-field": field } : {}),
    ...(entity !== undefined && entity !== "" ? { "data-bug-entity": String(entity) } : {}),
  };
}

/** Names a static piece of UI (a card title, a column header, a label) so a
 *  "wrong title" report points straight at the component that renders it. */
export function bugComponent(name: string): { "data-bug-component": string } {
  return { "data-bug-component": name };
}

function matchesEntity(item: unknown, entity: string): boolean {
  if (!item || typeof item !== "object") return false;
  for (const [k, v] of Object.entries(item as Record<string, unknown>)) {
    if ((k === "id" || /Id$/.test(k) || k === "date") && String(v) === entity) return true;
  }
  return false;
}

/** Resolves `field` (see top of file) inside `data`. */
export function valueAtPath(data: unknown, field: string, entity?: string): { found: boolean; value?: unknown } {
  let cur: unknown = data;
  for (const rawSeg of field.split(".")) {
    const isArray = rawSeg.endsWith("[]");
    const key = isArray ? rawSeg.slice(0, -2) : rawSeg;
    if (key) {
      if (!cur || typeof cur !== "object" || !(key in (cur as object))) return { found: false };
      cur = (cur as Record<string, unknown>)[key];
    }
    if (isArray) {
      if (!Array.isArray(cur)) return { found: false };
      if (entity === undefined) continue; // whole array
      const hit = cur.find((item) => matchesEntity(item, entity));
      if (hit === undefined) return { found: false };
      cur = hit;
    }
  }
  return { found: true, value: cur };
}
