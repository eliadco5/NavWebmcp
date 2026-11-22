import { NextResponse } from "next/server";

// Auth is stateless (HMAC-signed cookie, verified in lib/auth-tokens.ts).
// Middleware runs on the Edge runtime, which cannot import node:crypto, so it
// can't validate the cookie's signature. The login gate therefore lives in
// app/page.tsx (a server component on the Node runtime), and each API route
// checks the session itself via getOrProvisionUser. This file is kept as a
// pass-through seam rather than deleted.
export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
