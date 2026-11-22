import type { ConsoleEntry, NetworkEntry } from "./types";

// Browser-side ring buffers that run from page load, so that when a user hits
// "Report a bug" the last few minutes of console output and network traffic
// are already there. Installed once per page (idempotent — React strict mode
// and HMR re-run module code).

export const MAX_CONSOLE = 200;
export const MAX_NETWORK = 100;
export const MAX_ARG_CHARS = 2_000;
export const MAX_BODY_CHARS = 20_000;

/** Requests that are never recorded: the report submit itself (huge, and
 *  recursive), the 4s audit poll (pure noise — recentAudit covers it), and
 *  Next's dev-overlay requests. */
const IGNORED_URLS = [/\/api\/bug-report/, /\/api\/audit(\?|$)/, /\/__nextjs/, /\/_next\/static\/webpack\//];
/** Response keys whose values are secrets the bundle must never carry. */
const SECRET_KEYS = new Set(["agentToken", "token", "access_token", "refresh_token", "password"]);

interface CaptureState {
  console: ConsoleEntry[];
  network: NetworkEntry[];
  /** Full, unclipped, parsed `data` of the latest response per op name — used
   *  for provenance lookups only, never sent in the bundle as-is. */
  lastData: Map<string, unknown>;
  installed: boolean;
}

function state(): CaptureState {
  const g = globalThis as unknown as { __bugCapture?: CaptureState };
  return (g.__bugCapture ??= { console: [], network: [], lastData: new Map(), installed: false });
}

function push<T>(arr: T[], item: T, max: number) {
  arr.push(item);
  if (arr.length > max) arr.splice(0, arr.length - max);
}

export function clip(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) + `… [+${s.length - max} chars]` : s;
}

/** JSON.stringify that survives cycles, Errors, DOM nodes, and functions. */
export function safeStringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_k, v) => {
      if (typeof v === "function") return `[Function ${v.name || "anonymous"}]`;
      if (typeof v === "bigint") return v.toString();
      if (v instanceof Error) return { name: v.name, message: v.message };
      if (typeof Node !== "undefined" && v instanceof Node) return `[${v.nodeName}]`;
      if (v && typeof v === "object") {
        if (seen.has(v)) return "[Circular]";
        seen.add(v);
      }
      return v;
    }) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Replaces secret-looking keys anywhere in a JSON string. Non-JSON is returned as-is. */
export function redactJson(text: string): string {
  try {
    const parsed = JSON.parse(text);
    const walk = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === "object") {
        return Object.fromEntries(
          Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, SECRET_KEYS.has(k) ? "[redacted]" : walk(val)]),
        );
      }
      return v;
    };
    return JSON.stringify(walk(parsed));
  } catch {
    return text;
  }
}

export function recordConsole(level: ConsoleEntry["level"], args: unknown[], stack?: string) {
  push(state().console, {
    level,
    ts: new Date().toISOString(),
    message: clip(args.map(safeStringify).join(" "), MAX_ARG_CHARS),
    ...(stack ? { stack: clip(stack, MAX_ARG_CHARS) } : {}),
  }, MAX_CONSOLE);
}

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function parseOp(url: string, method: string, reqBody: string | undefined, resBody: string | undefined): NetworkEntry["op"] {
  if (method !== "POST" || !/\/api\/call(\?|$)/.test(url) || !reqBody) return undefined;
  try {
    const { name, params } = JSON.parse(reqBody) as { name?: string; params?: unknown };
    if (typeof name !== "string") return undefined;
    let success: boolean | null = null;
    let errorCode: string | undefined;
    if (resBody) {
      try {
        const r = JSON.parse(resBody) as { success?: boolean; error?: { code?: string } };
        success = typeof r.success === "boolean" ? r.success : null;
        errorCode = r.error?.code;
      } catch { /* truncated/non-JSON body */ }
    }
    return { name, params: params ?? {}, success, ...(errorCode ? { errorCode } : {}) };
  } catch {
    return undefined;
  }
}

export function installCapture(): void {
  if (typeof window === "undefined") return;
  const s = state();
  if (s.installed) return;
  s.installed = true;

  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      try { recordConsole(level, args); } catch { /* never break logging */ }
      original(...args);
    };
  }

  window.addEventListener("error", (e) => {
    recordConsole("error", [`Uncaught ${e.message}`, `${e.filename}:${e.lineno}:${e.colno}`], e.error?.stack);
  });
  window.addEventListener("unhandledrejection", (e) => {
    const reason = e.reason;
    recordConsole("error", ["Unhandled promise rejection:", reason], reason instanceof Error ? reason.stack : undefined);
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = urlOf(input);
    if (IGNORED_URLS.some((re) => re.test(url))) return originalFetch(input, init);

    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    const reqBody = typeof init?.body === "string" ? clip(redactJson(init.body), MAX_BODY_CHARS) : undefined;
    const started = performance.now();
    const ts = new Date().toISOString();
    try {
      const res = await originalFetch(input, init);
      // Read a clone so the caller still gets an unconsumed body.
      res.clone().text().then((text) => {
        const op = parseOp(url, method, init?.body as string | undefined, text);
        if (op?.success) {
          try { s.lastData.set(op.name, (JSON.parse(text) as { data?: unknown }).data); } catch { /* non-JSON */ }
        }
        push(s.network, {
          method, url, status: res.status, durationMs: Math.round(performance.now() - started), ts,
          ...(reqBody !== undefined ? { requestBody: reqBody } : {}),
          responseBody: clip(redactJson(text), MAX_BODY_CHARS),
          ...(op ? { op } : {}),
        }, MAX_NETWORK);
      }).catch(() => {});
      return res;
    } catch (err) {
      push(s.network, {
        method, url, status: null, durationMs: Math.round(performance.now() - started), ts,
        ...(reqBody !== undefined ? { requestBody: reqBody } : {}),
        error: err instanceof Error ? err.message : String(err),
        ...(() => { const op = parseOp(url, method, init?.body as string | undefined, undefined); return op ? { op } : {}; })(),
      }, MAX_NETWORK);
      throw err;
    }
  };
}

export function getConsoleLog(): ConsoleEntry[] {
  return [...state().console];
}

export function getNetworkLog(): NetworkEntry[] {
  return [...state().network];
}

/** Most recent successful-or-not /api/call entry for `opName`. */
export function findLastCall(opName: string): NetworkEntry | undefined {
  const net = state().network;
  for (let i = net.length - 1; i >= 0; i--) if (net[i].op?.name === opName) return net[i];
  return undefined;
}

/** Full `data` of the latest successful response of `opName`, if seen. */
export function lastDataFor(opName: string): { found: boolean; data?: unknown } {
  const m = state().lastData;
  return m.has(opName) ? { found: true, data: m.get(opName) } : { found: false };
}

/** Records a response without going through fetch — tests, and callers that
 *  already hold the parsed data. */
export function noteResponse(opName: string, data: unknown): void {
  state().lastData.set(opName, data);
}

/** Tests only. */
export function resetCapture(): void {
  const s = state();
  s.console.length = 0;
  s.network.length = 0;
  s.lastData.clear();
}
