import { describe, it, expect, beforeEach, vi } from "vitest";

// setup.ts already calls vi.resetModules() in beforeEach.
// We use dynamic imports inside each test so each test gets a fresh module instance.

describe("roleSatisfies", () => {
  it("admin satisfies [customer]", async () => {
    const { roleSatisfies } = await import("@/lib/auth");
    expect(roleSatisfies("admin", ["customer"])).toBe(true);
  });

  it("customer does NOT satisfy [admin]", async () => {
    const { roleSatisfies } = await import("@/lib/auth");
    expect(roleSatisfies("customer", ["admin"])).toBe(false);
  });

  it("support satisfies [support, admin] (has one match at rank)", async () => {
    const { roleSatisfies } = await import("@/lib/auth");
    expect(roleSatisfies("support", ["support", "admin"])).toBe(true);
  });

  it("empty allowed array → false for any role", async () => {
    const { roleSatisfies } = await import("@/lib/auth");
    expect(roleSatisfies("admin", [])).toBe(false);
    expect(roleSatisfies("customer", [])).toBe(false);
  });

  it("all roles satisfy [customer] due to hierarchy", async () => {
    const { roleSatisfies } = await import("@/lib/auth");
    expect(roleSatisfies("customer", ["customer"])).toBe(true);
    expect(roleSatisfies("support", ["customer"])).toBe(true);
    expect(roleSatisfies("admin", ["customer"])).toBe(true);
  });

  it("exact match works: support satisfies [support]", async () => {
    const { roleSatisfies } = await import("@/lib/auth");
    expect(roleSatisfies("support", ["support"])).toBe(true);
  });

  it("customer does NOT satisfy [support]", async () => {
    const { roleSatisfies } = await import("@/lib/auth");
    expect(roleSatisfies("customer", ["support"])).toBe(false);
  });
});

describe("verifyCredentials", () => {
  it("alice/password → User with role customer", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    const user = verifyCredentials("alice", "password");
    expect(user).not.toBeNull();
    expect(user!.username).toBe("alice");
    expect(user!.role).toBe("customer");
    expect(user!.id).toBe("u_alice");
  });

  it("bob/password → User with role admin", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    const user = verifyCredentials("bob", "password");
    expect(user).not.toBeNull();
    expect(user!.role).toBe("admin");
    expect(user!.id).toBe("u_bob");
  });

  it("carol/password → User with role support", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    const user = verifyCredentials("carol", "password");
    expect(user).not.toBeNull();
    expect(user!.role).toBe("support");
    expect(user!.id).toBe("u_carol");
  });

  it("wrong password → null", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    expect(verifyCredentials("alice", "wrong")).toBeNull();
  });

  it("unknown user → null", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    expect(verifyCredentials("nobody", "password")).toBeNull();
  });

  it("password is case-sensitive", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    expect(verifyCredentials("alice", "Password")).toBeNull();
    expect(verifyCredentials("alice", "PASSWORD")).toBeNull();
  });
});

