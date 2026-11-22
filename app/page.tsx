import { Providers } from "./providers";
import { AppShell } from "@/components/AppShell";
import { IntroProvider } from "@/components/FeatureIntro/IntroProvider";

export default function Home() {
  return (
    <Providers>
      <IntroProvider>
        <AppShell />
      </IntroProvider>
    </Providers>
  );
}
