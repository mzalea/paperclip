import type {
  AdapterExecutionResult,
  ProviderQuotaResult,
} from "@paperclipai/adapter-utils";
import { asNumber } from "@paperclipai/adapter-utils/server-utils";
import { getQuotaWindows } from "./quota.js";

// Optional quota reserve: when `quotaReservePercent` is configured, the adapter
// refuses to start Codex once any provider quota window is at or above that
// line, leaving the remainder of a shared subscription for its owner. The
// refusal is a `provider_quota` failure with `retryNotBefore` at the window
// reset, so the server's existing quota retry path resumes the work later.
// Quota lookup failures fail open: the run proceeds and Codex's own quota
// errors remain the hard backstop.

const QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;
const QUOTA_LOOKUP_TIMEOUT_MS = 20_000;
const FALLBACK_RETRY_MS = 30 * 60 * 1000;

export interface QuotaReserveBlock {
  retryNotBefore: string;
  detail: string;
}

export function evaluateQuotaReserve(
  quota: ProviderQuotaResult,
  reservePercent: number,
  now: Date = new Date(),
): QuotaReserveBlock | null {
  const reached = quota.windows.filter(
    (window) =>
      typeof window.usedPercent === "number" &&
      window.usedPercent >= reservePercent,
  );
  if (reached.length === 0) return null;
  const resets = reached
    .map((window) => (window.resetsAt ? Date.parse(window.resetsAt) : NaN))
    .filter((time) => Number.isFinite(time) && time > now.getTime());
  // Wait for the latest reset: resuming at an earlier one would still find
  // the longer window over the line.
  const retryAt = resets.length > 0
    ? new Date(Math.max(...resets))
    : new Date(now.getTime() + FALLBACK_RETRY_MS);
  return {
    retryNotBefore: retryAt.toISOString(),
    detail: reached.map((window) => `${window.label} ${window.usedPercent}%`).join(", "),
  };
}

export function readQuotaReservePercent(config: Record<string, unknown>): number | null {
  const value = asNumber(config.quotaReservePercent, 0);
  return value > 0 && value < 100 ? value : null;
}

export function createQuotaReserveGate(
  fetchQuota: () => Promise<ProviderQuotaResult> = getQuotaWindows,
  now: () => number = Date.now,
) {
  let cache: { fetchedAt: number; result: ProviderQuotaResult } | null = null;

  async function readQuota(): Promise<ProviderQuotaResult> {
    const fetchedAt = now();
    if (cache && fetchedAt - cache.fetchedAt < QUOTA_CACHE_TTL_MS) return cache.result;
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const result = await Promise.race([
        fetchQuota(),
        new Promise<never>((_, reject) => {
          timeout = setTimeout(
            () => reject(new Error(`quota lookup timed out after ${QUOTA_LOOKUP_TIMEOUT_MS / 1000}s`)),
            QUOTA_LOOKUP_TIMEOUT_MS,
          );
        }),
      ]);
      if (result.ok) cache = { fetchedAt, result };
      return result;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  return async function checkQuotaReserve(
    config: Record<string, unknown>,
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>,
  ): Promise<AdapterExecutionResult | null> {
    const reservePercent = readQuotaReservePercent(config);
    if (reservePercent === null) return null;
    let quota: ProviderQuotaResult;
    try {
      quota = await readQuota();
    } catch (err) {
      await onLog("stderr", `[paperclip] Quota reserve check skipped: ${err instanceof Error ? err.message : String(err)}\n`);
      return null;
    }
    if (!quota.ok) {
      await onLog("stderr", `[paperclip] Quota reserve check skipped: ${quota.error ?? "quota unavailable"}\n`);
      return null;
    }
    const block = evaluateQuotaReserve(quota, reservePercent, new Date(now()));
    if (!block) return null;
    const errorMessage =
      `Codex quota reserve reached (${block.detail}; reserve ${reservePercent}%). ` +
      `Deferred until ${block.retryNotBefore}.`;
    await onLog("stderr", `[paperclip] ${errorMessage}\n`);
    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      errorMessage,
      retryNotBefore: block.retryNotBefore,
      provider: "openai",
      executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      resultJson: {
        errorFamily: "provider_quota",
        retryNotBefore: block.retryNotBefore,
        transientRetryNotBefore: block.retryNotBefore,
        providerQuotaRetryNotBefore: block.retryNotBefore,
        quotaReserve: { reservePercent, windows: block.detail },
      },
    };
  };
}
