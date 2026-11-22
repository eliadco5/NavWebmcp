"use client";

import type { FeatureIntro } from "@/lib/feature-intros/registry";
import { useIntros } from "./IntroProvider";

/**
 * Plays the current tab's guide on demand, whether or not it has been seen.
 * Renders nothing on tabs without a guide. If a tab has several guides, each
 * gets its own button.
 */
export function TourButton({ intros }: { intros: FeatureIntro[] }) {
  const { active, start } = useIntros();
  if (intros.length === 0) return null;

  return (
    <div style={{ display: "flex", gap: 6 }}>
      {intros.map((intro) => (
        <button
          key={intro.id}
          type="button"
          disabled={!!active}
          onClick={() => start(intro)}
          title={`Play the guide: ${intro.title}`}
          aria-label={`Play the guide: ${intro.title}`}
          className="tour-button"
        >
          <span aria-hidden="true">▶</span> {intros.length > 1 ? intro.title : "Take the tour"}
        </button>
      ))}
    </div>
  );
}
