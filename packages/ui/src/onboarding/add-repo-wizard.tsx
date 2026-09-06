"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  FileText,
  Settings,
  XCircle,
} from "lucide-react";
import { Spinner } from "../ui/spinner";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "../ui/dialog";
import { Label } from "../ui/label";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { formatNumber } from "../lib/format";

/** Built-in wiki styles (mirrors the server's style registry). */
export const WIKI_STYLE_OPTIONS = [
  {
    name: "comprehensive",
    label: "Comprehensive",
    description: "Full, narrative documentation for humans and AI (default).",
  },
  {
    name: "caveman",
    label: "Caveman",
    description: "Token-condensed, AI-first pages. Terse fragments, ~70% smaller.",
  },
  {
    name: "reference",
    label: "Reference",
    description: "API-manual style. Signature-dense, exhaustive, minimal narrative.",
  },
  {
    name: "tutorial",
    label: "Tutorial",
    description: "Guided, beginner-friendly walkthroughs that teach the codebase.",
  },
] as const;

export const DEFAULT_WIKI_STYLE = "comprehensive";

/** Estimates above this auto-start quietly; above it, an explicit confirm is
 * required (same threshold as the CLI's pre-generation cost gate). */
export const COST_GATE_USD = 2.0;

export interface AddRepoPreflightResult {
  provider: {
    ok: boolean;
    name: string | null;
    model: string | null;
    error: string | null;
  };
  file_count: number;
  estimate: {
    total_pages: number;
    estimated_cost_usd: number;
    cost_low_usd: number | null;
    cost_high_usd: number | null;
    is_calibrated: boolean;
  } | null;
}

export interface AddRepoInput {
  name: string;
  local_path: string;
  url?: string | undefined;
  default_branch?: string | undefined;
  wiki_style?: string | undefined;
}

export interface AddRepoWizardAdapter {
  /** Register the repo without indexing; resolves to its id. Rejects with a
   * message (e.g. "path is not a git repository") that is shown inline. */
  createRepo: (input: AddRepoInput) => Promise<{ id: string; name: string }>;
  /** Provider smoke test + size/cost estimate for the registered repo. */
  preflight: (repoId: string) => Promise<AddRepoPreflightResult>;
  /** Kick off the first full index; resolves to the job id. */
  startIndex: (repoId: string) => Promise<{ job_id: string }>;
  /** Currently active provider/model, or null when none is configured.
   * Shown as a readiness hint before the repo is even registered. */
  getProviderStatus?: () => Promise<{ provider: string | null; model: string | null } | null>;
  /** Where the provider/API-key settings live, for recovery links. */
  settingsHref?: string;
  /** Called when indexing started (jobId set) or the user chose to finish
   * without starting one (jobId null). Navigate to the repo from here. */
  onDone: (repoId: string, jobId: string | null) => void;
  /** Clone a GitHub repository using GITHUB_TOKEN. Only available when
   * GITHUB_TOKEN is configured on the server. */
  cloneRepo?: (repo: string, branch?: string) => Promise<{
    local_path: string;
    name: string;
    url: string;
    default_branch: string;
  }>;
  /** List GitHub repositories for the authenticated user. */
  listGithubRepos?: (query?: string) => Promise<
    Array<{
      name: string;
      full_name: string;
      private: boolean;
      description: string | null;
      default_branch: string;
    }>
  >;
}

type Step = "details" | "select-repo" | "cloning" | "checking" | "confirm" | "provider-error";

function formatCostRange(est: NonNullable<AddRepoPreflightResult["estimate"]>): string {
  if (est.cost_low_usd != null && est.cost_high_usd != null) {
    return `$${est.cost_low_usd.toFixed(2)} - $${est.cost_high_usd.toFixed(2)}`;
  }
  return `$${est.estimated_cost_usd.toFixed(2)}`;
}

