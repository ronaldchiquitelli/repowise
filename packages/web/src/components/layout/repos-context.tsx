import * as React from "react";
import { listRepos, getWorkspace } from "@/lib/api/repos";
import useSWR from "swr";
import type { RepoResponse, WorkspaceResponse } from "@/lib/api/types";

interface RepoContextValue {
  repos: RepoResponse[];
  workspace: WorkspaceResponse | null;
  isLoading: boolean;
}

const RepoContext = React.createContext<RepoContextValue>({
  repos: [],
  workspace: null,
  isLoading: true,
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
  const { data: repos, isLoading: reposLoading } = useSWR(
    "/api/repos",
    () => listRepos().catch(() => []),
  );
  const { data: workspace } = useSWR(
    "/api/workspace",
    () => getWorkspace(),
  );

  return (
    <RepoContext.Provider
      value={{
        repos: repos ?? [],
        workspace: workspace ?? null,
        isLoading: reposLoading,
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