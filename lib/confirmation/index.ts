// Server confirmation tokens (NavWebMcp 2.6.0). Importing this module from a
// server entry point installs it for execute() via ./port.ts.
//
// The key is CONFIRMATION_SECRET, else AUTH_SECRET, so every instance signs and
// checks with the same one. "Used once" lives in Redis when configured (SET NX
// with the token's remaining lifetime), so two instances can't both accept the
// same token. Without Redis, or while it is down, the per-process map in
// ./port.ts is used: the same fail-open trade-off as the rest of shared state.
import { getRedis } from "@/lib/shared-state/redis";
import { hmacSigner, importHmacKey, installConfirmation, memoryConfirmationPort, type ConfirmationPort } from "./port";

export * from "./port";

function secret(): string {
  return process.env.CONFIRMATION_SECRET ?? process.env.AUTH_SECRET ?? "agentbridge-demo-insecure-confirmation-key";
}

function redisKey(nonce: string): string {
  return `webmcp:confirm:${process.env.VERCEL_ENV ?? "dev"}:${nonce}`;
}

function redisTimeoutMs(): number {
  const n = Number(process.env.CONFIRMATION_REDIS_TIMEOUT_MS);
  return Number.isFinite(n) && n > 0 ? n : 500;
}

function timed<T>(p: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`redis took over ${redisTimeoutMs()} ms`)), redisTimeoutMs());
  });
  return Promise.race([p, t]).finally(() => clearTimeout(timer));
}

let signer: ((payload: string) => Promise<string>) | undefined;
let signerSecret: string | undefined;

export const serverConfirmationPort: ConfirmationPort = {
  sign(payload) {
    // Re-derived if the secret changes (tests set it per case).
    const s = secret();
    if (!signer || signerSecret !== s) {
      signer = hmacSigner(importHmacKey(s));
      signerSecret = s;
    }
    return signer(payload);
  },
  async consumeOnce(nonce, ttlMs) {
    const r = await getRedis().catch(() => null);
    if (r) {
      try {
        const set = await timed(r.set(redisKey(nonce), "1", { NX: true, PX: Math.max(1, Math.ceil(ttlMs)) }));
        return set === "OK";
      } catch (err) {
        console.warn("[confirmation] redis failed, using in-process store:", (err as Error)?.message ?? err);
      }
    }
    return memoryConfirmationPort.consumeOnce(nonce, ttlMs);
  },
};

installConfirmation(serverConfirmationPort);
