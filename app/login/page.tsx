import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { LoginForm } from "@/components/LoginForm";
import { SESSION_COOKIE } from "@/lib/auth";
import { userForSession } from "@/lib/auth-tokens";

export default async function LoginPage() {
  // Already signed in: skip the form.
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (raw && userForSession(raw)) redirect("/");

  return (
    <div style={{
      minHeight: "100vh", display: "flex", alignItems: "center",
      justifyContent: "center", background: "#f9fafb",
    }}>
      <LoginForm />
    </div>
  );
}
