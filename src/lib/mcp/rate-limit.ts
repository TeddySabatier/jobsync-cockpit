import { APP_CONSTANTS } from "@/lib/constants";

interface RateLimitEntry {
  count: number;
  resetTime: number;
}

const store = new Map<string, RateLimitEntry>();

const MAX = APP_CONSTANTS.MCP_RATE_LIMIT_MAX;
const WINDOW = APP_CONSTANTS.MCP_RATE_LIMIT_WINDOW_MS;
const CLEANUP_THRESHOLD = 500;

export interface McpRateLimitOptions {
  bucket?: string;
  max?: number;
  windowMs?: number;
  // Report whether a call would be allowed without spending a slot. Only
  // reliable if the caller spends synchronously afterwards (no await between).
  peek?: boolean;
}

// Without `opts` the key, limit and window are unchanged (existing callers).
// With `opts.bucket` the key is `<userId>:<bucket>`, an independent counter.
export function checkMcpRateLimit(
  userId: string,
  opts?: McpRateLimitOptions,
): {
  allowed: boolean;
  remaining: number;
  resetIn: number;
} {
  const now = Date.now();
  const key = opts?.bucket ? `${userId}:${opts.bucket}` : userId;
  const max = opts?.max ?? MAX;
  const windowMs = opts?.windowMs ?? WINDOW;

  if (store.size > CLEANUP_THRESHOLD) {
    for (const [key, entry] of store) {
      if (now > entry.resetTime) store.delete(key);
    }
  }

  const entry = store.get(key);

  if (opts?.peek) {
    if (!entry || now > entry.resetTime) {
      return { allowed: true, remaining: max, resetIn: windowMs };
    }
    return {
      allowed: entry.count < max,
      remaining: Math.max(0, max - entry.count),
      resetIn: entry.resetTime - now,
    };
  }

  if (!entry || now > entry.resetTime) {
    store.set(key, { count: 1, resetTime: now + windowMs });
    return { allowed: true, remaining: max - 1, resetIn: windowMs };
  }

  if (entry.count >= max) {
    return { allowed: false, remaining: 0, resetIn: entry.resetTime - now };
  }

  entry.count++;
  return { allowed: true, remaining: max - entry.count, resetIn: entry.resetTime - now };
}
