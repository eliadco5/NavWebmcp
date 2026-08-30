import type { OperationContext } from "@/lib/operations/types";

export type Role = "customer" | "support" | "admin";

export const adminCtx: OperationContext = {
  userId: "u_bob",
  role: "admin",
  token: "tok_admin",
};

export const supportCtx: OperationContext = {
  userId: "u_carol",
  role: "support",
  token: "tok_support",
};

export const customerCtx: OperationContext = {
  userId: "u_alice",
  role: "customer",
  token: "tok_customer",
};
