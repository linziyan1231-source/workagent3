import { useUploadToProject } from "../conversations/preferences.js";
import { nativeSessionAction } from "../conversations/runtime.js";
import { fileURL, uploads, workspaceFileRoot } from "../files/api.js";
import { navigation } from "../../host/navigation.js";
import { apiRoot, request } from "../../platform/api.js";
import { Icon } from "../../ui/icons.js";
import { friendlyError, reasoningLabel } from "../../ui/labels.js";
import { createWorkbench } from "./workbench.js";
import * as primitives from "@deepseek-ai/dsh-client-ui-primitives";
import React from "react";

const workbench = createWorkbench({
  navigate: navigation.navigate,
  reasoningLabel,
  Icon,
  uploadFiles: uploads.uploadFiles,
  useUploadToProject,
  friendlyError,
  React,
  primitives,
  request,
  apiRoot,
  fileURL,
  workspaceEndpoint: workspaceFileRoot,
  nativeSessionAction,
});

const Markdown = workbench.Markdown;

export { workbench, Markdown };
