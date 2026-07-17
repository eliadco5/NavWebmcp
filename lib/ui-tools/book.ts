"use client";

import { serverCall } from "@/app/providers";
import { bookOrchestration } from "@/lib/core/book";

export type { BookInput, BookResult } from "@/lib/core/book";

export function book(input: Parameters<typeof bookOrchestration>[0]) {
  return bookOrchestration(input, serverCall);
}
