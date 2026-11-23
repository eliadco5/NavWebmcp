import { z } from "zod";

// Standard state shapes per component kind (docs/ui-components.md#kinds). A
// component of a given kind MUST build its schema with the matching helper, so
// every table looks the same to an agent: { filters, sort }.

export const SortDirection = z.enum(["asc", "desc"]);

/**
 * kind "table": `{ filters: {...}, sort: [{ column, direction }] }`.
 * - `filters`: the table's own filter fields, all optional (absent = "any").
 *   Clear one with a `null` in the patch.
 * - `sort`: ordered sort keys, at most `maxSort` (default 1). `[]` = default order.
 */
export function tableStateSchema<F extends z.ZodRawShape, C extends string>(
  filters: F,
  sortable: readonly [C, ...C[]],
  maxSort = 1
) {
  return z
    .object({
      filters: z.object(filters).strict().describe("Active filters; an absent key means 'any'"),
      sort: z
        .array(z.object({ column: z.enum(sortable), direction: SortDirection }).strict())
        .max(maxSort)
        .describe(`Sort keys in priority order (max ${maxSort}); [] for the default order`),
    })
    .strict();
}

/** kind "tabs": `{ activeTab }`, limited to the tabs this user can see. */
export function tabsStateSchema<T extends string>(tabs: readonly [T, ...T[]]) {
  return z.object({ activeTab: z.enum(tabs).describe("The tab shown to the user") }).strict();
}