// Sessions and agent tokens are HMAC-signed strings now (lib/auth-tokens.ts),
// not server-side lookups — there is no Map to invalidate, so a "session" or
// "token" is valid for as long as its signature verifies and it hasn't expired.
describe("createSession / userForSession", () => {
  it("round-trip: createSession → userForSession returns user", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    const { createSession, userForSession } = await import("@/lib/auth-tokens");
    const alice = verifyCredentials("alice", "password")!;
    const sid = createSession(alice);
    const user = userForSession(sid);
    expect(user).not.toBeNull();
    expect(user!.id).toBe("u_alice");
    expect(user!.role).toBe("customer");
  });

  it("calling twice for the same user+role produces a byte-identical session", async () => {
    // Load-bearing, not incidental: /api/me, /api/audit, and /api/switch-role
    // can all auto-provision a session in parallel on first load. If the same
    // user+role minted a different string each time, those parallel requests
    // would race on Set-Cookie.
    const { verifyCredentials } = await import("@/lib/auth");
    const { createSession } = await import("@/lib/auth-tokens");
    const bob = verifyCredentials("bob", "password")!;
    const sid1 = createSession(bob);
    const sid2 = createSession(bob);
    expect(sid1).toBe(sid2);
  });

  it("a role change produces a different session for the same user", async () => {
    // This is what /api/switch-role relies on: re-minting with a different
    // role changes the signed payload (and therefore the string) while the
    // userId stays the same.
    const { verifyCredentials } = await import("@/lib/auth");
    const { createSession } = await import("@/lib/auth-tokens");
    const alice = verifyCredentials("alice", "password")!;
    const asCustomer = createSession(alice);
    const asAdmin = createSession({ ...alice, role: "admin" });
    expect(asCustomer).not.toBe(asAdmin);
  });

  it("userForSession returns the role carried in the payload, not the USERS table", async () => {
    // This is what lets the role switcher work with no mutable server-side
    // state: alice's default role is customer, but a session signed with
    // role: "admin" for her userId must come back as admin.
    const { verifyCredentials } = await import("@/lib/auth");
    const { createSession, userForSession } = await import("@/lib/auth-tokens");
    const alice = verifyCredentials("alice", "password")!;
    const sid = createSession({ ...alice, role: "admin" });
    const user = userForSession(sid);
    expect(user).not.toBeNull();
    expect(user!.id).toBe("u_alice");
    expect(user!.role).toBe("admin");
  });

  it("returns null for unknown/garbage session string", async () => {
    const { userForSession } = await import("@/lib/auth-tokens");
    expect(userForSession("bogus-session-id")).toBeNull();
    expect(userForSession("")).toBeNull();
  });

  it("returns null for a tampered signature", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    const { createSession } = await import("@/lib/auth-tokens");
    const { userForSession } = await import("@/lib/auth-tokens");
    const alice = verifyCredentials("alice", "password")!;
    const sid = createSession(alice);
    const [payload] = sid.split(".");
    const tampered = `${payload}.not-the-real-signature`;
    expect(userForSession(tampered)).toBeNull();
  });

  it("returns null for an expired session", async () => {
    vi.useFakeTimers();
    const { verifyCredentials } = await import("@/lib/auth");
    const { createSession, userForSession } = await import("@/lib/auth-tokens");
    const alice = verifyCredentials("alice", "password")!;
    const sid = createSession(alice);
    // Sessions are minted with a 7-day TTL bucketed to 1 day — 9 days is safely
    // past expiry regardless of where in the current bucket "now" fell.
    vi.advanceTimersByTime(9 * 24 * 60 * 60 * 1000);
    expect(userForSession(sid)).toBeNull();
    vi.useRealTimers();
  });

  it("a session string cannot be used as a bearer token (domain separation)", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    const { createSession, userForToken } = await import("@/lib/auth-tokens");
    const { AGENT_TOKEN_PREFIX } = await import("@/lib/constants");
    const alice = verifyCredentials("alice", "password")!;
    const sid = createSession(alice);
    expect(userForToken(`${AGENT_TOKEN_PREFIX}.${sid}`)).toBeNull();
  });
});

describe("issueToken / userForToken", () => {
  it("returns a non-empty string prefixed with ab1.", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    const { issueToken } = await import("@/lib/auth-tokens");
    const user = verifyCredentials("alice", "password")!;
    const token = issueToken(user);
    expect(typeof token).toBe("string");
    expect(token.startsWith("ab1.")).toBe(true);
  });

  it("calling twice for same user reuses the same token within the bucket", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    const { issueToken } = await import("@/lib/auth-tokens");
    const user = verifyCredentials("bob", "password")!;
    const t1 = issueToken(user);
    const t2 = issueToken(user);
    expect(t1).toBe(t2);
  });

  it("different users get different tokens", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    const { issueToken } = await import("@/lib/auth-tokens");
    const alice = verifyCredentials("alice", "password")!;
    const bob = verifyCredentials("bob", "password")!;
    expect(issueToken(alice)).not.toBe(issueToken(bob));
  });

  it("returns User for a valid token", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    const { issueToken, userForToken } = await import("@/lib/auth-tokens");
    const alice = verifyCredentials("alice", "password")!;
    const token = issueToken(alice);
    const user = userForToken(token);
    expect(user).not.toBeNull();
    expect(user!.id).toBe("u_alice");
  });

  it("returns null for garbage string", async () => {
    const { userForToken } = await import("@/lib/auth-tokens");
    expect(userForToken("not-a-real-token")).toBeNull();
  });

  it("returns null for empty string token", async () => {
    const { userForToken } = await import("@/lib/auth-tokens");
    expect(userForToken("")).toBeNull();
  });

  it("returns null for a token missing the ab1. prefix", async () => {
    const { verifyCredentials } = await import("@/lib/auth");
    const { issueToken, userForToken } = await import("@/lib/auth-tokens");
    const alice = verifyCredentials("alice", "password")!;
    const token = issueToken(alice);
    expect(userForToken(token.replace(/^ab1\./, ""))).toBeNull();
  });

  it("returns null for expired token (10 hours ahead)", async () => {
    vi.useFakeTimers();
    const { verifyCredentials } = await import("@/lib/auth");
    const { issueToken, userForToken } = await import("@/lib/auth-tokens");
    const alice = verifyCredentials("alice", "password")!;
    const token = issueToken(alice);
    // 8h TTL bucketed to 1h — 10h is safely past expiry regardless of bucket rounding.
    vi.advanceTimersByTime(10 * 60 * 60 * 1000);
    const user = userForToken(token);
    expect(user).toBeNull();
    vi.useRealTimers();
  });

  it("is bound to MCP_RESOURCE (RFC 8707 audience binding)", async () => {
    // Changing the audience mid-flight (simulated here by re-importing with a
    // different env var) invalidates previously issued tokens — this is what
    // stops a token minted for one deployment from being replayed against another.
    vi.resetModules();
    process.env.MCP_RESOURCE_URL = "https://deploy-a.example.com/api/mcp";
    const { verifyCredentials } = await import("@/lib/auth");
    const { issueToken } = await import("@/lib/auth-tokens");
    const alice = verifyCredentials("alice", "password")!;
    const token = issueToken(alice);

    vi.resetModules();
    process.env.MCP_RESOURCE_URL = "https://deploy-b.example.com/api/mcp";
    const { userForToken } = await import("@/lib/auth-tokens");
    expect(userForToken(token)).toBeNull();

    delete process.env.MCP_RESOURCE_URL;
  });
});

