"use client";
import { logger } from "@/lib/logger";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Building2, ArrowRight, Sparkles, Brain, Loader2 } from "lucide-react";
import { API_BASE_URL, apiFetch } from "@/lib/api";
import { AuthShell } from "@/components/auth/AuthShell";
import { track, setOrganization } from "@/lib/analytics";
import { trackAuthCompletion } from "@/lib/authEvents";

export default function OnboardingPage() {
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadingDemo, setLoadingDemo] = useState(false);
  const [loadingDemoKey, setLoadingDemoKey] = useState<string | null>(null);
  const [showManualForm, setShowManualForm] = useState(false);
  const router = useRouter();

  useEffect(() => {
    const supabase = createClient();
    // Check if user already has workspaces — if so, skip onboarding entirely
    async function checkWorkspace() {
      const { data: { session } } = await createClient().auth.getSession();
      if (!session) {
        router.push("/login");
        return;
      }

      // Google OAuth users never pass through the signup page, so this is the
      // first point at which we can attach a stable identity to their events —
      // and the only place that can tell a new account from a returning one.
      // Emits identify plus exactly one of signup_completed / login_completed.
      trackAuthCompletion(session);

      try {
        const response = await apiFetch(`${API_BASE_URL}/api/organization/workspaces`, {
          headers: {
            "Authorization": `Bearer ${session.access_token}`
          }
        });
        
        // /demo sends founders here with ?demo=luma so the live workspace opens
        // in one click instead of making them choose a brand they don't know.
        // Read from location rather than useSearchParams to avoid forcing a
        // Suspense boundary around this client page.
        const requestedDemo =
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("demo")
            : null;

        if (response.ok) {
          const workspaces = await response.json();
          if (requestedDemo && (!Array.isArray(workspaces) || workspaces.length === 0)) {
            await handleCreateDemoWorkspace(requestedDemo);
            return;
          }
          if (Array.isArray(workspaces) && workspaces.length > 0) {
            // User already has workspaces — restore active workspace and skip onboarding
            const storedId = localStorage.getItem("active_workspace_id");
            if (storedId && workspaces.some((w: any) => w.id === storedId)) {
              // Stored workspace still valid
            } else {
              // Restore to first available workspace
              localStorage.setItem("active_workspace_id", workspaces[0].id);
            }
            router.push("/dashboard/inventory");
          }
        }
      } catch (e) {
        logger.error("Failed to check workspace", e);
      }
    }
    
    checkWorkspace();
  }, [router]);

  const handleCreateWorkspace = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    
    try {
      const { data: { session } } = await createClient().auth.getSession();
      
      if (!session) {
        router.push("/login");
        return;
      }

      const response = await apiFetch(`${API_BASE_URL}/api/organization/onboard`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ name: workspaceName })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || "Failed to create workspace");
      }

      const data = await response.json();
      localStorage.setItem("active_workspace_id", data.organization_id);
      setOrganization(data.organization_id);
      track("workspace_created", { source: "blank", workspace_id: data.organization_id });
      track("onboarding_completed", { source: "blank" });
      // Fires here rather than at signup: this is the one point every trial
      // passes through, whether the founder came via Google or email.
      track("free_trial_started", { source: "blank" });

      router.push("/dashboard/inventory");
    } catch (e: any) {
      setError(e.message);
      setLoading(false);
    }
  };

  const handleCreateDemoWorkspace = async (demoCompany: string) => {
    setLoadingDemo(true);
    setLoadingDemoKey(demoCompany);
    setError(null);
    try {
      const { data: { session } } = await createClient().auth.getSession();
      if (!session) {
        router.push("/login");
        return;
      }

      const response = await apiFetch(`${API_BASE_URL}/api/organization/onboard-demo`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${session.access_token}`
        },
        body: JSON.stringify({ demo_company: demoCompany })
      });

      if (!response.ok) {
        const errData = await response.json();
        throw new Error(errData.detail || "Failed to create demo workspace");
      }

      const data = await response.json();
      localStorage.setItem("active_workspace_id", data.organization_id);
      setOrganization(data.organization_id);
      track("demo_workspace_created", {
        demo_company: demoCompany,
        workspace_id: data.organization_id,
      });
      track("onboarding_completed", { source: "demo", demo_company: demoCompany });
      track("free_trial_started", { source: "demo", demo_company: demoCompany });

      router.push("/dashboard/inventory");
    } catch (e: any) {
      setError(e.message);
      setLoadingDemo(false);
      setLoadingDemoKey(null);
    }
  };

  const handleSkip = () => {
    const demos = ["luma", "drift", "basecamp"];
    const randomDemo = demos[Math.floor(Math.random() * demos.length)];
    handleCreateDemoWorkspace(randomDemo);
  };

  return (
    <AuthShell>
      <div className="w-full max-w-xl bg-card border border-border rounded-2xl p-6 sm:p-10 shadow-xl space-y-8">
        <div className="text-center space-y-2">
          <div className="chip-accent inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold shadow-sm mb-1">
            <Sparkles className="h-3.5 w-3.5 text-[color:var(--eve-accent)]" /> Organization Setup
          </div>
          <h1 className="text-2xl sm:text-4xl font-extrabold tracking-tight text-foreground">Welcome to EVE</h1>
          <p className="text-xs sm:text-sm text-muted-foreground max-w-md mx-auto leading-relaxed">
            Set up your brand's intelligence hub to begin forecasting and optimizing operations.
          </p>
        </div>

        {error && (
          <div className="p-3.5 bg-rose-500/10 border border-rose-500/20 text-rose-600 text-xs rounded-xl flex items-start gap-2">
            <span>{error}</span>
          </div>
        )}

        <div className="space-y-4">
          {/* Demo Workspace Cards */}
          <div className="space-y-3">
            <div className="flex items-center justify-between pb-1">
              <div className="flex items-center gap-2">
                <Brain size={16} className="text-[color:var(--eve-accent)]" />
                <h2 className="text-xs font-bold text-foreground uppercase tracking-wider">Explore with a Demo Brand</h2>
              </div>
              <button
                onClick={handleSkip}
                disabled={loading || loadingDemo}
                className="text-xs font-bold text-[color:var(--eve-accent)] hover:underline transition-all cursor-pointer flex items-center gap-1"
              >
                Skip for now <ArrowRight size={12} />
              </button>
            </div>

            <button
              onClick={() => handleCreateDemoWorkspace("luma")}
              disabled={loading || loadingDemo}
              aria-label="Explore EVE with the Luma & Co. demo brand (Womenswear)"
              aria-busy={loadingDemoKey === "luma"}
              className="w-full text-left p-4 bg-background hover:bg-muted/40 border border-border hover:border-[color:var(--eve-accent)]/50 rounded-xl transition-all shadow-sm hover:shadow-md group cursor-pointer disabled:cursor-wait disabled:opacity-70"
            >
              <div className="flex items-start gap-4">
                <div className="p-3 bg-violet-500/10 text-violet-600 rounded-xl group-hover:bg-violet-600 group-hover:text-white transition-colors shrink-0">
                  {loadingDemoKey === "luma" ? <Loader2 size={20} className="animate-spin" /> : <Brain size={20} />}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground group-hover:text-[color:var(--eve-accent)] transition-colors flex items-center gap-2">
                    Luma &amp; Co.
                    <span className="text-[10px] font-semibold bg-emerald-500/10 text-emerald-700 px-2 py-0.5 rounded-full border border-emerald-500/20">Womenswear</span>
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {loadingDemoKey === "luma"
                      ? "Setting up your Luma & Co. workspace…"
                      : "Premium womenswear brand with strong margins. High inventory velocity with upcoming stockout risks on core hero SKUs."}
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => handleCreateDemoWorkspace("drift")}
              disabled={loading || loadingDemo}
              aria-label="Explore EVE with the Drift Collective demo brand (Streetwear)"
              aria-busy={loadingDemoKey === "drift"}
              className="w-full text-left p-4 bg-background hover:bg-muted/40 border border-border hover:border-[color:var(--eve-accent)]/50 rounded-xl transition-all shadow-sm hover:shadow-md group cursor-pointer disabled:cursor-wait disabled:opacity-70"
            >
              <div className="flex items-start gap-4">
                <div className="p-3 bg-indigo-500/10 text-indigo-600 rounded-xl group-hover:bg-indigo-600 group-hover:text-white transition-colors shrink-0">
                  {loadingDemoKey === "drift" ? <Loader2 size={20} className="animate-spin" /> : <Building2 size={20} />}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground group-hover:text-[color:var(--eve-accent)] transition-colors flex items-center gap-2">
                    Drift Collective
                    <span className="text-[10px] font-semibold bg-amber-500/10 text-amber-700 px-2 py-0.5 rounded-full border border-amber-500/20">Streetwear</span>
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {loadingDemoKey === "drift"
                      ? "Setting up your Drift Collective workspace…"
                      : "Streetwear brand with working capital bottlenecks. $92k trapped in past collab drops with core line selling consistently."}
                  </p>
                </div>
              </div>
            </button>

            <button
              onClick={() => handleCreateDemoWorkspace("basecamp")}
              disabled={loading || loadingDemo}
              aria-label="Explore EVE with the Basecamp Basics demo brand (Essentials)"
              aria-busy={loadingDemoKey === "basecamp"}
              className="w-full text-left p-4 bg-background hover:bg-muted/40 border border-border hover:border-[color:var(--eve-accent)]/50 rounded-xl transition-all shadow-sm hover:shadow-md group cursor-pointer disabled:cursor-wait disabled:opacity-70"
            >
              <div className="flex items-start gap-4">
                <div className="p-3 bg-blue-500/10 text-blue-600 rounded-xl group-hover:bg-blue-600 group-hover:text-white transition-colors shrink-0">
                  {loadingDemoKey === "basecamp" ? <Loader2 size={20} className="animate-spin" /> : <Building2 size={20} />}
                </div>
                <div>
                  <h3 className="text-sm font-bold text-foreground group-hover:text-[color:var(--eve-accent)] transition-colors flex items-center gap-2">
                    Basecamp Basics
                    <span className="text-[10px] font-semibold bg-blue-500/10 text-blue-700 px-2 py-0.5 rounded-full border border-blue-500/20">Essentials</span>
                  </h3>
                  <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
                    {loadingDemoKey === "basecamp"
                      ? "Setting up your Basecamp Basics workspace…"
                      : "Unisex essentials apparel brand navigating seasonal transitions between summer sellouts and winter stock buildup."}
                  </p>
                </div>
              </div>
            </button>
          </div>

          {/* Custom Brand Workspace Setup */}
          {/* Creating an empty workspace here was a guaranteed non-activation:
              the user landed on a dashboard with nothing in it and no insight
              to react to. It is now a de-emphasised text link rather than a
              card of equal weight to the demo brands, and it names the work it
              requires so the choice is informed. Workspace creation also
              remains available in Settings. */}
          {!showManualForm ? (
            <button
              onClick={() => setShowManualForm(true)}
              disabled={loading || loadingDemo}
              aria-label="Start with an empty workspace and upload your own Shopify export"
              className="w-full text-center py-2 text-xs font-semibold text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
            >
              Or start empty and upload your own Shopify export &rarr;
            </button>
          ) : (
            <form onSubmit={handleCreateWorkspace} className="p-5 bg-background border border-border rounded-xl space-y-4 animate-fade-in">
              <h3 className="text-xs font-bold text-foreground uppercase tracking-wider flex items-center gap-2">
                <Building2 size={16} className="text-[color:var(--eve-accent)]" /> Enter Workspace Details
              </h3>
              <div>
                <label className="block text-xs font-bold text-foreground uppercase tracking-wider mb-2">Brand / Company Name</label>
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                    <Building2 className="h-4 w-4 text-muted-foreground" />
                  </div>
                  <input
                    type="text"
                    required
                    value={workspaceName}
                    onChange={(e) => setWorkspaceName(e.target.value)}
                    className="w-full bg-background border border-border rounded-xl pl-10 pr-4 py-2.5 text-foreground text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-[color:var(--eve-accent)]/20 focus:border-[color:var(--eve-accent)] transition-all"
                    placeholder="Acme Wearables"
                  />
                </div>
              </div>
              
              <div className="flex gap-3 pt-2">
                <button
                  type="submit"
                  disabled={loading || !workspaceName.trim()}
                  className="flex-1 py-3 px-4 text-xs font-bold bg-primary text-primary-foreground hover:bg-primary/90 rounded-xl transition-all shadow-sm flex items-center justify-center gap-1.5 cursor-pointer disabled:opacity-50"
                >
                  {loading ? "Creating..." : "Create Workspace"}
                  {!loading && <ArrowRight size={14} />}
                </button>
                <button
                  type="button"
                  onClick={() => setShowManualForm(false)}
                  className="py-3 px-4 border border-border rounded-xl text-xs font-bold text-foreground bg-secondary hover:bg-secondary/70 transition-all cursor-pointer"
                >
                  Back
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </AuthShell>
  );
}

