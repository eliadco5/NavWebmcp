import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { Providers } from "./providers";
import { AppShell } from "@/components/AppShell";
import { IntroProvider } from "@/components/FeatureIntro/IntroProvider";
import { SESSION_COOKIE } from "@/lib/auth";
import { isDemoMode, userForSession } from "@/lib/auth-tokens";

// The login gate. Done here rather than in middleware.ts because this runs on the
// Node runtime, so it can verify the cookie's HMAC signature — middleware (Edge)
// could only check that *some* cookie exists, which a forged or expired one passes.
// In demo mode there's nothing to gate: /api/me provisions a session on first load.
export default async function Home() {
  if (!isDemoMode()) {
    const raw = (await cookies()).get(SESSION_COOKIE)?.value;
    if (!raw || !userForSession(raw)) redirect("/login");
  }

  return (
    <Providers>
      <IntroProvider>
        <AppShell />
      </IntroProvider>
    </Providers>
  );
}
