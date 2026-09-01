import * as React from "react";
import { listRepos, getWorkspace } from "@/lib/api/repos";
import useSWR from "swr";
import type { RepoResponse, WorkspaceResponse } from "@/lib/api/types";

interface RepoContextValue {
  repos: RepoResponse[];
  workspace: WorkspaceResponse | null;
  /** True while the very first load is in progress (loading spinner state). */
  isLoading: boolean;
  /** Set to true when the initial fetch throws/fails (shows error message). */
  hasLoadError: boolean;
}

const RepoContext = React.createContext<RepoContextValue>({
  repos: [],
  workspace: null,
  isLoading: true,
  hasLoadError: false,
});

/**
 * Loads repository and workspace data on the client side using SWR.
 *
 * Why: The root layout used to `await listRepos()` server-side so the Sidebar
 * received repos as props from the first paint. But when navigating to a page
 * like `/settings`, Next.js re-renders the server component — which has no
 * access to the API key stored in localStorage (that's only available in the
 * browser). Every navigation ended up returning `reposUnavailable=true` and an
 * empty sidebar.
 *
 * This provider hooks SWR into `listRepos()` + `getWorkspace()` so the data
 * lives entirely on the client. It survives route transitions because the hook
 * keeps its cache while the user stays on the app; it works across pages
 * because every client render can read from this context.
 */
export function ReposProvider({ children }: { children: React.ReactNode }) {
  const {
    data: repos,
    isLoading: reposLoading,
    error: reposError,
  } = useSWR("/api/repos", listRepos, {
    // Never throw away the cached data on focus/reconnect — keep the loaded
    // state stable across route transitions.
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    // Retry up to 3 times with exponential backoff; if the first fetch fails
    // (e.g. the page loaded before the server was ready), retries recover it.
    errorRetryCount: 3,
    // Return a fallback empty array so the consuming context never sees `null`.
    fallbackData: [],
  });
  const {
    data: workspace,
    error: workspaceError,
  } = useSWR(
    "/api/workspace",
    () => getWorkspace().catch(() => null),
    {
      revalidateOnFocus: false,
      revalidateOnReconnect: false,
      fallbackData: null,
      // Don't show workspace errors as fatal — workspace is optional.
      errorRetryCount: 2,
    },
  );

  // Track whether the *very first* fetch failed (so Sidebar can show loader vs
  // error vs empty-state).  Once data has loaded at least once, we stop caring
  // about transient errors — stale data survives across navs.
  const [hasAttempted, setHasAttempted] = React.useState(false);
  React.useEffect(() => {
    if (!reposLoading && !hasAttempted) {
      setHasAttempted(true);
    }
  }, [reposLoading]);

  // Only surface load errors when: no data arrived, there's an error, and this
  // was our first attempt (not a stale/error-after-success state).
  const hasLoadError = repos === undefined && reposError && hasAttempted;

  return (
    <RepoContext.Provider
      value={{
        repos: repos ?? [],
        workspace: workspace ?? null,
        isLoading: reposLoading && !repos,
        hasLoadError,
      }}
    >
      {children}
    </RepoContext.Provider>
  );
}

/** Hook to consume repos data from anywhere inside the app shell. */
export function useRepos() {
  return React.useContext(RepoContext);
}