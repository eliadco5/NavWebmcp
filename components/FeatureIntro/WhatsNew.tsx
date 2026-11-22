"use client";

import { useEffect, useRef, useState } from "react";
import { introKey, type FeatureIntro } from "@/lib/feature-intros/registry";
import { useIntros } from "./IntroProvider";

/**
 * Header menu listing the intros this user can see, with replay. `onOpenTab`
 * switches to the intro's tab first so its targets are on screen.
 */
export function WhatsNew({ intros, onOpenTab }: { intros: FeatureIntro[]; onOpenTab: (tab: string) => void }) {
  const { seen, start, resetAll } = useIntros();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (intros.length === 0) return null;
  const unseen = seen ? intros.filter((i) => !seen.has(introKey(i))).length : 0;

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
        style={{ fontSize: 12, color: "#4f46e5", background: "none", padding: 0 }}
      >
        What&apos;s new{unseen > 0 && <span className="intro-dot" aria-label={`${unseen} unseen`} />}
      </button>
      {open && (
        <div className="card" role="menu" style={{ position: "absolute", top: 22, left: 0, width: 260, padding: 12, zIndex: 50 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: "#374151", marginBottom: 8 }}>Feature guides</div>
          {intros.map((intro) => {
            const isSeen = seen?.has(introKey(intro)) ?? false;
            return (
              <div key={intro.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 0" }}>
                <span style={{ fontSize: 13, flex: 1 }}>
                  {intro.title}
                  {!isSeen && <span className="badge badge-ui" style={{ marginLeft: 6 }}>new</span>}
                </span>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setOpen(false);
                    onOpenTab(intro.tab);
                    start(intro);
                  }}
                  style={{ fontSize: 11, padding: "3px 10px", background: "#f3f4f6", color: "#374151" }}
                >
                  {isSeen ? "Replay" : "Start"}
                </button>
              </div>
            );
          })}
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              void resetAll();
            }}
            style={{ marginTop: 8, fontSize: 11, padding: 0, background: "none", color: "#6b7280" }}
          >
            Show all guides again
          </button>
        </div>
      )}
    </div>
  );
}