export interface AddRepoWizardProps {
  adapter: AddRepoWizardAdapter;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Add-repository flow: details (path, style) → preflight (provider smoke
 * test + cost estimate) → auto-start indexing. Cheap runs start quietly;
 * estimates above {@link COST_GATE_USD} stop for an explicit confirm, and a
 * broken provider surfaces its error with recovery paths before any spend.
 */
export function AddRepoWizard({ adapter, open, onOpenChange }: AddRepoWizardProps) {
  const [step, setStep] = useState<Step>("details");
  const [repoMode, setRepoMode] = useState<"public" | "private">("public");
  const [publicSource, setPublicSource] = useState<"local" | "url">("local");
  const [name, setName] = useState("");
  const [localPath, setLocalPath] = useState("");
  const [url, setUrl] = useState("");
  const [branch, setBranch] = useState("main");
  const [wikiStyle, setWikiStyle] = useState<string>(DEFAULT_WIKI_STYLE);
  const [submitting, setSubmitting] = useState(false);
  const [pathError, setPathError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repoId, setRepoId] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<AddRepoPreflightResult | null>(null);
  const [providerHint, setProviderHint] = useState<{
    provider: string | null;
    model: string | null;
  } | null>(null);
  const [starting, setStarting] = useState(false);
  // GitHub repo browsing
  const [githubSearch, setGithubSearch] = useState("");
  const [githubRepos, setGithubRepos] = useState<
    Array<{ name: string; full_name: string; private: boolean; description: string | null; default_branch: string }>
  >([]);
  const [loadingRepos, setLoadingRepos] = useState(false);
  const [cloningStatus, setCloningStatus] = useState<string | null>(null);
  // Guards the preflight effect against firing twice (StrictMode) and
  // against a stale run resolving after the dialog moved on.
  const preflightRun = useRef(0);

  useEffect(() => {
    if (!open || !adapter.getProviderStatus) return;
    let cancelled = false;
    adapter.getProviderStatus().then(
      (s) => {
        if (!cancelled) setProviderHint(s);
      },
      () => {},
    );
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const reset = useCallback(() => {
    setStep("details");
    setRepoMode("public");
    setPublicSource("local");
    setName("");
    setLocalPath("");
    setUrl("");
    setBranch("main");
    setWikiStyle(DEFAULT_WIKI_STYLE);
    setPathError(null);
    setError(null);
    setRepoId(null);
    setPreflight(null);
    setStarting(false);
    setGithubSearch("");
    setGithubRepos([]);
    setLoadingRepos(false);
    setCloningStatus(null);
    preflightRun.current++;
  }, []);

  const handleOpenChange = (v: boolean) => {
    onOpenChange(v);
    if (!v) reset();
  };

  const startIndexing = useCallback(
    async (id: string) => {
      setStarting(true);
      setError(null);
      try {
        const { job_id } = await adapter.startIndex(id);
        handleOpenChange(false);
        adapter.onDone(id, job_id);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Couldn't start indexing");
        setStep("confirm");
        setStarting(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [adapter],
  );

  const runPreflight = useCallback(
    async (id: string) => {
      const run = ++preflightRun.current;
      setStep("checking");
      setError(null);
      try {
        const result = await adapter.preflight(id);
        if (run !== preflightRun.current) return;
        setPreflight(result);
        if (!result.provider.ok) {
          setStep("provider-error");
          return;
        }
        const cost = result.estimate?.estimated_cost_usd ?? 0;
        if (cost > COST_GATE_USD) {
          setStep("confirm");
          return;
        }
        // Below the gate: start quietly, same as the CLI.
        await startIndexing(id);
      } catch (e) {
        if (run !== preflightRun.current) return;
        setError(e instanceof Error ? e.message : "Preflight check failed");
        setStep("confirm");
      }
    },
    [adapter, startIndexing],
  );

  async function handleDetailsSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;

    if (repoMode === "private") {
      setStep("select-repo");
      if (githubRepos.length === 0) loadGithubRepos();
      return;
    }

    // Public + From URL: clone from GitHub
    if (publicSource === "url") {
      if (!url.trim()) return;
      return handlePublicUrlClone();
    }

    // Public + Local path: register only (existing flow)
    if (!localPath.trim()) return;
    setSubmitting(true);
    setPathError(null);
    setError(null);
    try {
      const repo = await adapter.createRepo({
        name: name.trim(),
        local_path: localPath.trim(),
        url: url.trim() || undefined,
        default_branch: branch.trim() || "main",
        wiki_style: wikiStyle !== DEFAULT_WIKI_STYLE ? wikiStyle : undefined,
      });
      setRepoId(repo.id);
      await runPreflight(repo.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Failed to add repository";
      if (/path|director|git|exist/i.test(msg)) setPathError(msg);
      else setError(msg);
    } finally {
      setSubmitting(false);
    }
  }

  async function handlePublicUrlClone() {
    if (!adapter.cloneRepo || !url.trim()) return;
    setStep("cloning");
    setCloningStatus("Cloning repository…");
    setError(null);
    try {
      const result = await adapter.cloneRepo(url.trim(), branch.trim() || undefined);
      setLocalPath(result.local_path);
      if (!name.trim()) setName(result.name);
      setCloningStatus("Registering…");
      const repo = await adapter.createRepo({
        name: result.name,
        local_path: result.local_path,
        url: result.url,
        default_branch: result.default_branch,
        wiki_style: wikiStyle !== DEFAULT_WIKI_STYLE ? wikiStyle : undefined,
      });
      setRepoId(repo.id);
      await runPreflight(repo.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clone failed");
      setStep("details");
      setCloningStatus(null);
    }
  }

  async function loadGithubRepos(query?: string) {
    if (!adapter.listGithubRepos) return;
    setLoadingRepos(true);
    setError(null);
    try {
      const repos = await adapter.listGithubRepos(query);
      setGithubRepos(repos);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to list GitHub repos");
    } finally {
      setLoadingRepos(false);
    }
  }

  async function handleGithubRepoSelect(selected: {
    full_name: string;
    default_branch: string;
    name: string;
  }) {
    if (!adapter.cloneRepo) return;
    setStep("cloning");
    setCloningStatus("Cloning repository…");
    setError(null);
    try {
      const result = await adapter.cloneRepo(selected.full_name, selected.default_branch);
      // Clone succeeded — now register + preflight like the public flow
      setLocalPath(result.local_path);
      setUrl(result.url);
      setBranch(result.default_branch);
      if (!name.trim()) setName(selected.name);
      setCloningStatus("Registering…");
      const repo = await adapter.createRepo({
        name: selected.name,
        local_path: result.local_path,
        url: result.url,
        default_branch: result.default_branch,
        wiki_style: wikiStyle !== DEFAULT_WIKI_STYLE ? wikiStyle : undefined,
      });
      setRepoId(repo.id);
      await runPreflight(repo.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Clone failed");
      setStep("select-repo");
      setCloningStatus(null);
    }
  }

  function handleFinishWithoutIndex() {
    if (!repoId) return;
    const id = repoId;
    handleOpenChange(false);
    adapter.onDone(id, null);
  }

  const estimate = preflight?.estimate ?? null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md w-[calc(100vw-2rem)] flex flex-col overflow-hidden">
        {step === "details" && (
          <>
            <DialogHeader>
              <DialogTitle>Add Repository</DialogTitle>
            </DialogHeader>

            <form onSubmit={handleDetailsSubmit} className="space-y-4 py-2 min-w-0">
              {/* Public / Private toggle */}
              <div className="flex rounded-md border border-[var(--color-border-default)] overflow-hidden">
                <button
                  type="button"
                  className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                    repoMode === "public"
                      ? "bg-[var(--color-accent-primary)] text-white"
                      : "bg-[var(--color-bg-subtle)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)]"
                  }`}
                  onClick={() => setRepoMode("public")}
                >
                  Public
                </button>
                <button
                  type="button"
                  className={`flex-1 py-1.5 text-xs font-medium transition-colors ${
                    repoMode === "private"
                      ? "bg-[var(--color-accent-primary)] text-white"
                      : "bg-[var(--color-bg-subtle)] text-[var(--color-text-secondary)] hover:bg-[var(--color-bg-elevated)]"
                  }`}
                  onClick={() => {
                    setRepoMode("private");
                    if (!adapter.cloneRepo) {
                      setError("Private repos require GITHUB_TOKEN on the server.");
                    }
                  }}
                >
                  Private
                </button>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="repo-name">Name</Label>
                <Input
                  id="repo-name"
                  placeholder="my-project"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              {repoMode === "public" ? (
                <>
                  {/* Local path / From URL sub-toggle */}
                  <div className="flex rounded-md border border-[var(--color-border-default)] overflow-hidden">
                    <button
                      type="button"
                      className={`flex-1 py-1 text-[11px] font-medium transition-colors ${
                        publicSource === "local"
                          ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]"
                          : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
                      }`}
                      onClick={() => setPublicSource("local")}
                    >
                      Local path
                    </button>
                    <button
                      type="button"
                      className={`flex-1 py-1 text-[11px] font-medium transition-colors ${
                        publicSource === "url"
                          ? "bg-[var(--color-bg-elevated)] text-[var(--color-text-primary)]"
                          : "text-[var(--color-text-tertiary)] hover:text-[var(--color-text-secondary)]"
                      }`}
                      onClick={() => setPublicSource("url")}
                    >
                      From URL
                    </button>
                  </div>

                  {publicSource === "local" ? (
                    <div className="space-y-1.5">
                      <Label htmlFor="repo-path">Local Path</Label>
                      <Input
                        id="repo-path"
                        placeholder="/repo/my-project"
                        value={localPath}
                        onChange={(e) => { setLocalPath(e.target.value); setPathError(null); }}
                        className="font-mono"
                        aria-invalid={!!pathError}
                        aria-describedby="repo-path-hint"
                        required
                      />
                      {pathError ? (
                        <p id="repo-path-hint" className="text-xs text-[var(--color-outdated)]">{pathError}</p>
                      ) : (
                        <p id="repo-path-hint" className="text-xs text-[var(--color-text-tertiary)]">
                          Absolute path to a local git checkout.
                        </p>
                      )}
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1.5">
                        <Label htmlFor="repo-url-public">GitHub URL</Label>
                        <Input
                          id="repo-url-public"
                          placeholder="https://github.com/org/repo"
                          value={url}
                          onChange={(e) => setUrl(e.target.value)}
                          required
                        />
                        <p className="text-xs text-[var(--color-text-tertiary)]">
                          Paste any public GitHub repository URL. It will be cloned into the container.
                        </p>
                      </div>
                      <div className="space-y-1.5">
                        <Label htmlFor="repo-branch">
                          Branch{" "}
                          <span className="font-normal text-[var(--color-text-tertiary)]">(optional)</span>
                        </Label>
                        <Input id="repo-branch" placeholder="main" value={branch} onChange={(e) => setBranch(e.target.value)} />
                      </div>
                    </>
                  )}
                </>
              ) : (
                <p className="text-xs text-[var(--color-text-tertiary)]">
                  Click <strong>Continue</strong> to browse and select from your GitHub repositories.
                </p>
              )}

              <div className="space-y-1.5">
                <Label htmlFor="repo-style">Wiki style</Label>
                <Select value={wikiStyle} onValueChange={setWikiStyle}>
                  <SelectTrigger id="repo-style" aria-label="Wiki style">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {WIKI_STYLE_OPTIONS.map((s) => (
                      <SelectItem key={s.name} value={s.name} textValue={s.label}>
                        <span className="font-medium">{s.label}</span>
                        <span className="ml-1.5 text-xs text-[var(--color-text-tertiary)]">
                          {s.description}
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {providerHint !== null && (
                <p className="flex items-center gap-1.5 text-xs text-[var(--color-text-tertiary)]">
                  {providerHint.provider ? (
                    <>
                      <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-[var(--color-fresh)]" />
                      Docs will use {providerHint.provider}
                      {providerHint.model ? ` · ${providerHint.model}` : ""}
                    </>
                  ) : (
                    <>
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-[var(--color-warning)]" />
                      No AI provider configured yet.
                      {adapter.settingsHref && (
                        <a
                          href={adapter.settingsHref}
                          className="text-[var(--color-accent-primary)] hover:underline"
                        >
                          Set one up
                        </a>
                      )}
                    </>
                  )}
                </p>
              )}

              {error && <p className="text-sm text-[var(--color-outdated)]">{error}</p>}

              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => handleOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  disabled={submitting || !name.trim() || (repoMode === "public" && publicSource === "local" && !localPath.trim()) || (repoMode === "public" && publicSource === "url" && !url.trim())}
                >
                  {submitting ? "Adding…" : "Continue"}
                </Button>
              </DialogFooter>
            </form>
          </>
        )}

        {step === "select-repo" && (
          <>
            <DialogHeader>
              <DialogTitle>Select GitHub Repository</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2 min-w-0">
              <Input
                placeholder="Search repositories…"
                value={githubSearch}
                onChange={(e) => {
                  setGithubSearch(e.target.value);
                  loadGithubRepos(e.target.value);
                }}
              />
              {error && <p className="text-sm text-[var(--color-outdated)]">{error}</p>}
              <div className="max-h-64 overflow-y-auto space-y-1">
                {loadingRepos && (
                  <div className="flex items-center justify-center py-6">
                    <Spinner className="h-5 w-5 text-[var(--color-text-tertiary)]" />
                  </div>
                )}
                {!loadingRepos && githubRepos.length === 0 && (
                  <p className="text-sm text-center text-[var(--color-text-tertiary)] py-4">
                    No repositories found.
                  </p>
                )}
                {githubRepos.map((r) => (
                  <button
                    key={r.full_name}
                    type="button"
                    className="w-full text-left rounded-md border border-[var(--color-border-default)] p-2.5 hover:bg-[var(--color-bg-elevated)] transition-colors"
                    onClick={() => handleGithubRepoSelect(r)}
                  >
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm text-[var(--color-text-primary)]">{r.name}</span>
                      {r.private && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--color-warning)]/20 text-[var(--color-warning)] font-medium">
                          Private
                        </span>
                      )}
                    </div>
                    {r.description && (
                      <p className="text-xs text-[var(--color-text-tertiary)] mt-0.5 truncate">{r.description}</p>
                    )}
                  </button>
                ))}
              </div>
              <DialogFooter>
                <Button type="button" variant="ghost" onClick={() => setStep("details")}>
                  <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                  Back
                </Button>
              </DialogFooter>
            </div>
          </>
        )}

        {step === "cloning" && (
          <>
            <DialogHeader>
              <DialogTitle>Cloning Repository</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center justify-center py-8 gap-3">
              <Spinner className="h-6 w-6 text-[var(--color-accent-primary)]" />
              <p className="text-sm text-[var(--color-text-secondary)]">{cloningStatus || "Cloning…"}</p>
              {error && <p className="text-sm text-[var(--color-outdated)]">{error}</p>}
            </div>
          </>
        )}

        {step === "checking" && (
          <>
            <DialogHeader>
              <DialogTitle>Getting ready to index</DialogTitle>
            </DialogHeader>
            <div className="flex flex-col items-center gap-3 py-8">
              <Spinner size="xl" className="text-[var(--color-accent-primary)]" />
              <p className="text-sm text-[var(--color-text-secondary)]">
                Checking the provider and sizing the repository…
              </p>
            </div>
          </>
        )}

        {step === "provider-error" && preflight && (
          <>
            <DialogHeader>
              <DialogTitle>Provider isn&apos;t ready</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              <div className="flex items-start gap-2 rounded-md border border-[var(--color-outdated)]/40 bg-[var(--color-outdated)]/10 px-3 py-2 text-sm">
                <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-outdated)]" />
                <div className="min-w-0">
                  <p className="font-medium text-[var(--color-text-primary)]">
                    {preflight.provider.name
                      ? `${preflight.provider.name} check failed`
                      : "No AI provider is configured"}
                  </p>
                  {preflight.provider.error && (
                    <p className="mt-0.5 break-words text-xs text-[var(--color-text-secondary)]">
                      {preflight.provider.error}
                    </p>
                  )}
                </div>
              </div>
              <p className="text-xs text-[var(--color-text-tertiary)]">
                The repository is registered. Fix the provider (usually an API key) and
                retry, or index without docs now and generate them later.
              </p>
            </div>
            <DialogFooter className="flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep("details")}
                aria-label="Back to details"
              >
                <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                Back
              </Button>
              <Button type="button" variant="ghost" onClick={handleFinishWithoutIndex}>
                Finish without indexing
              </Button>
              {adapter.settingsHref && (
                <Button type="button" variant="outline" asChild>
                  <a href={adapter.settingsHref}>
                    <Settings className="mr-1.5 h-3.5 w-3.5" />
                    Provider settings
                  </a>
                </Button>
              )}
              <Button type="button" onClick={() => repoId && runPreflight(repoId)}>
                Retry check
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "confirm" && (
          <>
            <DialogHeader>
              <DialogTitle>Ready to index</DialogTitle>
            </DialogHeader>
            <div className="space-y-3 py-2">
              {preflight && (
                <div className="grid grid-cols-2 gap-2">
                  <div className="rounded border border-[var(--color-border-default)] p-2.5 text-center">
                    <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                      {formatNumber(preflight.file_count)}
                    </p>
                    <p className="text-xs text-[var(--color-text-tertiary)]">files</p>
                  </div>
                  <div className="rounded border border-[var(--color-border-default)] p-2.5 text-center">
                    <p className="text-lg font-semibold text-[var(--color-text-primary)]">
                      {estimate ? formatNumber(estimate.total_pages) : "—"}
                    </p>
                    <p className="text-xs text-[var(--color-text-tertiary)]">doc pages</p>
                  </div>
                </div>
              )}
              {estimate && (
                <div className="flex items-start gap-2 rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 px-3 py-2 text-sm">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-[var(--color-warning)]" />
                  <div>
                    <p className="font-medium text-[var(--color-text-primary)]">
                      Estimated generation cost: {formatCostRange(estimate)}
                    </p>
                    <p className="mt-0.5 text-xs text-[var(--color-text-secondary)]">
                      {preflight?.provider.name}
                      {preflight?.provider.model ? ` · ${preflight.provider.model}` : ""}
                      {estimate.is_calibrated
                        ? " · calibrated from previous runs"
                        : " · rough estimate, actuals vary"}
                    </p>
                  </div>
                </div>
              )}
              {error && <p className="text-sm text-[var(--color-outdated)]">{error}</p>}
            </div>
            <DialogFooter className="flex-wrap gap-2">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setStep("details")}
                disabled={starting}
                aria-label="Back to details"
              >
                <ArrowLeft className="mr-1 h-3.5 w-3.5" />
                Back
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={handleFinishWithoutIndex}
                disabled={starting}
              >
                Not now
              </Button>
              <Button
                type="button"
                onClick={() => repoId && startIndexing(repoId)}
                disabled={starting}
              >
                {starting
                  ? "Starting…"
                  : estimate
                    ? `Start indexing (~$${estimate.estimated_cost_usd.toFixed(2)})`
                    : "Start indexing"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
