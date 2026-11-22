import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "fs";
import path from "path";
import { FEATURE_INTROS, introKey, isKnownIntroKey, pendingIntros, introsForRole, type FeatureIntro } from "@/lib/feature-intros/registry";
import { TAB_IDS } from "@/lib/feature-intros/tabs";
import { positionPopover } from "@/lib/feature-intros/position";

const ROOT = path.resolve(__dirname, "../..");

function componentSources(): string {
  const dir = path.join(ROOT, "components");
  const files: string[] = [];
  const walk = (d: string) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (p.endsWith(".tsx")) files.push(readFileSync(p, "utf8"));
    }
  };
  walk(dir);
  return files.join("\n");
}

describe("FEATURE_INTROS registry", () => {
  it("has unique ids, positive integer versions and non-empty steps", () => {
    const ids = FEATURE_INTROS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const intro of FEATURE_INTROS) {
      expect(intro.id).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(Number.isInteger(intro.version) && intro.version > 0).toBe(true);
      expect(intro.title.trim()).not.toBe("");
      expect(intro.steps.length).toBeGreaterThan(0);
      for (const step of intro.steps) {
        expect(step.title.trim()).not.toBe("");
        expect(step.body.trim()).not.toBe("");
      }
    }
  });

  it("points every intro at a real AppShell tab", () => {
    const shell = readFileSync(path.join(ROOT, "components/AppShell.tsx"), "utf8");
    for (const id of TAB_IDS) expect(shell).toContain(`id: "${id}"`);
    for (const intro of FEATURE_INTROS) expect(TAB_IDS).toContain(intro.tab);
  });

  it("has a data-intro anchor in the components for every step target", () => {
    const src = componentSources();
    for (const intro of FEATURE_INTROS) {
      for (const step of intro.steps) {
        if (step.target) expect(src, `${intro.id}: missing data-intro="${step.target}"`).toContain(`data-intro="${step.target}"`);
      }
    }
  });
});

describe("pendingIntros", () => {
  const all: FeatureIntro = { id: "a", version: 1, tab: "agent", title: "A", steps: [{ title: "t", body: "b" }] };
  const adminOnly: FeatureIntro = { ...all, id: "b", roles: ["admin"] };
  const elsewhere: FeatureIntro = { ...all, id: "c", tab: "tasks" };
  const list = [all, adminOnly, elsewhere];

  it("returns intros for this tab and role that haven't been seen", () => {
    expect(pendingIntros("agent", "admin", new Set(), list).map((i) => i.id)).toEqual(["a", "b"]);
    expect(pendingIntros("agent", "customer", new Set(), list).map((i) => i.id)).toEqual(["a"]);
    expect(pendingIntros("agent", "admin", new Set(["a@1"]), list).map((i) => i.id)).toEqual(["b"]);
  });

  it("shows an intro again after its version is bumped", () => {
    expect(pendingIntros("agent", "customer", new Set(["a@1"]), [{ ...all, version: 2 }]).map(introKey)).toEqual(["a@2"]);
  });

  it("filters by role", () => {
    expect(introsForRole("support", list).map((i) => i.id)).toEqual(["a", "c"]);
  });

  it("only accepts registered keys", () => {
    for (const intro of FEATURE_INTROS) expect(isKnownIntroKey(introKey(intro))).toBe(true);
    expect(isKnownIntroKey("nope@1")).toBe(false);
    expect(isKnownIntroKey(`${FEATURE_INTROS[0].id}@999`)).toBe(false);
  });
});

describe("seen-store (in-memory, no REDIS_URL)", () => {
  it("records, isolates per user and resets", async () => {
    delete process.env.REDIS_URL;
    const { getSeen, markSeen, resetSeen } = await import("@/lib/feature-intros/seen-store");
    expect(await getSeen("u1")).toEqual([]);
    await markSeen("u1", "agent-tab@1");
    await markSeen("u1", "agent-tab@1");
    expect(await getSeen("u1")).toEqual(["agent-tab@1"]);
    expect(await getSeen("u2")).toEqual([]);
    await resetSeen("u1");
    expect(await getSeen("u1")).toEqual([]);
  });
});

describe("positionPopover", () => {
  const viewport = { width: 1000, height: 800 };
  const size = { width: 300, height: 150 };

  it("centres when there is no target", () => {
    expect(positionPopover(null, undefined, viewport, size)).toEqual({ top: 325, left: 350, placement: "center" });
  });

  it("uses the preferred side when it fits", () => {
    const target = { top: 100, left: 100, width: 200, height: 100 };
    const p = positionPopover(target, "right", viewport, size);
    expect(p.placement).toBe("right");
    expect(p.left).toBe(100 + 200 + 14);
  });

  it("falls back to another side when the preferred one doesn't fit", () => {
    const target = { top: 100, left: 10, width: 200, height: 100 };
    expect(positionPopover(target, "left", viewport, size).placement).toBe("bottom");
  });

  it("stays inside the viewport", () => {
    const target = { top: 0, left: 0, width: 1000, height: 800 };
    const p = positionPopover(target, "bottom", viewport, size);
    expect(p.placement).toBe("center");
    expect(p.top + size.height).toBeLessThanOrEqual(800);
  });
});
