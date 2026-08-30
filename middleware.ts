import { NextResponse } from "next/server";

// Auth is stateless (HMAC-signed cookie, verified in lib/auth.ts — see
// getOrProvisionUser). Middleware runs on the Edge runtime, which cannot import
// node:crypto, so it never validates the cookie's signature — only route handlers
// do. It used to redirect to /login when no cookie was present; that's gone now
// because every route auto-provisions a fresh session for a first-time visitor
// (see lib/auth.ts's getOrProvisionUser), so there is nothing left to gate.
// This file is kept, rather than deleted, as the seam a real deployment would use
// to add a real check.
export function middleware() {
  return NextResponse.next();
}

export const config = {
  matcher: ["/"],
};
