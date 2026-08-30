import {
  workspaceApiSchemas,
  type Workspace,
  type WorkspaceAsset,
  type WorkspaceEntry,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

const base = "/api/runtime/v1/workspaces";

export const workspacePort = {
  async list(): Promise<Workspace[]> {
    return workspaceApiSchemas.workspaceList.parse(
      await requestJson<unknown>(base),
    );
  },
  async create(name: string): Promise<Workspace> {
    return workspaceApiSchemas.workspace.parse(
      await requestJson<unknown>(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name }),
      }),
    );
  },
  async files(workspaceId: string, path: string): Promise<WorkspaceEntry[]> {
    return workspaceApiSchemas.entryList.parse(
      await requestJson<unknown>(
        `${base}/${encodeURIComponent(workspaceId)}/files?path=${encodeURIComponent(path)}`,
      ),
    );
  },
  async upload(
    workspaceId: string,
    path: string,
    content: Blob,
  ): Promise<WorkspaceEntry> {
    return workspaceApiSchemas.entry.parse(
      await requestJson<unknown>(
        `${base}/${encodeURIComponent(workspaceId)}/content?path=${encodeURIComponent(path)}`,
        { method: "PUT", body: content },
      ),
    );
  },
  async mkdir(workspaceId: string, path: string): Promise<void> {
    await requestJson(
      `${base}/${encodeURIComponent(workspaceId)}/directories`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path }),
      },
    );
  },
  async assets(
    workspaceId: string,
    sessionId: string,
  ): Promise<WorkspaceAsset[]> {
    return workspaceApiSchemas.assetList.parse(
      await requestJson<unknown>(
        `${base}/${encodeURIComponent(workspaceId)}/assets?sessionId=${encodeURIComponent(sessionId)}`,
      ),
    );
  },
  async attach(
    workspaceId: string,
    sessionId: string,
    file: File,
  ): Promise<WorkspaceAsset> {
    return workspaceApiSchemas.asset.parse(
      await requestJson<unknown>(
        `${base}/${encodeURIComponent(workspaceId)}/attachments?sessionId=${encodeURIComponent(sessionId)}&name=${encodeURIComponent(file.name)}`,
        {
          method: "PUT",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        },
      ),
    );
  },
  downloadUrl(workspaceId: string, path: string): string {
    return `${base}/${encodeURIComponent(workspaceId)}/content?path=${encodeURIComponent(path)}`;
  },
};
