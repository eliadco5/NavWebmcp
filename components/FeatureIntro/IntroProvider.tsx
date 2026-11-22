"use client";

import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { useBridge } from "@/app/providers";
import type { Role } from "@/lib/auth";
import { introKey, pendingIntros, type FeatureIntro } from "@/lib/feature-intros/registry";
import { IntroTour } from "./IntroTour";

interface IntroContextValue {
  /** Keys (id@version) this user has finished or skipped. null until loaded. */
  seen: ReadonlySet<string> | null;
  active: FeatureIntro | null;
  start: (intro: FeatureIntro) => void;
  /** Forget every seen intro, so each one plays again on its tab's next load. */
  resetAll: () => Promise<void>;
}

const IntroContext = createContext<IntroContextValue>({
  seen: null,
  active: null,
  start: () => {},
  resetAll: async () => {},
});

export function useIntros() {
  return useContext(IntroContext);
}

export function IntroProvider({ children }: { children: React.ReactNode }) {
  const { user } = useBridge();
  const [seen, setSeen] = useState<ReadonlySet<string> | null>(null);
  const [active, setActive] = useState<FeatureIntro | null>(null);
  const userId = user?.id ?? null;

  // Seen state is per user, so reload it whenever the user changes. If the load
  // fails, seen stays null and nothing auto-plays: better to miss an intro than
  // to show it on every page load.
  useEffect(() => {
    setSeen(null);
    setActive(null);
    if (!userId) return;
    let cancelled = false;
    fetch("/api/intros")
      .then((r) => r.json())
      .then((data) => {
        if (!cancelled && data.success) setSeen(new Set<string>(data.seen));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId]);

  // Done and Skip both count as seen: the point is not to nag.
  const close = useCallback(() => {
    if (!active) return;
    const key = introKey(active);
    setActive(null);
    setSeen((s) => new Set([...(s ?? []), key]));
    fetch("/api/intros", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }).catch(() => {});
  }, [active]);

  const resetAll = useCallback(async () => {
    await fetch("/api/intros", { method: "DELETE" }).catch(() => {});
    setSeen(new Set());
  }, []);

  return (
    <IntroContext.Provider value={{ seen, active, start: setActive, resetAll }}>
      {children}
      {active && <IntroTour key={introKey(active)} intro={active} onClose={close} />}
    </IntroContext.Provider>
  );
}

/** Plays the first not-yet-seen intro for this tab, once per user. */
export function useFeatureIntro(tabId: string | undefined, role: Role) {
  const { seen, active, start } = useIntros();
  useEffect(() => {
    if (!tabId || !seen || active) return;
    const [first] = pendingIntros(tabId, role, seen);
    if (first) start(first);
  }, [tabId, role, seen, active, start]);
}
