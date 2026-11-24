import { describe, it, expect } from "vitest";
import { ok, fail, invalidInput } from "@/lib/result";
import type { Result } from "@/lib/result";

describe("ok", () => {
  it("wraps a value in a success shape", () => {
    const r = ok("hello");
    expect(r).toEqual({ success: true, data: "hello" });
  });

  it("sets success: true", () => {
    expect(ok(42).success).toBe(true);
  });

  it("preserves the data property", () => {
    const data = { id: 1, name: "test" };
    expect(ok(data).data).toEqual(data);
  });

  it("handles null as data", () => {
    const r = ok(null);
    expect(r).toEqual({ success: true, data: null });
  });

  it("handles 0 as data", () => {
    const r = ok(0);
    expect(r).toEqual({ success: true, data: 0 });
  });

  it("handles false as data", () => {
    const r = ok(false);
    expect(r).toEqual({ success: true, data: false });
  });

  it("handles empty object as data", () => {
    const r = ok({});
    expect(r).toEqual({ success: true, data: {} });
  });

  it("does not have an error property", () => {
    const r = ok("value");
    expect("error" in r).toBe(false);
  });
});

describe("fail", () => {
  it("wraps code and message in a failure shape, with the catalogue's retryable and hint", () => {
    const r = fail("NOT_FOUND", "Resource not found");
    expect(r).toEqual({
      success: false,
      error: { code: "NOT_FOUND", message: "Resource not found", retryable: false, hint: expect.any(String) },
    });
  });

  it("domain codes default to retryable: false with no hint", () => {
    expect(fail("NO_AVAILABILITY", "full").error).toEqual({ code: "NO_AVAILABILITY", message: "full", retryable: false });
  });

  it("HANDLER_ERROR and INSUFFICIENT_CREDITS are retryable; HANDLER_TIMEOUT is not", () => {
    expect(fail("HANDLER_ERROR", "boom").error.retryable).toBe(true);
    expect(fail("INSUFFICIENT_CREDITS", "wait").error.retryable).toBe(true);
    expect(fail("HANDLER_TIMEOUT", "slow").error.retryable).toBe(false);
  });

  it("extra fields override the catalogue and empty arrays are dropped", () => {
    const e = fail("NOT_FOUND", "x", { retryable: true, hint: "h", suggestions: [], details: [], requestId: "r1", callId: "c1" }).error;
    expect(e).toEqual({ code: "NOT_FOUND", message: "x", retryable: true, hint: "h", requestId: "r1", callId: "c1" });
  });

  it("invalidInput turns Zod issues into details and a path-prefixed message", () => {
    const e = invalidInput([{ path: ["a", 0], message: "bad" }, { path: [], message: "root" }]).error;
    expect(e.code).toBe("INVALID_INPUT");
    expect(e.details).toEqual([{ path: "a.0", message: "bad" }, { path: "", message: "root" }]);
    expect(e.message).toBe("a.0: bad; root");
  });

  it("sets success: false", () => {
    expect(fail("ERR", "msg").success).toBe(false);
  });

  it("preserves code", () => {
    const r = fail("VALIDATION_FAILED", "bad input");
    expect(r.error.code).toBe("VALIDATION_FAILED");
  });

  it("preserves message", () => {
    const r = fail("ERR", "something went wrong");
    expect(r.error.message).toBe("something went wrong");
  });

  it("handles empty string code", () => {
    const r = fail("", "msg");
    expect(r.error.code).toBe("");
  });

  it("handles empty string message", () => {
    const r = fail("CODE", "");
    expect(r.error.message).toBe("");
  });

  it("does not have a data property", () => {
    const r = fail("ERR", "msg");
    expect("data" in r).toBe(false);
  });

  it("has a nested error object", () => {
    const r = fail("ERR", "msg");
    expect(typeof r.error).toBe("object");
    expect(r.error).not.toBeNull();
  });
});

describe("type narrowing", () => {
  it("narrows to data on success branch", () => {
    const r: Result<number> = ok(99);
    if (r.success) {
      // TypeScript knows r.data is number here
      expect(r.data).toBe(99);
    } else {
      throw new Error("Should have been success");
    }
  });

  it("narrows to error on failure branch", () => {
    const r: Result<number> = fail("ERR", "oops");
    if (!r.success) {
      expect(r.error.code).toBe("ERR");
      expect(r.error.message).toBe("oops");
    } else {
      throw new Error("Should have been failure");
    }
  });

  it("ok and fail produce distinct shapes", () => {
    const success = ok("yes");
    const failure = fail("NO", "nope");
    expect(success.success).not.toBe(failure.success);
  });

  it("ok result has no error key; fail result has no data key", () => {
    const success = ok(1);
    const failure = fail("X", "y");
    expect(Object.keys(success)).not.toContain("error");
    expect(Object.keys(failure)).not.toContain("data");
  });
});
