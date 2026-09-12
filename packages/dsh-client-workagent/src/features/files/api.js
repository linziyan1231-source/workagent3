import { apiRoot, request } from "../../platform/api.js";
import { friendlyError } from "../../ui/labels.js";
import { createUploads } from "./uploads.js";
import React from "react";

const FILE_PROJECT_EVENT = "workagent:files-project";

const FILES_CHANGED_EVENT = "workagent:files-changed";

const fileParent = (path) => path.split("/").slice(0, -1).join("/");

const workspaceFileRoot = (workspaceId) =>
  workspaceId?.startsWith("shared:")
    ? `/api/portal/shared-workspaces/${encodeURIComponent(workspaceId.slice("shared:".length))}`
    : `${apiRoot}/workspaces/${encodeURIComponent(workspaceId)}`;

const fileURL = (
  workspaceId,
  path,
  preview = false,
  fileId,
  historical = false,
) =>
  `${workspaceFileRoot(workspaceId)}/content?path=${encodeURIComponent(path)}${preview ? "&preview=1" : ""}${fileId ? `&fileId=${encodeURIComponent(fileId)}` : ""}${historical ? "&reference=1" : ""}`;

const uploads = createUploads({
  React,
  request,
  apiRoot,
  friendlyError,
  workspaceEndpoint: workspaceFileRoot,
});

const fileSize = (size) =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${(size / 1024).toFixed(1)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;

export {
  FILE_PROJECT_EVENT,
  FILES_CHANGED_EVENT,
  fileParent,
  workspaceFileRoot,
  fileURL,
  uploads,
  fileSize,
};
