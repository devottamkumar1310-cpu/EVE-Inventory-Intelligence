import { logger } from "@/lib/logger";
import { devLog } from "@/lib/logger";

function sanitizeApiUrl(raw: string | undefined): string {
  if (!raw) return "";
  const url = raw
    .replace(/^\uFEFF/, "")                  // Strip UTF-8 Byte Order Mark (BOM)
    .replace(/[\u200B-\u200D\uFEFF]/g, "") // Strip zero-width spaces
    .trim()
    .replace(/^["']|["']$/g, "")           // Strip surrounding quotes
    .trim()
    .replace(/\/+$/, "")                   // Strip trailing slashes
    .replace(/\/api$/, "");                // Strip trailing /api
  return url;
}

function resolveApiBaseUrl(): string {
  const envUrl = sanitizeApiUrl(process.env.NEXT_PUBLIC_API_URL);

  // Hard-reject the old suspended Cloud Run URL if it's injected by Vercel
  if (envUrl && envUrl.includes("eve-backend-68416570138.us-central1.run.app")) {
    return "https://eve-backend-264f.onrender.com";
  }

  // Allow valid overrides (e.g. localhost, local network testing)
  if (envUrl && (envUrl.startsWith("http://") || envUrl.startsWith("https://"))) {
    return envUrl;
  }

  // Default fallbacks
  if (typeof window !== "undefined") {
    if (window.location.hostname !== "localhost" && window.location.hostname !== "127.0.0.1") {
      return "https://eve-backend-264f.onrender.com";
    }
    return "http://127.0.0.1:8000";
  }

  return "https://eve-backend-264f.onrender.com";
}

export const API_BASE_URL = resolveApiBaseUrl();

if (typeof window !== "undefined") {
  devLog(`[EVE Config] API Base URL resolved to: ${API_BASE_URL}`);
}
import { toast } from "sonner";

/**
 * Centralized fetch wrapper for authenticated API calls.
 *
 * Intercepts HTTP 401 responses globally:
 * - Signs the user out via Supabase to invalidate the local session.
 * - Redirects to /login with a human-readable "session expired" message.
 * - Throws immediately so the calling service never receives a partial response.
 *
 * Also intercepts 503 SERVER_INITIALIZING responses:
 * - Retries automatically with bounded exponential backoff for up to 60s.
 * - Respects the Retry-After header if present.
 * - Shows a "EVE is starting up. Please wait..." toast while waiting.
 *
 * All other responses are passed through unchanged.
 */
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function apiFetch(url: string, options: RequestInit = {}): Promise<Response> {
  const MAX_RETRY_TIME_MS = 60000;
  const startTime = Date.now();
  let attempt = 0;
  let initToastId: string | number | null = null;

  while (true) {
    attempt++;
    const res = await fetch(url, options);

    // 1. Handle 503 SERVER_INITIALIZING
    if (res.status === 503) {
      let isInitializing = false;
      try {
        const clone = res.clone();
        const data = await clone.json();
        if (data && data.code === "SERVER_INITIALIZING") {
          isInitializing = true;
        }
      } catch (e) {
        // Not JSON or unable to parse, ignore
      }

      if (isInitializing) {
        const elapsed = Date.now() - startTime;
        if (elapsed < MAX_RETRY_TIME_MS) {
          // Show toast on first retry
          if (!initToastId && typeof window !== "undefined") {
            initToastId = toast.loading("EVE is starting up. Please wait...", {
              duration: MAX_RETRY_TIME_MS,
            });
          }

          // Default bounded exponential backoff (max 10s)
          let waitMs = Math.min(1000 * Math.pow(1.5, attempt - 1), 10000);
          
          // Respect Retry-After if present
          const retryAfterHeader = res.headers.get("Retry-After");
          if (retryAfterHeader) {
            const parsed = parseInt(retryAfterHeader, 10);
            if (!isNaN(parsed) && parsed > 0) {
              waitMs = parsed * 1000;
            }
          }

          await sleep(waitMs);
          continue; // Retry the request
        } else {
          // Exhausted the 60s window, clear toast and let caller handle the 503
          if (initToastId && typeof window !== "undefined") {
            toast.dismiss(initToastId);
          }
          return res;
        }
      }
    }

    // Dismiss toast if we got a successful/non-503 response after retrying
    if (initToastId && typeof window !== "undefined") {
      toast.dismiss(initToastId);
    }

    // 2. Handle 401 Unauthorized
    if (res.status === 401) {
      logger.warn("[EVE] 401 Unauthorized — session expired. Signing out.");
      try {
        // Dynamically import to avoid circular dependency with supabase client.
        const { createClient } = await import("@/lib/supabase/client");
        await createClient().auth.signOut();
      } catch (e) {
        logger.error("[EVE] signOut failed during 401 redirect:", e);
      }
      // Redirect to login. Using window.location.href to guarantee a full page
      // reload which clears all in-memory React state.
      if (typeof window !== "undefined") {
        window.location.href = "/login?message=Session+expired.+Please+sign+in+again.";
      }
      throw new Error("Session expired. Please sign in again.");
    }
    
    return res;
  }
}
