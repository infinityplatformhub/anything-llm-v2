import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import Workspace from "@/models/workspace";

/**
 * Top bar for Admin › Agents. Every panel below is scoped to the selected workspace.
 * Selection is mirrored to `?workspace=<slug>` so links from Workspace Settings land on the right room.
 */
export default function WorkspaceSelector({
  selectedSlug,
  onChange,
  showEmptyNote = false,
}) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState(null);
  const [searchParams, setSearchParams] = useSearchParams();

  const setWorkspaceParam = (slug, options) => {
    const next = new URLSearchParams(searchParams);
    next.set("workspace", slug);
    setSearchParams(next, options);
  };

  useEffect(() => {
    let cancelled = false;
    Workspace.all()
      .then((list) => {
        if (cancelled) return;
        setWorkspaces(list);
        const fromUrl = searchParams.get("workspace");
        const fromUrlSlug = list.find(
          (workspace) => workspace.slug === fromUrl
        )?.slug;
        const initial = fromUrlSlug ?? list[0]?.slug ?? null;
        if (initial && !fromUrlSlug)
          setWorkspaceParam(initial, { replace: true });
        if (initial && initial !== selectedSlug) onChange(initial);
      })
      .catch(() => {
        if (!cancelled) setWorkspaces([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const fromUrl = searchParams.get("workspace");
    const urlSlug = workspaces?.find(
      (workspace) => workspace.slug === fromUrl
    )?.slug;
    if (urlSlug && urlSlug !== selectedSlug) onChange(urlSlug);
  }, [searchParams, workspaces]);

  const select = (slug) => {
    setWorkspaceParam(slug);
    if (slug !== selectedSlug) onChange(slug);
  };

  if (workspaces === null) return null;
  if (workspaces.length === 0)
    return (
      <div className="text-sm text-theme-text-secondary mb-4">
        {t("agent.workspaceSelector.noWorkspaces")}
      </div>
    );
  return (
    <div className="mb-4">
      <div className="flex flex-wrap items-center gap-x-3 bg-theme-bg-secondary border border-theme-sidebar-border rounded-lg px-4 py-2">
        <label
          htmlFor="agent-workspace"
          className="text-xs uppercase tracking-wide text-theme-text-secondary"
        >
          {t("agent.workspaceSelector.label")}
        </label>
        <select
          id="agent-workspace"
          value={selectedSlug ?? ""}
          onChange={(event) => select(event.target.value)}
          className="bg-theme-settings-input-bg text-white text-sm rounded-lg px-3 py-1.5 min-w-0 w-full sm:w-auto"
        >
          {workspaces.map((workspace) => (
            <option key={workspace.slug} value={workspace.slug}>
              {workspace.name} — /{workspace.slug}
            </option>
          ))}
        </select>
        <span className="ml-auto text-xs text-theme-text-secondary">
          {t("agent.workspaceSelector.scopeNote")}
        </span>
      </div>
      {showEmptyNote && (
        <p className="text-xs text-theme-text-secondary mt-2">
          {t("agent.workspaceSelector.emptyNote")}
        </p>
      )}
    </div>
  );
}
