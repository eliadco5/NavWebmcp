import { defineOperation } from "./types";
import { ok } from "@/lib/result";

export const getContext = defineOperation({
  name: "getContext",
  title: "Get Context",
  description: "Return current application context: page name, auth status, locale.",
  permission: "read",
  tags: ["context"],
  inputSchema: {},
  async handler(_input) {
    return ok({
      page: "booking",
      authenticated: true,
      locale: "en-US",
    });
  },
});
