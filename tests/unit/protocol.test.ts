import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";

// Dynamic imports used because setup.ts resets modules before each test.

const SKILL_PATH = new URL("../../skills/navwebmcp-agent/SKILL.md", import.meta.url);
const AGENT_INSTRUCTIONS_ALWAYS_ON_NAMES = [
  "explore",
  "search",
  "describe_tool",
  "invoke",
  "load_tools",
  "unload_tools",
  "getContext",
  "getCapabilities",
];

function readSkill(): string {
  return readFileSync(SKILL_PATH, "utf8");
}

function parseFrontmatter(md: string): Record<string, string> {
  const match = md.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm: Record<string, string> = {};
  for (const line of match[1].split("\n")) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (m) fm[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return fm;
}

/** Minimal range check for ">=X.Y.Z <A.B.C" style ranges — no semver dependency. */
function satisfiesRange(version: string, range: string): boolean {
  const toTuple = (v: string) => v.split(".").map(Number);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < 3; i++) {
      if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
  };
  const v = toTuple(version);
  const clauses = range.trim().split(/\s+/);
  return clauses.every((clause) => {
    const m = clause.match(/^(>=|<=|>|<|=)(\d+\.\d+\.\d+)$/);
    if (!m) throw new Error(`Unparseable range clause: ${clause}`);
    const [, op, ver] = m;
    const c = cmp(v, toTuple(ver));
    switch (op) {
      case ">=": return c >= 0;
      case "<=": return c <= 0;
      case ">": return c > 0;
      case "<": return c < 0;
      case "=": return c === 0;
      default: return false;
    }
  });
}

describe("PROTOCOL_VERSION", () => {
  it("is a semver string", async () => {
    const { PROTOCOL_VERSION } = await import("@/lib/protocol");
    expect(PROTOCOL_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("PROTOCOL_NAME is NavWebMcp", async () => {
    const { PROTOCOL_NAME } = await import("@/lib/protocol");
    expect(PROTOCOL_NAME).toBe("NavWebMcp");
  });
});

describe("CHANGELOG.md", () => {
  it("documents the current PROTOCOL_VERSION", async () => {
    const { PROTOCOL_VERSION } = await import("@/lib/protocol");
    const changelog = readFileSync(
      new URL("../../CHANGELOG.md", import.meta.url),
      "utf8"
    );
    expect(changelog).toContain(`## ${PROTOCOL_VERSION}`);
  });
});

describe("skills/navwebmcp-agent/SKILL.md", () => {
  it("exists with name, description, version, protocol frontmatter", () => {
    const fm = parseFrontmatter(readSkill());
    expect(fm.name).toBe("navwebmcp-agent");
    expect(fm.description).toBeDefined();
    expect(fm.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(fm.protocol).toBeTruthy();
  });

  it("PROTOCOL_VERSION satisfies the skill's declared protocol range", async () => {
    const { PROTOCOL_VERSION } = await import("@/lib/protocol");
    const fm = parseFrontmatter(readSkill());
    expect(satisfiesRange(PROTOCOL_VERSION, fm.protocol)).toBe(true);
  });

  it("mentions the protocolVersion and capabilityHash field names", () => {
    const skill = readSkill();
    expect(skill).toContain("protocolVersion");
    expect(skill).toContain("capabilityHash");
  });

  it("every alwaysOn operation is named in both AGENT_INSTRUCTIONS and the skill", async () => {
    await import("@/lib/operations/index");
    const { registry } = await import("@/lib/operations/index");
    const { AGENT_INSTRUCTIONS } = await import("@/lib/agent-instructions");
    const skill = readSkill();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const alwaysOnNames = (registry as any[]).filter((op) => op.alwaysOn).map((op) => op.name);
    expect(alwaysOnNames.sort()).toEqual([...AGENT_INSTRUCTIONS_ALWAYS_ON_NAMES].sort());
    for (const name of alwaysOnNames) {
      expect(AGENT_INSTRUCTIONS).toContain(name);
      expect(skill).toContain(name);
    }
  });
});
