"use client";
import { logger } from "@/lib/logger";

import { useEffect, useState, useRef } from "react";
import { useRouter, usePathname } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { API_BASE_URL, apiFetch } from "@/lib/api";
import { devLog } from "@/lib/logger";
import { track, identify, setOrganization, resetAnalytics } from "@/lib/analytics";
import Link from "next/link";
import {
  Building2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Plus,
  LogOut,
  Sparkles,
  AlertCircle,
  X,
  Menu,
  Sun,
  Moon,
  Clock,
  Database,
  User,
  CreditCard,
  HelpCircle,
} from "lucide-react";
import { toast } from "sonner";
import { ProductTour } from "@/components/dashboard/ProductTour";
import { useProactiveAnalysis, clearStoredOutcome } from "@/hooks/useProactiveAnalysis";
import { retryAnalysis } from "@/services/businessService";
import { AnalysisOutcomeBanner } from "@/components/dashboard/AnalysisOutcomeBanner";

interface Workspace {
  id: string;
  name: string;
  slug: string;
  role: string;
}

import { NAV_ITEMS } from "@/config/navigation";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState<string | null>(null);

  // Re-attach identity and workspace scope on every app load. Google OAuth
  // users never pass through the login form, and a page refresh must not
  // orphan events from their organization.
  useEffect(() => {
    if (!activeWorkspaceId) return;
    let cancelled = false;
    (async () => {
      const { data } = await createClient().auth.getSession();
      if (cancelled || !data.session?.user?.id) return;
      identify(data.session.user.id);
      setOrganization(activeWorkspaceId);
    })();
    return () => { cancelled = true; };
  }, [activeWorkspaceId]);
  const [profile, setProfile] = useState<any>(null);
  const isExempt = profile?.email === "devottamkumar1310@gmail.com" || profile?.subscription_status === "founder";
  const [sessionToken, setSessionToken] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState(0);
  const [theme, setTheme] = useState("dark");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [isProfileMenuOpen, setIsProfileMenuOpen] = useState(false);
  const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
  const [newWorkspaceName, setNewWorkspaceName] = useState("");
  const [createLoading, setCreateLoading] = useState(false);
  const [demoLoading, setDemoLoading] = useState(false);
  const [showManualForm, setShowManualForm] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isSidebarCollapsed, setIsSidebarCollapsed] = useState(false);
  const [initError, setInitError] = useState<string | null>(null);
  const [isWakingUp, setIsWakingUp] = useState(false);
  const [isProvenanceModalOpen, setIsProvenanceModalOpen] = useState(false);
  
  const [bannerDismissed, setBannerDismissed] = useState(false);

  const DEMO_WORKSPACES = [
    { id: "demo-luma", slug: "luma", apiSlug: "luma", name: "Luma & Co." },
    { id: "demo-drift", slug: "drift", apiSlug: "drift", name: "Drift Collective" },
    { id: "demo-basecamp", slug: "basecamp", apiSlug: "basecamp", name: "Basecamp Basics" },
  ];

  const DEMO_NAME_MAP: Record<string, string> = {
    "luma": "Luma & Co.",
    "drift": "Drift Collective",
    "basecamp": "Basecamp Basics",
  };

  const handleSelectDemo = async (demoSlug: string) => {
    setIsDropdownOpen(false);
    // Use canonical name matching — immune to slug suffix drift
    const targetName = DEMO_NAME_MAP[demoSlug];
    const existing = targetName
      ? workspaces.find(w => w.name === targetName)
      : null;
    if (existing) {
      handleSwitchWorkspace(existing.id);
      return;
    }
    
    // Create on the fly
    setDemoLoading(true);
    setCreateError(null);
    try {
      const resp = await apiFetch(`${API_BASE_URL}/api/organization/onboard-demo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${sessionToken}`
        },
        body: JSON.stringify({ demo_company: demoSlug })
      });
      if (resp.ok) {
        const data = await resp.json();
        localStorage.setItem("active_workspace_id", data.organization_id);
        localStorage.setItem("eve_analysis_pending", "1");
        localStorage.setItem("eve_analysis_org_id", data.organization_id);
        // Same gap as the modal above: demo workspaces spun up from the
        // switcher emitted nothing. Fired before the reload discards it.
        track("demo_workspace_created", {
          source: "workspace_switcher",
          demo_company: demoSlug,
          workspace_id: data.organization_id,
        });
        window.location.reload();
      } else {
        const errData = await resp.json().catch(() => ({ detail: "Failed to create demo workspace" }));
        setCreateError(errData.detail || "Failed to create demo workspace");
      }
    } catch (e) {
      logger.error("Failed to create demo workspace on the fly", e);
      setCreateError("Demo environment is currently initializing. Please try again shortly.");
    } finally {
      setDemoLoading(false);
    }
  };


  const getRemainingDays = () => {
    if (!profile?.trial_end_date) return 0;
    const end = new Date(profile.trial_end_date);
    const now = new Date();
    const diffTime = end.getTime() - now.getTime();
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
    return Math.max(0, diffDays);
  };

  const router = useRouter();
  const pathname = usePathname();
  const sessionTokenRef = useRef(sessionToken);

  useEffect(() => {
    sessionTokenRef.current = sessionToken;
  }, [sessionToken]);

  // Load sidebar state on mount
  useEffect(() => {
    if (typeof window !== "undefined") {
      const saved = localStorage.getItem("sidebar_collapsed");
      if (saved === "true") {
        setIsSidebarCollapsed(true);
      }
    }
  }, []);

  // Proactive analysis runs silently in the background. The watcher renders
  // nothing and only surfaces a toast when the run finishes or fails, so the
  // user is never interrupted or made to wait on it.
  /**
   * Restarts a failed or timed-out analysis. Shared by the toast action and the
   * persistent banner so both routes behave identically.
   */
  const handleRetryAnalysis = () => {
    const orgId = localStorage.getItem("eve_analysis_org_id") || activeWorkspaceId;
    if (!orgId) return;
    clearStoredOutcome();
    retryAnalysis(sessionTokenRef.current, orgId)
      .then(() => {
        // Re-arm the watcher so the retried run is tracked like any other.
        localStorage.setItem("eve_analysis_pending", "1");
        localStorage.setItem("eve_analysis_org_id", orgId);
        window.dispatchEvent(new Event("eve_analysis_started"));
        toast.info("Analysis restarted", {
          description: "EVE is looking at your data again. You can keep working — we'll tell you when it's done.",
        });
      })
      .catch((e) => toast.error(e?.message || "Couldn't restart the analysis."));
  };

  useProactiveAnalysis({
    sessionToken,
    fallbackOrganizationId: activeWorkspaceId,
    onComplete: () => router.refresh(),
    onViewRecommendations: (destination) => {
      // The funnel's last step: the founder acted on a result rather than
      // merely having one rendered at them. recommendations_viewed measures
      // exposure; this measures intent.
      track("recommendation_clicked", { source: "analysis_toast", page: destination.href });
      router.push(destination.href);
    },
    onRetry: handleRetryAnalysis,
  });

  // Theme Sync on Mount — resolves 'system' to the actual OS preference.
  useEffect(() => {
    const resolveTheme = (stored: string): string => {
      if (stored === "system") {
        return window.matchMedia("(prefers-color-scheme: dark)").matches
          ? "dark"
          : "executive-light";
      }
      return stored;
    };

    let stored = localStorage.getItem("theme") || "executive-light";
    if (!["system", "executive-light", "dark"].includes(stored)) {
      stored = "executive-light";
      localStorage.setItem("theme", "executive-light");
    }

    const active = resolveTheme(stored);
    setTheme(stored); // store the raw value ("system" etc.)
    document.documentElement.setAttribute("data-theme", active);

    // Listen for OS preference changes when theme is set to 'system'
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const onOSChange = () => {
      if (localStorage.getItem("theme") === "system") {
        const resolved = mql.matches ? "dark" : "executive-light";
        document.documentElement.setAttribute("data-theme", resolved);
      }
    };
    mql.addEventListener("change", onOSChange);

    // Listen for custom settings theme-changed event
    const handleThemeEvent = () => {
      const updatedStored = localStorage.getItem("theme") || "executive-light";
      setTheme(updatedStored);
      const activeResolved = resolveTheme(updatedStored);
      document.documentElement.setAttribute("data-theme", activeResolved);
    };
    window.addEventListener("theme-changed", handleThemeEvent);

    return () => {
      mql.removeEventListener("change", onOSChange);
      window.removeEventListener("theme-changed", handleThemeEvent);
    };
  }, []);

  const getThemePreference = (profileData?: any): string => {
    if (profileData?.preferences?.theme) {
      return profileData.preferences.theme;
    }
    if (profile?.preferences?.theme) {
      return profile.preferences.theme;
    }
    if (typeof window !== "undefined") {
      return localStorage.getItem("theme") || "executive-light";
    }
    return "executive-light";
  };

  const setThemePreference = (newTheme: string) => {
    setTheme(newTheme);
    if (typeof window !== "undefined") {
      localStorage.setItem("theme", newTheme);
      // Resolve 'system' to the actual OS preference before applying to DOM
      const resolved =
        newTheme === "system"
          ? window.matchMedia("(prefers-color-scheme: dark)").matches
            ? "dark"
            : "executive-light"
          : newTheme;
      document.documentElement.setAttribute("data-theme", resolved);
      // Trigger event so other tabs/components sync theme immediately
      window.dispatchEvent(new Event("theme-changed"));
    }
  };

  const toggleSidebar = () => {
    const next = !isSidebarCollapsed;
    setIsSidebarCollapsed(next);
    localStorage.setItem("sidebar_collapsed", String(next));
  };

  const isActive = (href: string, exact?: boolean) => {
    if (exact) return pathname === href;
    return pathname.startsWith(href);
  };

  const loadWorkspacesAndProfile = async (token: string) => {
    // Use AbortController to enforce a 90-second timeout per request.
    // This accommodates Render free-tier cold starts while providing a deterministic ceiling.
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 90000);

    let profileSettled: PromiseSettledResult<Response>;
    let wsSettled: PromiseSettledResult<Response>;

    try {
      [profileSettled, wsSettled] = await Promise.allSettled([
        apiFetch(`${API_BASE_URL}/api/profile/me`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        }),
        apiFetch(`${API_BASE_URL}/api/organization/workspaces`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal,
        }),
      ]);
    } finally {
      clearTimeout(timeoutId);
    }

    // --- Handle profile result independently ---
    if (profileSettled.status === "fulfilled" && profileSettled.value.ok) {
      try {
        const profileData = await profileSettled.value.json();
        setProfile(profileData);
        const activeTheme = getThemePreference(profileData);
        setTheme(activeTheme);
        document.documentElement.setAttribute("data-theme", activeTheme);
      } catch (e) {
        logger.warn("[EVE] Failed to parse profile response:", e);
      }
    } else {
      const reason =
        profileSettled.status === "rejected"
          ? profileSettled.reason?.name === "AbortError"
            ? "Profile request timed out"
            : String(profileSettled.reason)
          : `Profile API returned ${profileSettled.value.status}`;
      logger.warn("[EVE] Profile load failed (non-fatal):", reason);
      // Dashboard still loads — profile fields show fallback values
    }

    // --- Handle workspaces result independently ---
    if (wsSettled.status === "fulfilled" && wsSettled.value.ok) {
      try {
        const wsData = await wsSettled.value.json();
        setWorkspaces(wsData);
        if (wsData.length === 0) {
          // Single retry after a brief delay to absorb async provisioning lag
          // (e.g. demo workspace DB commit not yet visible at query time).
          // One attempt only — no polling, no loops.
          devLog("[EVE] Workspaces empty on first fetch - retrying once after 1500ms");
          await new Promise<void>((resolve) => setTimeout(resolve, 1500));
          try {
            const retryRes = await apiFetch(`${API_BASE_URL}/api/organization/workspaces`, {
              headers: { Authorization: `Bearer ${token}` },
            });
            if (retryRes.ok) {
              const retryData: Workspace[] = await retryRes.json();
              if (retryData.length > 0) {
                devLog("[EVE] Retry succeeded - workspaces found:", retryData.length);
                setWorkspaces(retryData);
                const storedId = localStorage.getItem("active_workspace_id");
                if (storedId && retryData.some((w) => w.id === storedId)) {
                  setActiveWorkspaceId(storedId);
                } else {
                  localStorage.setItem("active_workspace_id", retryData[0].id);
                  setActiveWorkspaceId(retryData[0].id);
                }
                return;
              }
            }
          } catch (retryErr) {
            logger.warn("[EVE] Workspace retry fetch failed:", retryErr);
          }
          // Still empty after retry — user genuinely has no workspace.
          localStorage.removeItem("active_workspace_id");
          setActiveWorkspaceId(null);
          router.push("/onboarding");
          return;
        }
        const storedId = localStorage.getItem("active_workspace_id");
        if (storedId && wsData.some((w: Workspace) => w.id === storedId)) {
          setActiveWorkspaceId(storedId);
        } else if (wsData.length > 0) {
          localStorage.setItem("active_workspace_id", wsData[0].id);
          setActiveWorkspaceId(wsData[0].id);
        } else {
          localStorage.removeItem("active_workspace_id");
          setActiveWorkspaceId(null);
        }
      } catch (e) {
        logger.warn("[EVE] Failed to parse workspaces response:", e);
      }
    } else {
      if (wsSettled.status === "rejected") {
        if (wsSettled.reason?.name === "AbortError") {
          logger.error("[EVE] Workspaces load timed out after 90s");
          throw new Error("Connection timed out after 90 seconds. The server took too long to respond. Please retry.");
        }
        logger.error("[EVE] Workspaces load network error:", wsSettled.reason);
        throw new Error(String(wsSettled.reason?.message || "Cannot reach the server. Please check your internet connection."));
      } else {
        const status = wsSettled.value.status;
        if (status === 401 || status === 403) {
          logger.error(`[EVE] Workspaces load unauthorized: ${status}`);
          throw new Error(`Authentication error (${status}): Your session has expired. Please sign out and sign back in.`);
        }
        logger.error(`[EVE] Workspaces load failed with HTTP ${status}`);
        throw new Error(`API Error (${status}): Failed to load workspaces.`);
      }
    }
  };

  useEffect(() => {
    let mounted = true;
    async function init() {
      devLog("[TELEMETRY][PERF] Dashboard Layout Init Start");
      const tStart = performance.now();
      const supabase = createClient();
      setLoadingStage(1); // Authenticating
      
      const proceedWithSession = async (token: string) => {
        const tHydrate = performance.now();
        devLog(`[TELEMETRY][PERF] Session Hydration Start: ${(tHydrate - tStart).toFixed(2)}ms`);
        setSessionToken(token);
        sessionTokenRef.current = token;

        // Log end-to-end Google OAuth performance if initiated from login page
        if (typeof window !== "undefined") {
          const oauthClickTime = sessionStorage.getItem("oauth_click_time");
          if (oauthClickTime) {
            const totalEndToEnd = performance.now() - parseFloat(oauthClickTime);
            devLog(`[TELEMETRY][PERF] Total Google Sign-In Time (Click to Interactive): ${totalEndToEnd.toFixed(2)}ms`);
            sessionStorage.removeItem("oauth_click_time");
          }
        }

        // Fast-path: If user already has an active workspace stored, unblock dashboard IMMEDIATELY
        const storedWorkspaceId = typeof window !== "undefined" ? localStorage.getItem("active_workspace_id") : null;
        if (storedWorkspaceId) {
          setActiveWorkspaceId(storedWorkspaceId);
          if (mounted) setLoading(false);
          devLog(`[TELEMETRY][PERF] Dashboard Interactive (Fast Path): ${(performance.now() - tStart).toFixed(2)}ms`);
        }

        // Background sync & workspace/profile hydration (non-blocking for returning users)
        let wakingTimer: ReturnType<typeof setTimeout> | undefined;
        if (!storedWorkspaceId) {
          // Trigger non-blocking waking indicator after ~11 seconds (10-12s range)
          wakingTimer = setTimeout(() => {
            if (mounted) setIsWakingUp(true);
          }, 11000);
        }

        try {
          // Fire-and-forget sync so it never blocks dashboard rendering
          apiFetch(`${API_BASE_URL}/api/auth/sync`, {
            method: "POST",
            headers: { Authorization: `Bearer ${token}` }
          }).catch((syncErr) => logger.warn("[EVE Layout] Background auth sync warning:", syncErr));

          await loadWorkspacesAndProfile(token);
          if (mounted) setInitError(null);
        } catch (err: any) {
          logger.error("[EVE] Dashboard workspace/profile background load failed:", err);
          if (mounted && !storedWorkspaceId) {
            const msg: string = err?.message ?? "";
            let userMessage: string;
            if (msg.includes("timed out") || msg.includes("Timeout")) {
              userMessage = "Connection timed out after 90 seconds. Please check your network and retry.";
            } else if (msg.includes("Authentication error") || msg.includes("401") || msg.includes("403")) {
              userMessage = "Your session has expired. Please sign out and sign back in.";
            } else if (msg.includes("API Error")) {
              userMessage = msg;
            } else if (
              msg.includes("Failed to fetch") ||
              msg.includes("NetworkError") ||
              msg.includes("TypeError")
            ) {
              userMessage = "Cannot reach the server. Please check your internet connection.";
            } else {
              userMessage = msg || "Workspace initialization failed. Please retry or contact support.";
            }
            setInitError(userMessage);
          }
        } finally {
          if (wakingTimer) clearTimeout(wakingTimer);
          if (mounted) setIsWakingUp(false);
          const tFinish = performance.now();
          devLog(`[TELEMETRY][PERF] Workspace/Profile Hydration Complete: ${(tFinish - tHydrate).toFixed(2)}ms`);
          devLog(`[TELEMETRY][PERF] Total Dashboard Ready: ${(tFinish - tStart).toFixed(2)}ms`);
          if (mounted) setLoading(false);
        }
      };

      console.log("[EVE Layout] Calling getSession()...");
      const { data: { session } } = await supabase.auth.getSession();
      console.log("[EVE Layout] getSession() returned session:", session ? "YES" : "NO");
      
      if (session) {
        // Sprint 1 Fix #1: await so onAuthStateChange is registered only AFTER
        // the first init completes. This eliminates the double-invocation race
        // where both getSession() and the INITIAL_SESSION event trigger concurrent
        // loadWorkspacesAndProfile calls.
        console.log("[EVE Layout] Proceeding with session from getSession...");
        await proceedWithSession(session.access_token);
      }
      
      console.log("[EVE Layout] Registering onAuthStateChange...");
      const { data: { subscription } } = supabase.auth.onAuthStateChange((event, newSession) => {
        console.log("[EVE Layout] onAuthStateChange event:", event, "session:", newSession ? "YES" : "NO");
        // P2-A: TOKEN_REFRESHED is Supabase rotating the access token (typically every 60 min).
        // The workspace and profile data hasn't changed — only the token value.
        // Update the token references directly and skip the full workspace re-fetch.
        if (event === 'TOKEN_REFRESHED' && newSession) {
          sessionTokenRef.current = newSession.access_token;
          setSessionToken(newSession.access_token);
          return;
        }
        if (newSession && (!sessionTokenRef.current || sessionTokenRef.current !== newSession.access_token)) {
          proceedWithSession(newSession.access_token);
        } else if (!newSession && event === 'SIGNED_OUT') {
          router.push("/login");
        }
      });
      
      return () => {
        mounted = false;
        subscription.unsubscribe();
      };
    }
    
    const cleanup = init();
    return () => {
      cleanup.then(clean => clean && clean());
    };
  }, [router]);

  const handleSwitchWorkspace = (id: string) => {
    localStorage.setItem("active_workspace_id", id);
    setActiveWorkspaceId(id);
    setIsDropdownOpen(false);
    // When switching workspaces, we want a fresh bootstrap animation to load the new workspace assets/reasoning context
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("eve_initialized");
    }
    window.location.reload();
  };

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newWorkspaceName.trim()) return;
    setCreateLoading(true);
    setCreateError(null);
    try {
      const response = await apiFetch(`${API_BASE_URL}/api/organization/onboard`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ name: newWorkspaceName }),
      });
      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || "Failed to create workspace");
      }
      const data = await response.json();
      localStorage.setItem("active_workspace_id", data.organization_id);
      // Fired before the reload, which would otherwise discard it. Workspaces
      // created from inside the app were previously invisible in the funnel —
      // only the /onboarding path emitted this.
      track("workspace_created", { source: "in_app_modal", workspace_id: data.organization_id });
      setIsCreateModalOpen(false);
      setNewWorkspaceName("");
      window.location.reload();
    } catch {
      setCreateError("Workspace creation is currently synchronizing. Please try again.");
    } finally {
      setCreateLoading(false);
    }
  };

  // handleCreateDemoWorkspace removed — replaced by handleSelectDemo which
  // accepts a specific demo_company slug so the user lands on the workspace they chose.

  const handleLogout = async () => {
    const supabase = createClient();
    // Track before reset — reset() clears the distinct_id, so an event fired
    // afterwards would be attributed to a fresh anonymous person.
    track("logout_completed");
    resetAnalytics();
    await supabase.auth.signOut();
    // Intentionally DO NOT remove active_workspace_id from localStorage.
    // This ensures the user's workspace selection persists across logins.
    // The onboarding page and dashboard layout handle workspace restoration.
    if (typeof window !== "undefined") {
      sessionStorage.removeItem("eve_initialized");
    }
    router.push("/login");
  };

  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId);
  const isDemoWorkspace = activeWorkspace?.slug.startsWith("luma") || activeWorkspace?.slug.startsWith("drift") || activeWorkspace?.slug.startsWith("basecamp");

  if (loading || (!activeWorkspaceId && !initError)) {
    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 text-foreground font-sans">
        <div className="w-full max-w-sm bg-card backdrop-blur-md rounded-2xl border border-border p-8 shadow-2xl space-y-6 animate-fade-in">
          <div className="flex justify-center mb-2">
            <div className="h-14 w-14 bg-gradient-to-tr from-violet-700 to-purple-500 rounded-2xl flex items-center justify-center text-white font-bold text-2xl animate-pulse shadow-lg shadow-violet-600/30">
              EVE
            </div>
          </div>
          <div className="text-center space-y-1">
            <h3 className="text-lg font-bold tracking-tight">Initializing EVE AI OS</h3>
            <p className="text-xs text-muted-foreground">Setting up executive operations context</p>
          </div>
          
          <div className="space-y-3 pt-2">
            <div className="flex items-center gap-3 text-sm transition-all duration-300">
              {loadingStage >= 2 ? (
                <span className="text-violet-400 font-bold">✓</span>
              ) : (
                <div className="h-4 w-4 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
              )}
              <span className={loadingStage >= 2 ? "text-muted-foreground line-through decoration-violet-500/50" : "text-foreground font-medium"}>
                Authenticating session
              </span>
            </div>
            
            <div className="flex items-center gap-3 text-sm transition-all duration-300">
              {loadingStage >= 3 ? (
                <span className="text-violet-400 font-bold">✓</span>
              ) : loadingStage === 2 ? (
                <div className="h-4 w-4 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
              ) : (
                <div className="h-2 w-2 rounded-full bg-secondary ml-1" />
              )}
              <span className={loadingStage >= 3 ? "text-muted-foreground line-through decoration-violet-500/50" : loadingStage === 2 ? "text-foreground font-medium animate-pulse" : "text-muted-foreground"}>
                Loading active workspace
              </span>
            </div>
            
            <div className="flex items-center gap-3 text-sm transition-all duration-300">
              {loadingStage >= 4 ? (
                <span className="text-violet-400 font-bold">✓</span>
              ) : loadingStage === 3 ? (
                <div className="h-4 w-4 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
              ) : (
                <div className="h-2 w-2 rounded-full bg-secondary ml-1" />
              )}
              <span className={loadingStage >= 4 ? "text-muted-foreground line-through decoration-violet-500/50" : loadingStage === 3 ? "text-foreground font-medium animate-pulse" : "text-muted-foreground"}>
                Loading business metrics & datasets
              </span>
            </div>
            
            <div className="flex items-center gap-3 text-sm transition-all duration-300">
              {loadingStage === 4 ? (
                <div className="h-4 w-4 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
              ) : (
                <div className="h-2 w-2 rounded-full bg-secondary ml-1" />
              )}
              <span className={loadingStage === 4 ? "text-violet-300 font-semibold animate-pulse" : "text-muted-foreground"}>
                Preparing AI Executive portal...
              </span>
            </div>
          </div>

          {isWakingUp && (
            <div className="p-3 bg-violet-500/10 border border-violet-500/20 rounded-xl text-xs text-violet-300 text-center animate-fade-in flex items-center justify-center gap-2">
              <span className="inline-block w-2 h-2 rounded-full bg-violet-400 animate-ping" />
              <span>EVE is waking up. This can take up to a minute on the free tier…</span>
            </div>
          )}
        </div>
      </div>
    );
  }

  if (initError) {
    let title = "Connection Failed";
    let message = initError;

    if (initError.includes("Session expired") || initError.includes("Authentication error")) {
      title = "Authentication Required";
    } else if (initError.includes("API Error") || initError.includes("500")) {
      title = "Server Error";
    } else if (initError.includes("timed out")) {
      title = "Request Timeout";
    } else if (initError.includes("SERVER_INITIALIZING")) {
      title = "Starting Up";
    }

    return (
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-6 text-foreground font-sans">
        <div className="w-full max-w-sm bg-card backdrop-blur-md rounded-2xl border border-red-900/40 p-8 shadow-2xl space-y-6 animate-fade-in">
          <div className="flex justify-center mb-2">
            <div className="h-14 w-14 bg-gradient-to-tr from-red-700 to-rose-600 rounded-2xl flex items-center justify-center text-foreground font-bold text-2xl shadow-lg shadow-red-500/20">
              <AlertCircle size={28} />
            </div>
          </div>
          <div className="text-center space-y-2">
            <h3 className="text-lg font-bold tracking-tight text-red-400">{title}</h3>
            <p className="text-xs text-muted-foreground leading-relaxed">{message}</p>
          </div>
          <div className="space-y-3 pt-2">
            <button
              onClick={() => {
                setInitError(null);
                setLoading(true);
                setLoadingStage(1);
                if (typeof window !== "undefined") {
                  sessionStorage.removeItem("eve_initialized");
                }
                window.location.reload();
              }}
              className="w-full py-2.5 px-4 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-semibold transition-all shadow-md cursor-pointer"
            >
              Retry Connection
            </button>
            <button
              onClick={handleLogout}
              className="w-full py-2.5 px-4 bg-transparent border border-border hover:border-slate-500 text-muted-foreground hover:text-foreground rounded-xl text-sm font-medium transition-all cursor-pointer"
            >
              Sign Out
            </button>
            <p className="text-center text-[10px] text-muted-foreground pt-1">
              Support: <a href="mailto:support@eveinventory.in" className="hover:text-indigo-400 underline">support@eveinventory.in</a>
            </p>
          </div>
        </div>
      </div>
    );
  }

  const currentNav = NAV_ITEMS.flatMap((g) => g.items).find((it) => isActive(it.href, (it as any).exact));
  const currentPageLabel = currentNav?.label || "Dashboard";
  const initials = ((profile?.full_name || profile?.email || "U")
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((s: string) => s[0]?.toUpperCase())
    .join("")) || "U";

  return (
    // data-ph-mask makes the entire authenticated app render as placeholder
    // blocks in PostHog session replay. This is the privacy boundary: every
    // SKU name, quantity, financial figure and recommendation inside the
    // dashboard is masked by default, including in components that do not
    // exist yet. Marketing and auth pages stay full-fidelity, which is where
    // the conversion funnel actually needs to be watched.
    <div
      data-ph-mask
      className="eve-app min-h-screen bg-background text-foreground flex font-sans transition-colors duration-200"
    >
      {/* Mobile Backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-background z-30 md:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed top-0 left-0 h-full bg-sidebar text-sidebar-foreground border-r border-sidebar-border z-40 flex flex-col transition-all duration-200 eve-sidebar-atmosphere ${
 isSidebarCollapsed ? "w-60 md:w-16" : "w-60"
 } ${
 sidebarOpen ? "translate-x-0" : "-translate-x-full md:translate-x-0"
 }`}
      >
        {/* Sidebar Brand */}
        <div className={`flex items-center border-b border-sidebar-border transition-all ${
 isSidebarCollapsed ? "px-5 py-5 md:px-3 md:py-5 md:justify-center" : "gap-3 px-5 py-5"
 }`}>
          <div
            onClick={() => router.push("/dashboard")}
            className="h-9 w-9 bg-gradient-to-br from-violet-500 to-purple-600 rounded-xl flex items-center justify-center text-white font-bold text-[13px] tracking-tight cursor-pointer hover:brightness-110 transition-all shadow-lg shadow-violet-600/25 ring-1 ring-inset ring-white/15 flex-shrink-0"
          >
            EVE
          </div>
          <div className={`flex flex-col min-w-0 animate-fade-in ${isSidebarCollapsed ? "md:hidden block" : "block"}`}>
            <span className="font-semibold text-foreground text-sm tracking-tight leading-none">EVE</span>
            <span className="text-[10px] text-muted-foreground font-medium tracking-wide mt-1 leading-none">Inventory Intelligence</span>
          </div>
          
          <button
            onClick={toggleSidebar}
            className="ml-auto p-1 text-muted-foreground hover:text-foreground rounded-lg hover:bg-sidebar-accent transition-colors hidden md:block focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
            title={isSidebarCollapsed ? "Expand Sidebar" : "Collapse Sidebar"}
            aria-label={isSidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
          >
            {isSidebarCollapsed ? <ChevronRight size={15} /> : <ChevronLeft size={15} />}
          </button>

          <button
            onClick={() => setSidebarOpen(false)}
            className="ml-auto text-muted-foreground hover:text-muted-foreground md:hidden focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary rounded-lg p-1"
            aria-label="Close navigation menu"
          >
            <X size={16} />
          </button>
        </div>

        {/* Nav Items */}
        <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-6 scrollbar-none">
          {NAV_ITEMS.map((group) => (
            <div key={group.label}>
              <p className={`text-[10px] font-semibold text-muted-foreground uppercase tracking-[0.14em] px-2.5 mb-2 ${isSidebarCollapsed ? "md:hidden block" : "block"}`}>
                {group.label}
              </p>
              <div className={`h-px bg-sidebar-border my-4 ${isSidebarCollapsed ? "md:block hidden" : "hidden"}`} />
              <div className="space-y-0.5">
                {group.items.map((item) => {
                  const Icon = item.icon;
                  const active = isActive(item.href, (item as any).exact);
                  const isItemDisabled = !activeWorkspaceId && item.href !== "/dashboard/settings";
                  return (
                    <Link
                      key={item.href}
                      href={isItemDisabled ? "#" : item.href}
                      onClick={(e) => {
                        if (isItemDisabled) {
                          e.preventDefault();
                          return;
                        }
                        setSidebarOpen(false);
                      }}
                      title={isSidebarCollapsed ? item.label : undefined}
                      data-active={active && !isItemDisabled ? "true" : "false"}
                      className={`eve-nav-link flex items-center rounded-lg text-[13px] font-medium group ${
 isSidebarCollapsed ? "justify-start gap-2.5 px-2.5 py-2 md:justify-center md:p-2.5 md:mx-1" : "gap-2.5 px-2.5 py-2"
 } ${
 isItemDisabled
 ? "opacity-40 cursor-not-allowed text-muted-foreground pointer-events-none"
 : "text-muted-foreground hover:text-foreground"
 }`}
                    >
                      <Icon size={16} className={`flex-shrink-0 transition-colors ${active && !isItemDisabled ? "text-[color:var(--eve-nav-active-fg)]" : "text-muted-foreground group-hover:text-foreground"}`} />
                      <span className={`animate-fade-in ${isSidebarCollapsed ? "md:hidden block" : "block"}`}>{item.label}</span>
                      {(item as any).isAI && (
                        <span className={`ml-auto text-[8px] font-bold bg-violet-600 text-white px-1.5 py-0.5 rounded-full tracking-wider ${isSidebarCollapsed ? "md:hidden block" : "block"}`}>NEW</span>
                      )}
                    </Link>
                  );
                })}
              </div>
            </div>
          ))}
        </nav>

        {/* Sidebar Footer: Active Workspace */}
        <div className="px-4 py-4 border-t border-sidebar-border space-y-2">
          <div 
            className={`flex items-center rounded-lg bg-sidebar-accent/60 transition-all ${
 isSidebarCollapsed ? "justify-start gap-2 px-2 py-2 md:justify-center md:p-2" : "gap-2 px-2 py-2"
 }`}
            title={isSidebarCollapsed ? activeWorkspace?.name || "No workspace" : undefined}
          >
            <Building2 size={14} className="text-violet-400 flex-shrink-0" />
            <div className={`flex flex-col ${isSidebarCollapsed ? "md:hidden block" : "block"} truncate animate-fade-in`}>
              <span className="text-xs text-muted-foreground font-medium truncate">
                {activeWorkspace?.name || "No workspace"}
              </span>
              {(activeWorkspace?.slug.startsWith("luma") || activeWorkspace?.slug.startsWith("drift") || activeWorkspace?.slug.startsWith("basecamp")) && (
                <span className="text-[9px] text-blue-400 font-medium truncate mt-0.5">
                  Demo Workspace • Based on Public E-commerce Data
                </span>
              )}
            </div>
          </div>
          <div className={`text-[10px] text-muted-foreground text-center mt-1 leading-normal ${isSidebarCollapsed ? "md:hidden block" : "block"}`}>
            Support: <a href="mailto:support@eveinventory.in" className="hover:text-indigo-400 underline">support@eveinventory.in</a>
          </div>
        </div>
      </aside>

      {/* Main Content Area */}
      {/* min-w-0 overrides the flexbox default (min-width: auto), which otherwise lets a
          wide child (e.g. a data table) force this whole column past the viewport width
          instead of shrinking and letting the table's own overflow-x:auto handle it. */}
      <div className={`flex-1 flex flex-col min-w-0 transition-all duration-200 ${
 isSidebarCollapsed ? "md:ml-16" : "md:ml-60"
 }`}>
        {/* Top Header */}
        <header className="sticky top-0 z-20 w-full bg-sidebar border-b border-sidebar-border text-sidebar-foreground transition-colors duration-200 eve-header-atmosphere">
          <div className="px-4 py-3 flex items-center justify-between">
            {/* Mobile hamburger */}
            <button
              onClick={() => setSidebarOpen(true)}
              className="md:hidden p-2 text-muted-foreground hover:text-foreground hover:bg-sidebar-accent rounded-lg transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
              aria-label="Open navigation menu"
            >
              <Menu size={18} />
            </button>

            {/* Left: current section context */}
            <div className="hidden md:flex items-center min-w-0">
              <span className="text-sm font-semibold text-foreground truncate tracking-tight">{currentPageLabel}</span>
            </div>

            {/* Right: Workspace Switcher + User */}
            <div className="flex items-center gap-3">
              {/* Trial Status Badge */}
              {profile?.subscription_status === "trial" && !isExempt && (
                <div className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-violet-500/10 border border-violet-500/20 rounded-full text-[11px] font-semibold text-violet-400">
                  <Clock size={11} className="animate-pulse" />
                  <span>
                    {(() => {
                      const days = getRemainingDays();
                      if (days <= 0) return "Trial Ended";
                      return `${days} ${days === 1 ? "day" : "days"} left`;
                    })()}
                  </span>
                </div>
              )}
              
              {/* Dataset Provenance Badge */}
              {isDemoWorkspace && (
                <button
                  onClick={() => setIsProvenanceModalOpen(true)}
                  className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 bg-blue-500/10 border border-blue-500/20 hover:bg-blue-500/20 rounded-full text-[11px] font-semibold text-blue-700 dark:text-blue-300 transition-colors"
                >
                  <Database size={11} />
                  <span>Demo Dataset</span>
                </button>
              )}

              {/* Theme Toggler */}
              <button
                onClick={() => setThemePreference(theme === "dark" ? "executive-light" : "dark")}
                className="p-2 text-muted-foreground hover:text-violet-400 hover:bg-sidebar-accent rounded-lg transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                title={`Switch to ${theme === "dark" ? "Light" : "Dark"} Mode`}
                aria-label={theme === "dark" ? "Switch to light mode" : "Switch to dark mode"}
              >
                {theme === "dark" ? <Sun size={16} /> : <Moon size={16} />}
              </button>

              {/* Workspace Selector */}
              <div className="relative">
                <button
                  onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                  className="flex items-center gap-2 px-3 py-1.5 bg-sidebar-accent/80 hover:bg-sidebar-accent border border-sidebar-border rounded-lg text-sm font-medium text-sidebar-foreground transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                  aria-label="Switch workspace"
                  aria-expanded={isDropdownOpen}
                  aria-haspopup="listbox"
                >
                  <Building2 size={14} className="text-violet-400 flex-shrink-0" />
                  <div className="flex flex-col items-start max-w-[140px] truncate">
                    <span className="truncate w-full text-left">{activeWorkspace?.name || "Select Workspace"}</span>
                    {(activeWorkspace?.slug.startsWith("luma") || activeWorkspace?.slug.startsWith("drift") || activeWorkspace?.slug.startsWith("basecamp")) && (
                      <span className="text-[9px] text-blue-400 font-medium truncate w-full text-left leading-none">
                        Demo Workspace
                      </span>
                    )}
                  </div>
                  <ChevronDown size={12} className="text-muted-foreground flex-shrink-0" />
                </button>

                {isDropdownOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsDropdownOpen(false)} />
                    <div className="absolute right-0 mt-2 w-60 bg-sidebar border border-sidebar-border rounded-xl shadow-xl z-50 overflow-hidden text-sidebar-foreground">
                      <div className="p-3 border-b border-sidebar-border bg-sidebar-accent/30">
                        <span className="text-[10px] text-muted-foreground font-semibold tracking-wider uppercase">Demo Workspaces</span>
                      </div>
                      <div className="py-1">
                        {DEMO_WORKSPACES.map((ws) => {
                          const isMatch = activeWorkspace?.slug.startsWith(ws.slug);
                          return (
                            <button
                              key={ws.id}
                              onClick={() => handleSelectDemo(ws.apiSlug)}
                              className={`w-full text-left px-4 py-2 text-sm flex items-center justify-between hover:bg-sidebar-accent transition-colors ${
                                isMatch ? "text-violet-400 font-bold" : "text-sidebar-foreground"
                              }`}
                            >
                              <div className="flex flex-col items-start truncate max-w-[180px]">
                                <span className="truncate">{ws.name}</span>
                                <span className="text-[9px] text-blue-400 font-medium truncate mt-0.5">
                                  Demo Workspace
                                </span>
                              </div>
                              {isMatch && <div className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0" />}
                            </button>
                          );
                        })}
                      </div>

                      <div className="p-3 border-y border-sidebar-border bg-sidebar-accent/30 mt-2">
                        <span className="text-[10px] text-muted-foreground font-semibold tracking-wider uppercase">My Workspaces</span>
                      </div>
                      <div className="py-1 max-h-48 overflow-y-auto">
                        {workspaces.filter(w => !w.slug.startsWith("luma") && !w.slug.startsWith("drift") && !w.slug.startsWith("basecamp")).map((ws) => (
                          <button
                            key={ws.id}
                            onClick={() => handleSwitchWorkspace(ws.id)}
                            className={`w-full text-left px-4 py-2 text-sm flex items-center justify-between hover:bg-sidebar-accent transition-colors ${
                              ws.id === activeWorkspaceId ? "text-violet-400 font-bold" : "text-sidebar-foreground"
                            }`}
                          >
                            <div className="flex flex-col items-start truncate max-w-[180px]">
                              <span className="truncate">{ws.name}</span>
                            </div>
                            {ws.id === activeWorkspaceId && <div className="w-1.5 h-1.5 rounded-full bg-violet-400 flex-shrink-0" />}
                          </button>
                        ))}
                        {workspaces.filter(w => !w.slug.startsWith("luma") && !w.slug.startsWith("drift") && !w.slug.startsWith("basecamp")).length === 0 && (
                          <div className="px-4 py-3 text-sm text-muted-foreground italic">No personal workspaces</div>
                        )}
                      </div>
                      <div className="p-2 border-t border-sidebar-border">
                        <button
                          onClick={() => { setIsDropdownOpen(false); setIsCreateModalOpen(true); }}
                          className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-xs font-semibold transition-all"
                        >
                          <Plus size={12} /> Create Workspace
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>

              <div className="h-5 w-px bg-sidebar-border" />

              {/* Profile Dropdown */}
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setIsProfileMenuOpen(!isProfileMenuOpen)}
                  className="flex items-center gap-2.5 p-1 rounded-xl hover:bg-sidebar-accent transition-all cursor-pointer focus:outline-none"
                  aria-expanded={isProfileMenuOpen}
                  aria-label="User account menu"
                >
                  <div className="eve-avatar h-8 w-8 text-[11px] font-bold">{initials}</div>
                  <div className="hidden sm:flex flex-col leading-tight text-left">
                    <span className="text-xs font-semibold text-foreground leading-none">{profile?.full_name || "Guest"}</span>
                    <span className="text-[10px] text-muted-foreground mt-1 leading-none max-w-[120px] truncate">{profile?.email || ""}</span>
                  </div>
                  <ChevronDown size={12} className="text-muted-foreground hidden sm:block" />
                </button>

                {isProfileMenuOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setIsProfileMenuOpen(false)} />
                    <div className="absolute right-0 mt-2 w-56 bg-sidebar border border-sidebar-border rounded-xl shadow-xl z-50 overflow-hidden text-sidebar-foreground animate-fade-in">
                      <div className="p-3 border-b border-sidebar-border bg-sidebar-accent/30">
                        <p className="text-xs font-bold text-foreground truncate">{profile?.full_name || "Account"}</p>
                        <p className="text-[10px] text-muted-foreground truncate mt-0.5">{profile?.email || ""}</p>
                      </div>
                      <div className="py-1 text-xs">
                        <Link
                          href="/dashboard/settings"
                          onClick={() => setIsProfileMenuOpen(false)}
                          className="flex items-center gap-2.5 px-4 py-2 hover:bg-sidebar-accent transition-colors text-sidebar-foreground font-medium"
                        >
                          <User size={14} className="text-indigo-400" />
                          <span>Account Settings</span>
                        </Link>
                        <Link
                          href="/dashboard/billing"
                          onClick={() => setIsProfileMenuOpen(false)}
                          className="flex items-center gap-2.5 px-4 py-2 hover:bg-sidebar-accent transition-colors text-sidebar-foreground font-medium"
                        >
                          <CreditCard size={14} className="text-emerald-400" />
                          <span>Billing &amp; Plan</span>
                        </Link>
                        <Link
                          href="/dashboard/help"
                          onClick={() => setIsProfileMenuOpen(false)}
                          className="flex items-center gap-2.5 px-4 py-2 hover:bg-sidebar-accent transition-colors text-sidebar-foreground font-medium"
                        >
                          <HelpCircle size={14} className="text-amber-400" />
                          <span>Help &amp; Documentation</span>
                        </Link>
                      </div>
                      <div className="p-1 border-t border-sidebar-border">
                        <button
                          type="button"
                          onClick={() => {
                            setIsProfileMenuOpen(false);
                            handleLogout();
                          }}
                          className="w-full flex items-center gap-2.5 px-3 py-2 hover:bg-red-500/10 text-red-500 rounded-lg text-xs font-semibold transition-all cursor-pointer"
                        >
                          <LogOut size={14} />
                          <span>Sign Out</span>
                        </button>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 overflow-auto bg-background text-foreground transition-colors duration-200 eve-dashboard-main">
          {(() => {
            const days = getRemainingDays();
            const isTrialExpired = profile?.subscription_status === "trial" && days <= 0;
            const showSoftExpiry = isTrialExpired && !isExempt;
            
            const showPreExpiry = 
              profile?.subscription_status === "trial" && 
              !isExempt &&
              !bannerDismissed && 
              [7, 3, 1].includes(days);

            return (
              <>
                {showSoftExpiry && (
                  <div className="px-6 py-3.5 bg-gradient-to-r from-red-950/20 to-rose-950/20 border-b border-red-500/30 text-foreground flex flex-col sm:flex-row items-center justify-between gap-3 text-sm animate-fade-in z-20 relative">
                    <div className="flex items-center gap-2">
                      <AlertCircle size={16} className="text-red-400 flex-shrink-0" />
                      <span>
                        Your trial has ended. Please request a trial extension to restore access.
                      </span>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => {
                          window.location.href = "mailto:support@eveinventory.in?subject=EVE%20Trial%20Extension%20Request";
                        }}
                        className="px-3.5 py-1.5 bg-sidebar-accent border border-sidebar-border hover:bg-sidebar-accent/80 text-foreground text-xs font-semibold rounded-lg transition-all cursor-pointer"
                      >
                        Request Extension
                      </button>
                    </div>
                  </div>
                )}

                {showPreExpiry && (
                  <div className="px-6 py-3.5 bg-gradient-to-r from-indigo-900/20 to-purple-900/20 border-b border-indigo-500/20 text-foreground flex flex-col sm:flex-row items-center justify-between gap-3 text-sm animate-fade-in z-20 relative">
                    <div className="flex items-center gap-2">
                      <AlertCircle size={16} className="text-indigo-400 flex-shrink-0" />
                      <span>
                        Enjoying EVE? Paid plans are coming soon. <strong>{days} {days === 1 ? "day" : "days"} remaining</strong> on your trial.
                      </span>
                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => setBannerDismissed(true)}
                        className="p-1 hover:bg-sidebar-accent rounded text-muted-foreground hover:text-foreground cursor-pointer"
                      >
                        <X size={14} />
                      </button>
                    </div>
                  </div>
                )}

                {!activeWorkspaceId && pathname !== "/dashboard/settings" && pathname !== "/dashboard/help" ? (
                  <div className="flex-1 p-6 max-w-4xl mx-auto w-full space-y-6 flex flex-col justify-center min-h-[85vh]">
                    <div className="bg-card/80 backdrop-blur-md rounded-3xl border border-border shadow-2xl overflow-hidden p-8 md:p-12 text-center space-y-8 max-w-3xl mx-auto relative">
                      <div className="absolute -top-24 -left-24 w-48 h-48 bg-violet-500/10 rounded-full blur-3xl pointer-events-none" />
                      <div className="absolute -bottom-24 -right-24 w-48 h-48 bg-purple-500/10 rounded-full blur-3xl pointer-events-none" />
                      
                      <div className="flex justify-center">
                        <div className="h-20 w-20 bg-gradient-to-tr from-violet-700 to-purple-500 text-white rounded-2xl flex items-center justify-center shadow-lg shadow-violet-600/25 animate-pulse">
                          <Sparkles size={38} />
                        </div>
                      </div>
                      
                      <div className="space-y-3">
                        <h2 className="text-3xl md:text-4xl font-extrabold text-foreground tracking-tight">Welcome to EVE</h2>
                        <p className="text-muted-foreground text-sm md:text-base max-w-xl mx-auto leading-relaxed">
                          Your inventory forecasting and planning platform. Choose how you would like to begin exploring the platform.
                        </p>
                      </div>

                      {createError && (
                        <div className="p-4 bg-red-950/40 text-red-400 text-xs rounded-xl border border-red-800/50 text-left flex items-start gap-2 max-w-xl mx-auto">
                          <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                          <span>{createError}</span>
                        </div>
                      )}

                      {!showManualForm ? (
                        <div className="space-y-6 max-w-3xl mx-auto pt-4">
                          {/* Demo Workspace Scenario Selector */}
                          <div>
                            <p className="text-xs text-muted-foreground font-semibold uppercase tracking-wider mb-4">Choose a demo business to explore</p>
                            <div className="grid md:grid-cols-3 gap-4">
                              {[
                                { slug: "luma", name: "Luma & Co.", icon: "✦", color: "violet", scenario: "Growth Brand", focus: "Stockout Prevention", desc: "Premium womenswear growing fast. Hero products at risk of stockout — strong margins, zero dead stock." },
                                { slug: "drift", name: "Drift Collective", icon: "⚠", color: "amber", scenario: "Cash-Flow Crisis", focus: "Dead Stock Recovery", desc: "Streetwear brand with $92k locked in failed collab drops. Core line still selling." },
                                { slug: "basecamp", name: "Basecamp Basics", icon: "⚡", color: "emerald", scenario: "Seasonal Transition", focus: "Season Pivot", desc: "Unisex essentials caught between seasons. Summer selling out, winter stuck as dead stock." }
                              ].map((demo) => (
                                <button
                                  key={demo.slug}
                                  onClick={() => handleSelectDemo(demo.slug)}
                                  disabled={demoLoading || createLoading}
                                  className={`group relative flex flex-col text-left p-5 bg-background hover:bg-background border border-border hover:border-${demo.color}-500/40 rounded-2xl transition-all duration-300 shadow-lg hover:shadow-${demo.color}-500/10 cursor-pointer disabled:opacity-50 overflow-hidden`}
                                >
                                  {demoLoading && (
                                    <div className="absolute inset-0 bg-background/90 backdrop-blur-xs flex items-center justify-center z-10">
                                      <div className="flex flex-col items-center gap-2">
                                        <div className="h-6 w-6 rounded-full border-2 border-violet-500/30 border-t-violet-500 animate-spin" />
                                        <span className="text-[10px] text-violet-400 font-semibold animate-pulse">Creating workspace...</span>
                                      </div>
                                    </div>
                                  )}
                                  <div className="text-2xl mb-3">{demo.icon}</div>
                                  <h4 className="text-sm font-bold text-foreground mb-1">{demo.name}</h4>
                                  <span className={`text-[10px] font-semibold uppercase tracking-wider text-${demo.color}-400 mb-2`}>{demo.scenario} · {demo.focus}</span>
                                  <p className="text-muted-foreground text-xs leading-relaxed flex-1">{demo.desc}</p>
                                  <div className={`mt-4 pt-3 border-t border-border flex items-center text-[11px] font-semibold text-${demo.color}-400`}>
                                    Launch {demo.name} &rarr;
                                  </div>
                                </button>
                              ))}
                            </div>
                          </div>

                          {/* Separator */}
                          <div className="flex items-center gap-4 max-w-xl mx-auto">
                            <div className="flex-1 h-px bg-border" />
                            <span className="text-[10px] text-muted-foreground uppercase tracking-widest">or</span>
                            <div className="flex-1 h-px bg-border" />
                          </div>

                          {/* Create Own Workspace */}
                          <div className="flex justify-center">
                            <button
                              onClick={() => setShowManualForm(true)}
                              disabled={demoLoading || createLoading}
                              className="flex items-center gap-2 px-5 py-2.5 text-xs font-semibold text-muted-foreground hover:text-foreground border border-border hover:border-purple-500/40 rounded-xl transition-all cursor-pointer disabled:opacity-50"
                            >
                              <Plus size={14} />
                              Create My Own Workspace
                            </button>
                          </div>
                        </div>
                      ) : (
                        <div className="max-w-md mx-auto space-y-4 pt-2">
                          <div className="text-left mb-2">
                            <button
                              onClick={() => setShowManualForm(false)}
                              className="text-xs text-muted-foreground hover:text-muted-foreground flex items-center gap-1 transition-colors"
                            >
                              &larr; Back to options
                            </button>
                          </div>
                          <form onSubmit={handleCreateWorkspace} className="space-y-4 text-left">
                            <div>
                              <label className="block text-xs font-bold text-muted-foreground uppercase tracking-wider mb-2">Workspace / Brand Name</label>
                              <input
                                type="text"
                                required
                                value={newWorkspaceName}
                                onChange={(e) => setNewWorkspaceName(e.target.value)}
                                placeholder="e.g. Acme Clothing"
                                className="w-full px-4 py-2.5 bg-background border border-border rounded-xl text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 text-sm placeholder-slate-600"
                              />
                            </div>
                            <button
                              type="submit"
                              disabled={createLoading || !newWorkspaceName.trim()}
                              className="w-full flex justify-center items-center py-2.5 px-4 bg-violet-600 hover:bg-violet-700 text-white rounded-xl text-sm font-semibold transition-all shadow-md disabled:opacity-50 cursor-pointer"
                            >
                              {createLoading ? "Creating Workspace..." : "Create Workspace"}
                            </button>
                          </form>
                        </div>
                      )}
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Keeps the last analysis result on screen after its toast
                        has gone, so a merchant who was on another tab still
                        finds it. Renders nothing when there is nothing to say. */}
                    <AnalysisOutcomeBanner
                      onView={(href) => {
                        track("recommendation_clicked", { source: "analysis_banner", page: href });
                        router.push(href);
                      }}
                      onRetry={handleRetryAnalysis}
                    />
                    {children}
                  </>
                )}
              </>
            );
          })()}
        </main>
      </div>

      {/* Create Workspace Modal */}
      {isCreateModalOpen && (
        <div className="fixed inset-0 bg-background backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md bg-card text-card-foreground rounded-2xl shadow-2xl border border-border overflow-hidden">
            <div className="px-6 py-4 border-b border-border flex items-center justify-between">
              <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                <Building2 className="text-indigo-600" size={20} /> Create New Workspace
              </h3>
              <button onClick={() => setIsCreateModalOpen(false)} className="p-1 rounded-lg hover:bg-sidebar-accent text-muted-foreground">
                <X size={18} />
              </button>
            </div>
            <form onSubmit={handleCreateWorkspace} className="p-6 space-y-4">
              {createError && (
                <div className="p-3 bg-red-50 text-red-700 text-xs rounded-lg border border-red-200 flex items-start gap-2">
                  <AlertCircle size={16} className="mt-0.5 flex-shrink-0" />
                  <span>{createError}</span>
                </div>
              )}
              <div>
                <label className="block text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Workspace / Brand Name</label>
                <input
                  type="text"
                  required
                  value={newWorkspaceName}
                  onChange={(e) => setNewWorkspaceName(e.target.value)}
                  placeholder="e.g. Acme Fashion Corp"
                  className="w-full px-3 py-2 bg-background border border-border rounded-lg text-foreground focus:outline-none focus:ring-2 focus:ring-violet-500/20 focus:border-violet-500 text-sm"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button type="button" onClick={() => setIsCreateModalOpen(false)} className="px-4 py-2 border border-border text-foreground hover:bg-sidebar-accent rounded-lg text-sm font-semibold">
                  Cancel
                </button>
                <button type="submit" disabled={createLoading || !newWorkspaceName.trim()} className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
                  {createLoading ? "Creating..." : "Create Workspace"}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Dataset Provenance Modal */}
      {isProvenanceModalOpen && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="w-full max-w-md bg-card text-card-foreground rounded-2xl shadow-2xl border border-border overflow-hidden animate-fade-in">
            <div className="px-6 py-4 border-b border-border flex items-center justify-between bg-sidebar-accent/30">
              <h3 className="text-lg font-bold text-foreground flex items-center gap-2">
                <Database className="text-blue-500" size={20} /> Dataset Information
              </h3>
              <button onClick={() => setIsProvenanceModalOpen(false)} className="p-1 rounded-lg hover:bg-sidebar-accent text-muted-foreground transition-colors">
                <X size={18} />
              </button>
            </div>
            <div className="p-6 space-y-4 text-sm text-muted-foreground">
              <p className="font-semibold text-foreground">
                Based on a real publicly available e-commerce dataset and transformed into realistic fashion inventory businesses for demonstration purposes.
              </p>
              <div className="space-y-2">
                <div className="flex justify-between border-b border-border pb-2">
                  <span>Dataset</span>
                  <span className="font-medium text-foreground text-right w-2/3">Olist Brazilian E-Commerce Public Dataset</span>
                </div>
                <div className="flex justify-between border-b border-border pb-2">
                  <span>Source</span>
                  <span className="font-medium text-foreground text-right w-2/3">Official Olist Public Dataset</span>
                </div>
                <div className="flex justify-between border-b border-border pb-2">
                  <span>License</span>
                  <span className="font-medium text-foreground text-right w-2/3">Open-source (CC BY-NC-SA 4.0)</span>
                </div>
                <div className="flex justify-between border-b border-border pb-2">
                  <span>Purpose</span>
                  <span className="font-medium text-foreground text-right w-2/3">Adapted into realistic fashion inventory businesses to demonstrate EVE's Inventory Intelligence capabilities.</span>
                </div>
                <div className="flex justify-between pb-2">
                  <span>Transformations</span>
                  <span className="font-medium text-foreground text-right w-2/3 leading-tight">Product categorization, Inventory reconstruction, Lead time estimation, Financial aggregation, Recommendation generation, Business scenario simulation.</span>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-border bg-sidebar-accent/30 flex justify-end">
              <button onClick={() => setIsProvenanceModalOpen(false)} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-semibold transition-all shadow-md">
                Got it
              </button>
            </div>
          </div>
        </div>
      )}
      

      

      {activeWorkspaceId && <ProductTour />}
    </div>
  );
}
