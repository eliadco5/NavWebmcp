import { Providers } from "./providers";
import { AppShell } from "@/components/AppShell";

export default function Home() {
  return (
    <Providers>
      <AppShell />
    </Providers>
  );
}
