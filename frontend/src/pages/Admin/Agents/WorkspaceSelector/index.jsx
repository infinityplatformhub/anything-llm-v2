import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import Workspace from "@/models/workspace";

/**
 * Top bar for Admin › Agents. Every panel below is scoped to the selected workspace.
 * Selection is mirrored to `?workspace=<slug>` so links from Workspace Settings land on the right room.
 */
export default function WorkspaceSelector({ selectedSlug, onChange }) {
  const { t } = useTranslation();
  const [workspaces, setWorkspaces] = useState([]);
  const [searchParams, setSearchParams] = useSearchParams();

  useEffect(() => {
    Workspace.all().then((list) => {
      setWorkspaces(list);
      const fromUrl = searchParams.get("workspace");
      const initial =
        list.find((workspace) => workspace.slug === fromUrl)?.slug ??
        list[0]?.slug ??
        null;
      if (initial && initial !== selectedSlug) onChange(initial);
    });
  }, []);

  const select = (slug) => {
    setSearchParams({ workspace: slug });
    if (slug !== selectedSlug) onChange(slug);
  };

  if (workspaces.length === 0) return null;
  return (
    <div className="flex items-center gap-x-3 bg-theme-bg-secondary border border-theme-sidebar-border rounded-lg px-4 py-2 mb-4">
      <label
        htmlFor="agent-workspace"
        className="text-xs uppercase tracking-wide text-theme-text-secondary"
      >
        Workspace
      </label>
      <select
        id="agent-workspace"
        value={selectedSlug ?? ""}
        onChange={(event) => select(event.target.value)}
        className="bg-theme-settings-input-bg text-white text-sm rounded-lg px-3 py-1.5 min-w-[220px]"
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
  );
}