describe("scopesForRole", () => {
  it("customer gets booking:read and booking:write only", async () => {
    const { scopesForRole } = await import("@/lib/auth");
    const scopes = scopesForRole("customer");
    expect(scopes).toContain("booking:read");
    expect(scopes).toContain("booking:write");
    expect(scopes).not.toContain("booking:support");
    expect(scopes).not.toContain("booking:admin");
  });

  it("admin gets all four scopes", async () => {
    const { scopesForRole } = await import("@/lib/auth");
    const scopes = scopesForRole("admin");
    expect(scopes).toContain("booking:read");
    expect(scopes).toContain("booking:write");
    expect(scopes).toContain("booking:support");
    expect(scopes).toContain("booking:admin");
  });

  it("support gets read, write, and support but not admin scope", async () => {
    const { scopesForRole } = await import("@/lib/auth");
    const scopes = scopesForRole("support");
    expect(scopes).toContain("booking:read");
    expect(scopes).toContain("booking:write");
    expect(scopes).toContain("booking:support");
    expect(scopes).not.toContain("booking:admin");
  });
});

describe("getUserById / listUsers", () => {
  it("known id returns the user", async () => {
    const { getUserById } = await import("@/lib/auth");
    const user = getUserById("u_alice");
    expect(user).not.toBeNull();
    expect(user!.username).toBe("alice");
  });

  it("unknown id returns null", async () => {
    const { getUserById } = await import("@/lib/auth");
    expect(getUserById("u_nobody")).toBeNull();
  });

  it("lists all three seeded demo users", async () => {
    const { listUsers } = await import("@/lib/auth");
    const users = listUsers();
    expect(users).toHaveLength(3);
    expect(users.map((u) => u.username).sort()).toEqual(["alice", "bob", "carol"]);
  });
});

// getOrProvisionUser is the fix for the login loop: it trusts an existing
// valid cookie, or mints a fresh alice/customer session on the spot.
describe("getOrProvisionUser", () => {
  function fakeCookieStore(initial?: string) {
    let value = initial;
    return {
      get: (name: string) => (name === "agentbridge_session" && value ? { value } : undefined),
      set: (_name: string, v: string) => { value = v; },
    };
  }

  it("provisions a fresh alice/customer session when no cookie exists", async () => {
    const { getOrProvisionUser } = await import("@/lib/auth-tokens");
    const store = fakeCookieStore();
    const { user, provisioned } = getOrProvisionUser(store);
    expect(provisioned).toBe(true);
    expect(user?.id).toBe("u_alice");
    expect(user?.role).toBe("customer");
    // The provisioned session must actually have been written back to the store.
    expect(store.get("agentbridge_session")).not.toBeUndefined();
  });

  it("trusts an existing valid cookie instead of re-provisioning", async () => {
    const { createSession } = await import("@/lib/auth-tokens");
    const { getOrProvisionUser } = await import("@/lib/auth-tokens");
    const { getUserById } = await import("@/lib/auth");
    const bob = getUserById("u_bob")!;
    const store = fakeCookieStore(createSession(bob));
    const { user, provisioned } = getOrProvisionUser(store);
    expect(provisioned).toBe(false);
    expect(user?.id).toBe("u_bob");
    expect(user?.role).toBe("admin");
  });

  it("DEMO_MODE=false disables auto-provisioning", async () => {
    vi.resetModules();
    process.env.DEMO_MODE = "false";
    const { getOrProvisionUser } = await import("@/lib/auth-tokens");
    const store = fakeCookieStore();
    const { user, provisioned } = getOrProvisionUser(store);
    expect(user).toBeNull();
    expect(provisioned).toBe(false);
    delete process.env.DEMO_MODE;
  });
});
