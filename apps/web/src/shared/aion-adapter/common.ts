import { modelAccessPort } from "../../features/models/modelAccessPort.js";
import { maskedProviderCredential } from "../../features/models/modelAccessPort.js";
import { providerCredentialPort } from "../../features/credentials/providerCredentialPort.js";
import { automationPort } from "../../features/automation/automationPort.js";
import { skillPort } from "../../features/skills/skillPort.js";
import { conversationPort } from "../../features/conversation/conversationPort.js";
import { presetPort } from "../../features/presets/presetPort.js";
import { notificationPort } from "../../features/notifications/notificationPort.js";
import { systemPort } from "../../features/system/systemPort.js";
import { workspacePort } from "../../features/workspace/workspacePort.js";
import {
  collaborationPort,
  type SharedConversation,
  type SharedStreamMessage,
} from "../../features/collaboration/collaborationPort.js";
import { requestJson } from "../api/http.js";
import type { TChatConversation } from "@/common/config/storage";
import type { PreviewContentType } from "@/common/types/office/preview";
import type { Theme } from "@/common/theme/types";
import type {
  IDirOrFile,
  IFileMetadata,
  PortalKimiDatasourceGrant,
  PortalManagedUser,
  PortalProvisionJob,
  PortalSkillMarketEntry,
  PortalUsageSummary,
} from "./ipcBridge.js";
import { getManagedAgents } from "./assistantHooks.js";
import { cronBridge } from "./cronAdapter.js";
import {
  displayConversationFilePath,
  materializeConversationFiles,
} from "./fileService.js";

const toRendererSkill = (
  skill: Awaited<ReturnType<typeof skillPort.list>>[number],
) => ({
  name: skill.name,
  description: skill.description,
  location: skill.relativePath,
  relative_location: skill.relativePath,
  is_auto_inject: false,
  is_custom: skill.source === "user" || skill.source === "market",
  source:
    skill.source === "builtin"
      ? ("builtin" as const)
      : skill.source === "managed"
        ? ("extension" as const)
        : ("custom" as const),
});

type ConversationListEvent = {
  conversation_id: string;
  action: "created" | "updated" | "deleted";
  source?: string;
};

const themeListeners = new Set<(theme: Theme) => void>();
type FileContentUpdate = {
  file_path: string;
  content: string;
  workspace: string;
  relative_path: string;
  operation: "write" | "delete";
};
type PreviewOpenEvent = {
  content: string;
  content_type: PreviewContentType;
  metadata?: { title?: string; file_name?: string };
};
const fileContentListeners = new Set<(event: FileContentUpdate) => void>();
const previewOpenListeners = new Set<(event: PreviewOpenEvent) => void>();

const sharedProjectIDFromPath = (value?: string): string | null =>
  value?.replaceAll("\\", "/").match(/^shared:\/\/([^/]+)(?:\/|$)/)?.[1] ??
  null;

const sharedRelativePath = (projectId: string, value?: string) => {
  if (value === undefined) return undefined;
  const normalized = value.replaceAll("\\", "/");
  const root = `shared://${projectId}`;
  if (normalized === root) return "";
  return normalized.startsWith(`${root}/`)
    ? normalized.slice(root.length + 1)
    : normalized;
};

const sharedFileRequest = <T>(
  projectId: string,
  operation: string,
  fields: { path?: string; data?: string; new_name?: string } = {},
) =>
  requestJson<{ success: true; data: T }>("/api/portal/shared-files", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      operation,
      ...fields,
      ...(fields.path === undefined
        ? {}
        : { path: sharedRelativePath(projectId, fields.path) }),
    }),
  }).then((response) => response.data);

const sharedDirectoryEntries = (
  raw: Array<{ name: string; type: string }>,
  workspace: string,
  relativePath: string,
): IDirOrFile[] => {
  const base = relativePath === "." ? "" : relativePath;
  const children = raw.map((entry) => ({
    name: entry.name,
    fullPath: `${workspace}/${base ? `${base}/` : ""}${entry.name}`,
    relativePath: `${base ? `${base}/` : ""}${entry.name}`,
    isDir: entry.type === "directory",
    isFile: entry.type !== "directory",
  }));
  return [
    {
      name: base.split("/").pop() || workspace.split("/").pop() || workspace,
      fullPath: base ? `${workspace}/${base}` : workspace,
      relativePath: base,
      isDir: true,
      isFile: false,
      children,
    },
  ];
};

type SharedProjectResponse = {
  id: string;
  ownerUserId: number;
  name: string;
  state: string;
  currentRole: "owner" | "member";
  hidden: boolean;
  createdAt: string;
  updatedAt: string;
};

type SharedInviteResponse = {
  id: string;
  projectId: string;
  projectName: string;
  inviterName: string;
  status: "pending";
  createdAt: string;
  expiresAt: string;
};

const toRendererSharedProject = (project: SharedProjectResponse) => ({
  id: project.id,
  name: project.name,
  source_kind: "new" as const,
  state: project.state,
  role: project.currentRole,
  owner_name: "",
  member_count: 0,
  hidden: project.hidden,
  created_at: project.createdAt,
  updated_at: project.updatedAt,
});

const toRendererSharedInvite = (invite: SharedInviteResponse) => ({
  id: invite.id,
  project_id: invite.projectId,
  project_name: invite.projectName,
  inviter_name: invite.inviterName,
  status: invite.status,
  created_at: invite.createdAt,
  expires_at: invite.expiresAt,
});

const conversationListListeners = new Set<
  (event: ConversationListEvent) => void
>();
type RendererConfirmation<Option = unknown> = {
  title?: string;
  id: string;
  action?: string;
  description: string;
  call_id: string;
  options: Array<{ label: string; value: Option }>;
  command_type?: string;
};
type ConfirmationEvent = { conversation_id: string; id: string };
type ConfirmationAddEvent = RendererConfirmation & {
  conversation_id: string;
};
const confirmationAddListeners = new Set<
  (event: ConfirmationAddEvent) => void
>();
const confirmationRemoveListeners = new Set<
  (event: ConfirmationEvent) => void
>();
type RendererResponseMessage = {
  type: string;
  data: unknown;
  msg_id: string;
  turn_id?: string;
  conversation_id: string;
  created_at?: number;
  position?: "left" | "right" | "center" | "pop";
  status?: "finish" | "pending" | "error" | "work";
  replace?: boolean;
};
const responseStreamListeners = new Set<
  (event: RendererResponseMessage) => void
>();
const turnCompletedListeners = new Set<
  (event: { conversation_id: string; turn_id: string }) => void
>();
const runtimeSubscriptions = new Map<string, () => void>();
const conversationExtras = new Map<string, Record<string, unknown>>();

const toRendererConfirmation = (
  interaction: Awaited<ReturnType<typeof conversationPort.pending>>[number],
): RendererConfirmation<string> => ({
  id: interaction.id,
  call_id: interaction.id,
  title: interaction.tool,
  action: "exec",
  description: interaction.summary,
  command_type: interaction.tool,
  options: [
    { label: "Allow once", value: "allow_once" },
    { label: "Decline", value: "decline" },
  ],
});

const confirmationDecision = (data: unknown): "allow" | "reject" => {
  const value =
    data !== null && typeof data === "object" && "value" in data
      ? String((data as { value: unknown }).value)
      : String(data ?? "");
  return /reject|decline|cancel|deny|\bno\b/i.test(value) ? "reject" : "allow";
};

const emitResponse = (event: RendererResponseMessage) => {
  for (const listener of responseStreamListeners) listener(event);
};

collaborationPort.onStream((message: SharedStreamMessage) =>
  emitResponse(message as RendererResponseMessage),
);

const sharedConversationPrefix = "shared:";
const isSharedConversation = (id: string) =>
  id.startsWith(sharedConversationPrefix);
const rawSharedConversationId = (id: string) =>
  id.slice(sharedConversationPrefix.length);

const toRendererSharedConversation = (
  value: SharedConversation,
): TChatConversation =>
  ({
    id: `${sharedConversationPrefix}${value.id}`,
    name: value.name,
    type: "acp",
    created_at: Date.parse(value.created_at),
    modified_at: Date.parse(value.updated_at),
    status: value.state === "running" ? "running" : "finished",
    runtime: {
      state: value.state === "running" ? "running" : "idle",
      can_send_message: true,
      has_task: value.state === "running",
      is_processing: value.state === "running",
      pending_confirmations: 0,
      turn_id: null,
    },
    extra: {
      backend: value.assistant_backend,
      preset_assistant_id: value.assistant_id,
      current_model_id: value.model_id,
      thought_level: value.thinking_effort,
      custom_workspace: true,
      is_project_workspace: true,
      workspace: `shared://${value.project_id}`,
      shared_workspace: `shared://${value.project_id}`,
      pinned: value.pinned,
      pinned_at: value.pinned_at ? Date.parse(value.pinned_at) : undefined,
      shared: {
        conversation_id: value.id,
        project_id: value.project_id,
        project_name: value.project_name,
        role: value.role,
        assistant_id: value.assistant_id,
        assistant_backend: value.assistant_backend,
        model_id: value.model_id,
        thinking_effort: value.thinking_effort,
      },
    },
  }) as TChatConversation;

const sendRendererMessage = async (input: {
  conversation_id: string;
  input: string;
  files?: string[];
  mentions?: Array<{ kind: "assistant" | "member" | "file"; id: string }>;
}) => {
  if (isSharedConversation(input.conversation_id)) {
    const result = await collaborationPort.sendMessage(
      rawSharedConversationId(input.conversation_id),
      input.input,
      input.mentions,
      input.files,
    );
    emitResponse({
      type: "teammate_message",
      data: {
        id: result.message.id,
        msg_id: result.message.id,
        conversation_id: input.conversation_id,
        type: "text",
        position: "right",
        status: "finish",
        created_at: Date.parse(result.message.created_at),
        content: {
          content: result.message.body,
          teammateMessage: true,
          senderName: result.message.author_name,
          senderUserId: result.message.author_user_id
            ? String(result.message.author_user_id)
            : undefined,
        },
      },
      msg_id: result.message.id,
      conversation_id: input.conversation_id,
      created_at: Date.parse(result.message.created_at),
      position: "right",
    });
    return {
      msg_id: result.message.id,
      turn_id: "",
      runtime: { is_processing: result.ai_started, turn_id: null },
    };
  }
  ensureRuntimeSubscription(input.conversation_id);
  const replacements = await materializeConversationFiles(
    input.conversation_id,
    input.files ?? [],
  );
  let runtimeInput = input.input;
  let displayInput = input.input;
  for (const [stagedPath, privatePath] of replacements) {
    runtimeInput = runtimeInput.split(stagedPath).join(privatePath);
    displayInput = displayInput
      .split(stagedPath)
      .join(displayConversationFilePath(stagedPath));
  }
  const msgId = crypto.randomUUID();
  emitResponse({
    type: "user_content",
    data: displayInput,
    msg_id: msgId,
    conversation_id: input.conversation_id,
    created_at: Date.now(),
    position: "right",
  });
  await conversationPort.send(
    input.conversation_id,
    runtimeInput,
    replacements.size === 0 ? undefined : displayInput,
  );
  return {
    msg_id: msgId,
    turn_id: `pending:${msgId}`,
    runtime: { is_processing: true, turn_id: `pending:${msgId}` },
  };
};

const ensureRuntimeSubscription = (sessionId: string) => {
  if (
    runtimeSubscriptions.has(sessionId) ||
    typeof globalThis.EventSource === "undefined"
  )
    return;
  runtimeSubscriptions.set(
    sessionId,
    conversationPort.subscribe(sessionId, (event) => {
      const base = {
        conversation_id: sessionId,
        turn_id: "turnId" in event ? event.turnId : undefined,
        created_at: Date.parse(event.occurredAt),
      };
      if (event.type === "turn.started") {
        emitResponse({
          ...base,
          type: "start",
          data: null,
          msg_id: `turn:${event.turnId}`,
        });
      } else if (event.type === "assistant.delta") {
        emitResponse({
          ...base,
          type: "content",
          data: event.delta,
          msg_id: `assistant:${event.turnId}`,
          status: "pending",
        });
      } else if (event.type === "assistant.completed") {
        emitResponse({
          ...base,
          type: "content",
          data: event.content,
          msg_id: `assistant:${event.turnId}`,
          status: "finish",
          replace: true,
        });
      } else if (event.type === "turn.completed") {
        emitResponse({
          ...base,
          type: "finish",
          data: null,
          msg_id: `turn:${event.turnId}`,
        });
        for (const listener of turnCompletedListeners)
          listener({ conversation_id: sessionId, turn_id: event.turnId });
      } else if (event.type === "turn.failed") {
        emitResponse({
          ...base,
          type: "error",
          data: { code: event.code, message: event.message },
          msg_id: `error:${event.turnId}`,
        });
      } else if (event.type === "turn.cancelled") {
        emitResponse({
          ...base,
          type: "finish",
          data: null,
          msg_id: `turn:${event.turnId}`,
        });
      } else if (event.type === "approval.requested") {
        void conversationPort.pending(sessionId).then((pending) => {
          const interaction = pending.find(
            (item) => item.id === event.approvalId,
          );
          if (!interaction) return;
          const confirmation = {
            ...toRendererConfirmation(interaction),
            conversation_id: sessionId,
          };
          for (const listener of confirmationAddListeners)
            listener(confirmation);
        });
      } else if (event.type === "approval.resolved") {
        const resolved = { conversation_id: sessionId, id: event.approvalId };
        for (const listener of confirmationRemoveListeners) listener(resolved);
      }
    }),
  );
};

const toRendererConversation = (
  session: Awaited<ReturnType<typeof conversationPort.list>>[number],
): TChatConversation =>
  ({
    id: session.id,
    name: session.title,
    type: "acp",
    created_at: Date.parse(session.createdAt),
    modified_at: Date.parse(session.updatedAt),
    source: "workagent",
    status: "finished",
    extra: {
      backend: session.engine,
      workspace: session.workspaceId,
      is_project_workspace: false,
      preset_assistant_id: session.preset.presetId,
      ...(conversationExtras.get(session.id) ?? {}),
    },
  }) as TChatConversation;

const rendererWorkspacePath = (workspace: { id: string; name: string }) =>
  `workagent-workspace:${workspace.id}\\${workspace.name}`;

const runtimeWorkspaceId = (workspace: string | undefined) => {
  if (!workspace?.startsWith("workagent-workspace:"))
    return workspace || "default";
  const separator = workspace.indexOf("\\");
  return separator === -1
    ? workspace.slice("workagent-workspace:".length)
    : workspace.slice("workagent-workspace:".length, separator);
};

export const personalWorkspaceLocation = (
  workspace: string | undefined,
  path: string,
) => {
  if (sharedProjectIDFromPath(workspace)) return null;
  if (!workspace) {
    const normalizedPath = path
      .replaceAll("\\", "/")
      .replace(/\/+/g, "/")
      .replace(/^\//, "");
    const managed = /^workagent-workspace:([^/]+)\/[^/]+(?:\/(.*))?$/.exec(
      normalizedPath,
    );
    if (managed)
      return {
        workspaceId: managed[1]!,
        relativePath: managed[2] ?? "",
      };
    const separator = normalizedPath.indexOf("/");
    if (separator > 0)
      return {
        workspaceId: normalizedPath.slice(0, separator),
        relativePath: normalizedPath.slice(separator + 1),
      };
    return null;
  }
  const workspaceId = runtimeWorkspaceId(workspace);
  const normalizedWorkspace = workspace
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "");
  const normalizedPath = path
    .replaceAll("\\", "/")
    .replace(/\/+/g, "/")
    .replace(/^\//, "");
  const idRoot = workspaceId.replaceAll("\\", "/").replace(/\/$/, "");
  const relativePath = normalizedPath.startsWith(`${normalizedWorkspace}/`)
    ? normalizedPath.slice(normalizedWorkspace.length + 1)
    : normalizedPath.startsWith(`${idRoot}/`)
      ? normalizedPath.slice(idRoot.length + 1)
      : normalizedPath === normalizedWorkspace || normalizedPath === idRoot
        ? ""
        : normalizedPath;
  return { workspaceId, relativePath };
};

const mediaTypeForPath = (path: string) => {
  const extension = path.toLocaleLowerCase().split(".").pop() ?? "";
  return (
    (
      {
        md: "text/markdown; charset=utf-8",
        txt: "text/plain; charset=utf-8",
        json: "application/json; charset=utf-8",
        html: "text/html; charset=utf-8",
        css: "text/css; charset=utf-8",
        js: "text/javascript; charset=utf-8",
        ts: "text/typescript; charset=utf-8",
        csv: "text/csv; charset=utf-8",
        png: "image/png",
        jpg: "image/jpeg",
        jpeg: "image/jpeg",
        gif: "image/gif",
        webp: "image/webp",
        svg: "image/svg+xml",
        pdf: "application/pdf",
        docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      } as Record<string, string>
    )[extension] ?? "application/octet-stream"
  );
};

const bytesToBase64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
};

const personalWorkspaceFiles = async (workspace: string) => {
  const location = personalWorkspaceLocation(workspace, workspace);
  if (!location) return [];
  const result: Array<{
    name: string;
    fullPath: string;
    relativePath: string;
  }> = [];
  const pending = [""];
  while (pending.length > 0) {
    const directory = pending.shift()!;
    for (const entry of await workspacePort.files(
      location.workspaceId,
      directory,
    )) {
      if (entry.kind === "directory") pending.push(entry.path);
      else
        result.push({
          name: entry.name,
          fullPath: `${workspace}/${entry.path}`,
          relativePath: entry.path,
        });
    }
  }
  return result;
};

const unavailableOfficePreview = () => ({
  start: {
    invoke: async (_input: { file_path: string; workspace?: string }) => ({
      url: null,
      error: "OFFICECLI_NOT_FOUND",
    }),
  },
  stop: { invoke: async () => undefined },
  status: {
    on:
      (_listener: (event: { state: "starting" | "installing" }) => void) =>
      () =>
        undefined,
  },
});

const pptPreview = unavailableOfficePreview();
const wordPreview = unavailableOfficePreview();
const excelPreview = unavailableOfficePreview();

const createRendererConversation = async (input: {
  name?: string;
  assistant?: { id?: string };
  extra?: { workspace?: string };
}) => {
  const presetId = input.assistant?.id;
  const preset = presetId
    ? (await presetPort.list()).find((item) => item.id === presetId)
    : undefined;
  const session = await conversationPort.create({
    engine: preset?.engine ?? "harness",
    title: input.name?.trim().slice(0, 200) || "New conversation",
    workspace: runtimeWorkspaceId(input.extra?.workspace),
    ...(presetId ? { presetId } : {}),
  });
  for (const listener of conversationListListeners)
    listener({ conversation_id: session.id, action: "created" });
  return toRendererConversation(session);
};

export const ipcBridge = {
  cron: cronBridge,
  theme: {
    requestCurrent: { invoke: async () => null },
    setActive: {
      invoke: async (theme: Theme) => {
        for (const listener of themeListeners) listener(theme);
      },
    },
    changed: {
      on: (handler: (theme: Theme) => void) => {
        themeListeners.add(handler);
        return () => themeListeners.delete(handler);
      },
    },
  },
  fs: {
    listAvailableSkills: {
      invoke: async () => (await skillPort.list()).map(toRendererSkill),
    },
    listSkillImportHistory: { invoke: async () => [] },
    getSkillImportLimits: {
      invoke: async () => ({
        max_file_bytes: 50 * 1024 * 1024,
        max_total_bytes: 200 * 1024 * 1024,
      }),
    },
    importSkills: {
      invoke: async (_input: { skill_path: string }) => {
        throw new Error("browser_skill_import_requires_file_upload");
      },
    },
    deleteSkill: {
      invoke: async ({ skill_name }: { skill_name: string }) => {
        const skill = (await skillPort.list()).find(
          (entry) => entry.name === skill_name,
        );
        if (!skill) throw new Error("skill_not_found");
        await skillPort.remove(skill.id);
      },
    },
    getFilesByDir: {
      invoke: async ({ dir, root }: { dir: string; root: string }) => {
        const projectId = sharedProjectIDFromPath(root);
        if (!projectId) {
          const location = personalWorkspaceLocation(root, dir);
          if (!location) return [];
          return (
            await workspacePort.files(
              location.workspaceId,
              location.relativePath,
            )
          ).map((entry) => ({
            name: entry.name,
            fullPath: `${root}/${entry.path}`,
            relativePath: entry.path,
            isDir: entry.kind === "directory",
            isFile: entry.kind === "file",
          }));
        }
        const relative = sharedRelativePath(projectId, dir) ?? "";
        const raw = await sharedFileRequest<
          Array<{ name: string; type: string }>
        >(projectId, "dir", { path: dir });
        return sharedDirectoryEntries(raw, root, relative)[0]?.children ?? [];
      },
    },
    listWorkspaceFiles: {
      invoke: async ({ root }: { root: string }) => {
        const projectId = sharedProjectIDFromPath(root);
        if (!projectId) return personalWorkspaceFiles(root);
        const raw = await sharedFileRequest<
          Array<{ name: string; full_path: string; relative_path: string }>
        >(projectId, "list");
        return raw.map((entry) => ({
          name: entry.name,
          fullPath: entry.full_path,
          relativePath: entry.relative_path,
        }));
      },
    },
    getImageBase64: {
      invoke: async ({
        path,
        workspace,
      }: {
        path: string;
        workspace?: string;
      }) => {
        const projectId =
          sharedProjectIDFromPath(workspace) ?? sharedProjectIDFromPath(path);
        if (projectId)
          return sharedFileRequest<string | null>(projectId, "image-base64", {
            path,
          });
        const location = personalWorkspaceLocation(workspace, path);
        if (!location) return "";
        const content = await workspacePort.read(
          location.workspaceId,
          location.relativePath,
        );
        return `data:${mediaTypeForPath(location.relativePath)};base64,${bytesToBase64(content.bytes)}`;
      },
    },
    fetchRemoteImage: {
      invoke: async ({ url }: { url: string }) => {
        const target = new URL(url);
        if (target.protocol !== "http:" && target.protocol !== "https:")
          throw new Error("remote_image_url_invalid");
        const response = await fetch(target, {
          credentials: "omit",
          referrerPolicy: "no-referrer",
        });
        if (!response.ok) throw new Error("remote_image_unavailable");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (bytes.length > 10 * 1024 * 1024)
          throw new Error("remote_image_too_large");
        const mediaType = response.headers.get("content-type") ?? "image/*";
        return `data:${mediaType};base64,${bytesToBase64(bytes)}`;
      },
    },
    readFile: {
      invoke: async ({
        path,
        workspace,
      }: {
        path: string;
        workspace?: string;
      }) => {
        const projectId =
          sharedProjectIDFromPath(workspace) ?? sharedProjectIDFromPath(path);
        if (projectId)
          return sharedFileRequest<string | null>(projectId, "read", { path });
        const location = personalWorkspaceLocation(workspace, path);
        if (!location) return null;
        const content = await workspacePort.read(
          location.workspaceId,
          location.relativePath,
        );
        return new TextDecoder().decode(content.bytes);
      },
    },
    readFileBuffer: {
      invoke: async ({
        path,
        workspace,
      }: {
        path: string;
        workspace?: string;
      }) => {
        const projectId =
          sharedProjectIDFromPath(workspace) ?? sharedProjectIDFromPath(path);
        if (projectId)
          return sharedFileRequest<string | null>(projectId, "read-buffer", {
            path,
          });
        const location = personalWorkspaceLocation(workspace, path);
        if (!location) return null;
        const content = await workspacePort.read(
          location.workspaceId,
          location.relativePath,
        );
        return bytesToBase64(content.bytes);
      },
    },
    writeFile: {
      invoke: async ({
        path,
        data,
        workspace,
      }: {
        path: string;
        data: string;
        workspace?: string;
      }) => {
        const projectId =
          sharedProjectIDFromPath(workspace) ?? sharedProjectIDFromPath(path);
        if (projectId)
          return sharedFileRequest<boolean>(projectId, "write", { path, data });
        const location = personalWorkspaceLocation(workspace, path);
        if (!location) return false;
        await workspacePort.upload(
          location.workspaceId,
          location.relativePath,
          new Blob([data], { type: mediaTypeForPath(location.relativePath) }),
        );
        for (const listener of fileContentListeners)
          listener({
            file_path: path,
            content: data,
            workspace: workspace ?? location.workspaceId,
            relative_path: location.relativePath,
            operation: "write",
          });
        return true;
      },
    },
    getFileMetadata: {
      invoke: async ({
        path,
        workspace,
      }: {
        path: string;
        workspace?: string;
      }) => {
        const projectId =
          sharedProjectIDFromPath(workspace) ?? sharedProjectIDFromPath(path);
        if (projectId)
          return sharedFileRequest<IFileMetadata>(projectId, "metadata", {
            path,
          });
        const location = personalWorkspaceLocation(workspace, path);
        if (!location) throw new Error("browser_workspace_file_unavailable");
        const separator = location.relativePath.lastIndexOf("/");
        const directory =
          separator === -1 ? "" : location.relativePath.slice(0, separator);
        const entry = (
          await workspacePort.files(location.workspaceId, directory)
        ).find((candidate) => candidate.path === location.relativePath);
        if (!entry) throw new Error("workspace_entry_not_found");
        return {
          name: entry.name,
          path,
          size: entry.size,
          type: mediaTypeForPath(entry.path),
          lastModified: Date.parse(entry.modifiedAt),
          isDirectory: entry.kind === "directory",
        } satisfies IFileMetadata;
      },
    },
    removeEntry: {
      invoke: async ({
        path,
        workspace,
      }: {
        path: string;
        workspace?: string;
      }) => {
        const projectId =
          sharedProjectIDFromPath(workspace) ?? sharedProjectIDFromPath(path);
        if (projectId) {
          await sharedFileRequest<null>(projectId, "remove", { path });
          return;
        }
        const location = personalWorkspaceLocation(workspace, path);
        if (!location) throw new Error("browser_workspace_file_unavailable");
        await workspacePort.remove(location.workspaceId, location.relativePath);
        for (const listener of fileContentListeners)
          listener({
            file_path: path,
            content: "",
            workspace: workspace ?? location.workspaceId,
            relative_path: location.relativePath,
            operation: "delete",
          });
      },
    },
    renameEntry: {
      invoke: async ({
        path,
        new_name,
        workspace,
      }: {
        path: string;
        new_name: string;
        workspace?: string;
      }) => {
        const projectId =
          sharedProjectIDFromPath(workspace) ?? sharedProjectIDFromPath(path);
        if (projectId)
          return sharedFileRequest<{ new_path: string }>(projectId, "rename", {
            path,
            new_name,
          });
        const location = personalWorkspaceLocation(workspace, path);
        if (!location) throw new Error("browser_workspace_file_unavailable");
        const separator = location.relativePath.lastIndexOf("/");
        const destination = `${separator === -1 ? "" : location.relativePath.slice(0, separator + 1)}${new_name}`;
        await workspacePort.move(
          location.workspaceId,
          location.relativePath,
          destination,
        );
        return { new_path: `${workspace}/${destination}` };
      },
    },
  },
  workspaceOfficeWatch: {
    start: { invoke: async () => undefined },
    stop: { invoke: async () => undefined },
    fileAdded: { on: () => () => undefined },
  },
  fileStream: {
    contentUpdate: {
      emit: (event: FileContentUpdate) => {
        for (const listener of fileContentListeners) listener(event);
      },
      on: (listener: (event: FileContentUpdate) => void) => {
        fileContentListeners.add(listener);
        return () => fileContentListeners.delete(listener);
      },
    },
  },
  preview: {
    open: {
      emit: (event: PreviewOpenEvent) => {
        for (const listener of previewOpenListeners) listener(event);
      },
      on: (listener: (event: PreviewOpenEvent) => void) => {
        previewOpenListeners.add(listener);
        return () => previewOpenListeners.delete(listener);
      },
    },
  },
  previewHistory: {
    list: { invoke: async () => [] },
    save: { invoke: async () => undefined },
    getContent: { invoke: async () => null },
  },
  fileSnapshot: {
    init: {
      invoke: async () => ({ mode: "snapshot" as const, branch: null }),
    },
    dispose: { invoke: async () => undefined },
    compare: { invoke: async () => ({ staged: [], unstaged: [] }) },
    stageFile: { invoke: async () => undefined },
    stageAll: { invoke: async () => undefined },
    unstageFile: { invoke: async () => undefined },
    unstageAll: { invoke: async () => undefined },
    discardFile: { invoke: async () => undefined },
    resetFile: { invoke: async () => undefined },
    getBaselineContent: { invoke: async () => "" },
  },
  dialog: {
    showOpen: {
      invoke: async (_input?: {
        properties?: string[];
        filters?: Array<{ name: string; extensions: string[] }>;
      }) => [] as string[],
    },
  },
  extensions: {
    getMcpServers: { invoke: async () => [] },
  },
  mode: {
    listProviders: { invoke: () => modelAccessPort.providers() },
    createProvider: {
      invoke: async () => {
        throw new Error("managed_model_catalog_read_only");
      },
    },
    updateProvider: {
      invoke: async (provider: { id: string; api_key?: string }) => {
        if (provider.id !== "managed-workagent-harness") {
          throw new Error("managed_model_catalog_read_only");
        }
        const secret = provider.api_key?.trim();
        if (
          secret === undefined ||
          secret === "" ||
          secret === maskedProviderCredential
        )
          return;
        await providerCredentialPort.put(secret);
      },
    },
    deleteProvider: {
      invoke: async ({ id }: { id: string }) => {
        if (id !== "managed-workagent-harness") {
          throw new Error("managed_model_catalog_read_only");
        }
        await providerCredentialPort.revoke();
      },
    },
  },
  application: {
    systemInfo: {
      invoke: async () => ({ workDir: "", cacheDir: "", logDir: "" }),
    },
    getStartOnBootStatus: { invoke: async () => ({ success: true }) },
    getGpuStatus: { invoke: async () => ({ success: true }) },
    setGpuOverride: { invoke: async () => ({ success: false }) },
    setStartOnBoot: { invoke: async () => ({ success: false }) },
    updateSystemInfo: { invoke: async () => undefined },
    restart: { invoke: async () => ({ success: false }) },
    isDevToolsOpened: { invoke: async () => false },
    openDevTools: { invoke: async () => false },
    getCdpStatus: { invoke: async () => ({ success: false }) },
    updateCdpConfig: { invoke: async () => ({ success: false }) },
    devToolsStateChanged: { on: () => () => undefined },
    logStream: { on: () => () => undefined },
    writeRendererLog: { invoke: async () => undefined },
    getZoomFactor: { invoke: async () => 1 },
    setZoomFactor: {
      invoke: async ({ factor }: { factor: number }) => factor,
    },
  },
  systemSettings: {
    getCloseToTray: { invoke: async () => false },
    setCloseToTray: { invoke: async () => undefined },
  },
  portal: {
    getSystemStatus: { invoke: systemPort.status },
    downloadDiagnostics: {
      invoke: async () => window.location.assign(systemPort.diagnosticsUrl),
    },
    getNotifications: { invoke: notificationPort.list },
    acknowledgeNotification: {
      invoke: ({ id }: { id: string }) => notificationPort.acknowledge(id),
    },
    getMyUsage: {
      invoke: async (): Promise<PortalUsageSummary> => ({
        as_of: new Date().toISOString(),
        providers: [],
      }),
    },
    listProjects: {
      invoke: async () => ({
        projects: (await workspacePort.list()).map((workspace) => ({
          project_id: workspace.id,
          name: workspace.name,
        })),
      }),
    },
    createProject: {
      invoke: async ({ name }: { name: string }) => {
        const workspace = await workspacePort.create(name);
        return { path: rendererWorkspacePath(workspace) };
      },
    },
    listManagedUsers: {
      invoke: async () =>
        requestJson<{
          success: boolean;
          users: PortalManagedUser[];
          kimi_datasource_sources?: string[];
        }>("/api/portal/admin/users"),
    },
    addManagedUser: {
      invoke: async (input: { username: string; portal_password: string }) =>
        requestJson<{ success: boolean; job: PortalProvisionJob }>(
          "/api/portal/admin/users",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    getManagedUserJob: {
      invoke: async ({ id }: { id: string }) =>
        requestJson<{ success: boolean; job: PortalProvisionJob }>(
          `/api/portal/admin/user-jobs?id=${encodeURIComponent(id)}`,
        ),
    },
    getManagedUsersUsage: {
      invoke: async () =>
        requestJson<{
          success: boolean;
          users: Array<{
            username: string;
            resource_usage?: PortalUsageSummary;
            resource_usage_unavailable?: boolean;
          }>;
        }>("/api/portal/admin/users/usage"),
    },
    disableManagedUser: {
      invoke: (input: { username: string }) =>
        requestJson<{ success: boolean }>("/api/portal/admin/users/disable", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    enableManagedUser: {
      invoke: (input: { username: string }) =>
        requestJson<{ success: boolean }>("/api/portal/admin/users/enable", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    resetManagedUserPassword: {
      invoke: (input: { username: string; portal_password: string }) =>
        requestJson<{ success: boolean }>(
          "/api/portal/admin/users/reset-password",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    repairManagedUser: {
      invoke: (input: { username: string; windows_password: string }) =>
        requestJson<{ success: boolean }>("/api/portal/admin/users/repair", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    renameManagedWindowsAccount: {
      invoke: (input: {
        username: string;
        new_windows_username: string;
        windows_password: string;
      }) =>
        requestJson<{ success: boolean }>(
          "/api/portal/admin/users/rename-windows",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    setManagedUserLimits: {
      invoke: (input: {
        username: string;
        limits: {
          memory_bytes: number;
          cpu_percent: number;
          active_processes: number;
        };
      }) =>
        requestJson<{ success: boolean }>(
          "/api/portal/admin/users/set-limits",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    offboardManagedUserRetainingData: {
      invoke: (input: { username: string }) =>
        requestJson<{ success: boolean }>(
          "/api/portal/admin/users/offboard-retain",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    deleteOffboardedManagedUser: {
      invoke: (input: { username: string; confirmation: string }) =>
        requestJson<{ success: boolean }>(
          "/api/portal/admin/users/offboard-delete",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(input),
          },
        ),
    },
    setManagedUserKimiDatasource: {
      invoke: (input: {
        username: string;
        enabled: boolean;
        allowed_sources: string[];
        daily_limit: number;
        monthly_limit: number;
      }) =>
        requestJson<{
          success: boolean;
          kimi_datasource: PortalKimiDatasourceGrant;
        }>("/api/portal/admin/users/kimi-datasource", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    listSkillMarket: {
      invoke: async () =>
        requestJson<{ success: boolean; skills: PortalSkillMarketEntry[] }>(
          "/api/portal/skill-market",
        ),
    },
    publishSkill: {
      invoke: async (input: { skill_name: string }) =>
        requestJson("/api/portal/skill-market", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    installMarketSkill: {
      invoke: async (input: { id: string }) =>
        requestJson("/api/portal/skill-market/install", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    deleteMarketSkill: {
      invoke: async (input: { id: string }) =>
        requestJson(
          `/api/portal/skill-market?id=${encodeURIComponent(input.id)}`,
          { method: "DELETE" },
        ),
    },
    listSharedProjects: {
      invoke: async () => {
        const projects = await collaborationPort.listProjects();
        return { projects: projects.map(toRendererSharedProject) };
      },
    },
    listAllSharedProjects: {
      invoke: async () => {
        const projects = await collaborationPort.listProjects(true);
        return { projects: projects.map(toRendererSharedProject) };
      },
    },
    createSharedProject: {
      invoke: async ({ name }: { name: string }) => ({
        project: toRendererSharedProject(
          await collaborationPort.createProject(name),
        ),
      }),
    },
    createSharedConversation: {
      invoke: async (
        input: Parameters<typeof collaborationPort.createConversation>[0],
      ) => ({
        conversation: await collaborationPort.createConversation(input),
      }),
    },
    getSharedRuntimeOptions: {
      invoke: async ({ backend }: { backend: "codex" | "kimi" }) => {
        const models = (await modelAccessPort.snapshot()).models
          .filter(
            (model) =>
              model.providerId === backend && model.authorization.authorized,
          )
          .map((model) => model.id);
        const defaultModel = models[0] ?? "";
        return {
          backend,
          models,
          thinking_efforts: ["low", "medium", "high"],
          default_model_id: defaultModel,
          default_thinking_effort: "medium",
          model_defaults: Object.fromEntries(
            models.map((model) => [model, "medium"]),
          ),
        };
      },
    },
    listAllSharedConversations: {
      invoke: async () => ({
        conversations: await collaborationPort.listConversations(true),
      }),
    },
    setSharedProjectHidden: {
      invoke: async (input: { project_id: string; hidden: boolean }) => {
        await collaborationPort.setProjectHidden(
          input.project_id,
          input.hidden,
        );
        return { success: true };
      },
    },
    setSharedConversationHidden: {
      invoke: async (input: { conversation_id: string; hidden: boolean }) => ({
        conversation: await collaborationPort.setConversationHidden(
          input.conversation_id,
          input.hidden,
        ),
      }),
    },
    updateSharedConversationModel: {
      invoke: async (input: {
        conversation_id: string;
        model_id?: string;
        thinking_effort?: string;
      }) => ({
        conversation: await collaborationPort.updateConversation(
          input.conversation_id,
          {
            ...(input.model_id === undefined
              ? {}
              : { model_id: input.model_id }),
            ...(input.thinking_effort === undefined
              ? {}
              : { thinking_effort: input.thinking_effort }),
          },
        ),
      }),
    },
    searchSharedUsers: {
      invoke: (input: { q: string }) =>
        requestJson<{
          users: Array<{
            id: number;
            username: string;
            display_name: string;
          }>;
        }>(`/api/portal/shared-users?q=${encodeURIComponent(input.q)}`),
    },
    listSharedMembers: {
      invoke: (input: { project_id: string }) =>
        requestJson<{
          members: Array<{
            id: number;
            username: string;
            display_name: string;
            role: "owner" | "member";
          }>;
        }>(
          `/api/portal/shared-members?project_id=${encodeURIComponent(input.project_id)}`,
        ),
    },
    createSharedInvite: {
      invoke: (input: { project_id: string; target_user_id: number }) =>
        requestJson("/api/portal/shared-invites", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    removeSharedMember: {
      invoke: async (input: { project_id: string; user_id: number }) => {
        await requestJson<void>(
          `/api/portal/shared-projects/${encodeURIComponent(input.project_id)}/members/${input.user_id}`,
          { method: "DELETE" },
        );
        return { success: true };
      },
    },
    leaveSharedProject: {
      invoke: async (input: { project_id: string }) => {
        await requestJson<void>(
          `/api/portal/shared-projects/${encodeURIComponent(input.project_id)}/members/me`,
          { method: "DELETE" },
        );
        return { success: true };
      },
    },
    transferSharedProject: {
      invoke: (input: { project_id: string; new_owner_user_id: number }) =>
        requestJson(
          `/api/portal/shared-projects/${encodeURIComponent(input.project_id)}/ownership`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ targetUserId: input.new_owner_user_id }),
          },
        ),
    },
    createSharedInviteLink: {
      invoke: async () => {
        throw new Error("shared_invite_links_not_available");
      },
    },
    updateProfile: {
      invoke: async (input: {
        display_name: string;
        collaboration_enabled: boolean;
      }) =>
        requestJson("/api/portal/me/profile", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
    },
    restartService: { invoke: systemPort.restartRuntime },
    listSharedInvites: {
      invoke: async () => {
        const result = await requestJson<{ invites: SharedInviteResponse[] }>(
          "/api/portal/shared-invites",
        );
        return { invites: result.invites.map(toRendererSharedInvite) };
      },
    },
    acceptSharedInvite: {
      invoke: async (input: { invite_id: string }) => {
        await requestJson(
          `/api/portal/shared-invites/${encodeURIComponent(input.invite_id)}/accept`,
          { method: "POST" },
        );
        return { success: true };
      },
    },
    declineSharedInvite: {
      invoke: async (input: { invite_id: string }) => {
        await requestJson<void>(
          `/api/portal/shared-invites/${encodeURIComponent(input.invite_id)}/decline`,
          { method: "POST" },
        );
        return { success: true };
      },
    },
  },
  assistants: {
    list: {
      invoke: async () =>
        (await presetPort.list()).map((preset) => ({
          id: preset.id,
          source: preset.source,
          name: preset.name,
          name_i18n: {},
          description: preset.description,
          description_i18n: {},
          ...(preset.avatar ? { avatar: preset.avatar } : {}),
          enabled: preset.enabled,
          sort_order: 0,
          agent_id: preset.engine,
          agent: {
            type: preset.engine === "harness" ? "aionrs" : preset.engine,
            source:
              preset.engine === "harness"
                ? ("internal" as const)
                : ("builtin" as const),
          },
          enabled_skills: preset.skillIds,
          custom_skill_names: [],
          disabled_builtin_skills: [],
          context: preset.systemPrompt,
          context_i18n: {},
          prompts: [],
          prompts_i18n: {},
          models: preset.modelId ? [preset.modelId] : [],
          agent_status: "online" as const,
          team_selectable:
            preset.engine === "codex" || preset.engine === "kimi",
          deletable: preset.source === "user",
        })),
    },
    setState: {
      invoke: async (input: { id: string; enabled: boolean }) => {
        await presetPort.update(input.id, { enabled: input.enabled });
      },
    },
  },
  conversation: {
    listByCronJob: {
      invoke: async ({ cron_job_id }: { cron_job_id: string }) => {
        const runs = await automationPort.history(cron_job_id);
        const sessionIds = [
          ...new Set(
            runs
              .map((run) => run.sessionId)
              .filter((id): id is string => id !== null),
          ),
        ];
        return Promise.all(
          sessionIds.map(async (id) => {
            conversationExtras.set(id, {
              ...(conversationExtras.get(id) ?? {}),
              cron_job_id,
              cronJobId: cron_job_id,
            });
            return toRendererConversation(await conversationPort.get(id));
          }),
        );
      },
    },
    create: { invoke: createRendererConversation },
    createWithConversation: {
      invoke: async ({ conversation }: { conversation: TChatConversation }) =>
        createRendererConversation({
          name: conversation.name,
          assistant: {
            id: String(conversation.extra?.preset_assistant_id ?? ""),
          },
          extra: { workspace: String(conversation.extra?.workspace ?? "") },
        }),
    },
    get: {
      invoke: async ({ id }: { id: string }) => {
        if (isSharedConversation(id))
          return toRendererSharedConversation(
            await collaborationPort.getConversation(
              rawSharedConversationId(id),
            ),
          );
        ensureRuntimeSubscription(id);
        return toRendererConversation(await conversationPort.get(id));
      },
    },
    update: {
      invoke: async ({
        id,
        updates,
        merge_extra,
      }: {
        id: string;
        updates: { name?: string; extra?: Record<string, unknown> };
        merge_extra?: boolean;
      }) => {
        if (isSharedConversation(id)) {
          const sharedUpdates: {
            name?: string;
            pinned?: boolean;
            hidden?: boolean;
          } = {};
          if (typeof updates.name === "string")
            sharedUpdates.name = updates.name;
          if (typeof updates.extra?.pinned === "boolean")
            sharedUpdates.pinned = updates.extra.pinned;
          if (typeof updates.extra?.hidden === "boolean")
            sharedUpdates.hidden = updates.extra.hidden;
          if (Object.keys(sharedUpdates).length > 0)
            await collaborationPort.updateConversation(
              rawSharedConversationId(id),
              sharedUpdates,
            );
          for (const listener of conversationListListeners)
            listener({ conversation_id: id, action: "updated" });
          return true;
        }
        if (updates.name !== undefined)
          await conversationPort.rename(id, updates.name);
        if (updates.extra !== undefined) {
          conversationExtras.set(
            id,
            merge_extra
              ? { ...(conversationExtras.get(id) ?? {}), ...updates.extra }
              : updates.extra,
          );
        }
        for (const listener of conversationListListeners)
          listener({ conversation_id: id, action: "updated" });
        return true;
      },
    },
    remove: {
      invoke: async ({ id }: { id: string }) => {
        await conversationPort.remove(id);
        runtimeSubscriptions.get(id)?.();
        runtimeSubscriptions.delete(id);
        conversationExtras.delete(id);
        for (const listener of conversationListListeners)
          listener({ conversation_id: id, action: "deleted" });
        return true;
      },
    },
    listChanged: {
      emit: (event: ConversationListEvent) => {
        for (const listener of conversationListListeners) listener(event);
      },
      on: (listener: (event: ConversationListEvent) => void) => {
        conversationListListeners.add(listener);
        return () => conversationListListeners.delete(listener);
      },
    },
    confirmation: {
      list: {
        invoke: async ({ conversation_id }: { conversation_id: string }) => {
          ensureRuntimeSubscription(conversation_id);
          return (await conversationPort.pending(conversation_id)).map(
            toRendererConfirmation,
          );
        },
      },
      confirm: {
        invoke: async (input: {
          conversation_id: string;
          msg_id: string;
          data: unknown;
          call_id: string;
          always_allow?: boolean;
        }) => {
          await conversationPort.respond(
            input.call_id,
            confirmationDecision(input.data),
          );
          const event = {
            conversation_id: input.conversation_id,
            id: input.call_id,
          };
          for (const listener of confirmationRemoveListeners) listener(event);
        },
      },
      add: {
        emit: (event: ConfirmationAddEvent) => {
          for (const listener of confirmationAddListeners) listener(event);
        },
        on: (listener: (event: ConfirmationAddEvent) => void) => {
          confirmationAddListeners.add(listener);
          return () => confirmationAddListeners.delete(listener);
        },
      },
      update: { on: () => () => undefined },
      remove: {
        emit: (event: ConfirmationEvent) => {
          for (const listener of confirmationRemoveListeners) listener(event);
        },
        on: (listener: (event: ConfirmationEvent) => void) => {
          confirmationRemoveListeners.add(listener);
          return () => confirmationRemoveListeners.delete(listener);
        },
      },
    },
    sendMessage: {
      invoke: sendRendererMessage,
    },
    stop: {
      invoke: async ({ conversation_id }: { conversation_id: string }) => {
        if (isSharedConversation(conversation_id))
          await collaborationPort.cancelTurn(
            rawSharedConversationId(conversation_id),
          );
        else await conversationPort.cancel(conversation_id);
        return { runtime: { is_processing: false, turn_id: null } };
      },
    },
    ensureRuntime: {
      invoke: async ({ conversation_id }: { conversation_id: string }) => {
        ensureRuntimeSubscription(conversation_id);
        return { is_processing: false, turn_id: null };
      },
    },
    activeLease: { invoke: async () => null },
    getAssociateConversation: { invoke: async () => null },
    getSlashCommands: { invoke: async () => [] },
    listArtifacts: { invoke: async () => [] },
    artifactStream: { on: () => () => undefined },
    getWorkspace: {
      invoke: async ({
        workspace,
        path,
        search,
      }: {
        conversation_id: string;
        workspace: string;
        path: string;
        search?: string;
      }) => {
        const normalizedPath = path.replaceAll("\\", "/");
        const normalizedWorkspace = workspace.replaceAll("\\", "/");
        const relativePath =
          normalizedPath === normalizedWorkspace || normalizedPath === ""
            ? ""
            : normalizedPath.startsWith(`${normalizedWorkspace}/`)
              ? normalizedPath.slice(normalizedWorkspace.length + 1)
              : normalizedPath;
        const sharedProjectId = sharedProjectIDFromPath(workspace);
        if (sharedProjectId) {
          const raw = await sharedFileRequest<
            Array<{ name: string; type: string }>
          >(sharedProjectId, "dir", { path });
          return sharedDirectoryEntries(raw, workspace, relativePath);
        }
        const entries = (
          await workspacePort.files(runtimeWorkspaceId(workspace), relativePath)
        )
          .filter(
            (entry) =>
              !search ||
              entry.name
                .toLocaleLowerCase()
                .includes(search.toLocaleLowerCase()),
          )
          .map((entry) => ({
            name: entry.name,
            fullPath: `${workspace}/${entry.path}`,
            relativePath: entry.path,
            isDir: entry.kind === "directory",
            isFile: entry.kind === "file",
          }));
        const name = relativePath.split("/").pop() || workspace;
        return [
          {
            name,
            fullPath: relativePath ? `${workspace}/${relativePath}` : workspace,
            relativePath,
            isDir: true,
            isFile: false,
            children: entries,
          },
        ];
      },
    },
    responseSearchWorkSpace: { provider: () => () => undefined },
    responseStream: {
      emit: emitResponse,
      on: (listener: (event: RendererResponseMessage) => void) => {
        responseStreamListeners.add(listener);
        return () => responseStreamListeners.delete(listener);
      },
    },
    turnCompleted: {
      on: (
        listener: (event: { conversation_id: string; turn_id: string }) => void,
      ) => {
        turnCompletedListeners.add(listener);
        return () => turnCompletedListeners.delete(listener);
      },
    },
  },
  team: new Proxy(
    {
      get: { invoke: async () => null },
      list: { invoke: async () => [] },
    },
    {
      get: (target, key) => {
        if (key in target) return target[key as keyof typeof target];
        return {
          invoke: async () => undefined,
          on: () => () => undefined,
          emit: () => undefined,
        };
      },
    },
  ),
  task: {
    stopAll: { invoke: async () => ({ success: false }) },
  },
  database: {
    conversations: { invoke: async () => [] },
    getUserConversations: {
      invoke: async (_input: { limit: number }) => {
        const [personal, shared] = await Promise.all([
          conversationPort.list(),
          collaborationPort.listConversations(),
        ]);
        return {
          items: [
            ...shared.map(toRendererSharedConversation),
            ...personal.map(toRendererConversation),
          ],
        };
      },
    },
    searchConversationMessages: {
      invoke: async () => ({ items: [], next_cursor: null }),
    },
  },
  windowControls: {
    getState: { invoke: async () => ({ is_maximized: false }) },
    stateChanged: { on: () => () => undefined },
    maximizedChanged: { on: () => () => undefined },
    minimize: { invoke: async () => undefined },
    maximize: { invoke: async () => undefined },
    unmaximize: { invoke: async () => undefined },
    close: { invoke: async () => undefined },
  },
  shell: {
    openExternal: {
      invoke: async (url: string) => {
        window.open(url, "_blank", "noopener,noreferrer");
      },
    },
    openFile: {
      invoke: async (path: string) => {
        const location = personalWorkspaceLocation(undefined, path);
        if (!location) throw new Error("browser_workspace_file_unavailable");
        window.open(
          workspacePort.downloadUrl(
            location.workspaceId,
            location.relativePath,
          ),
          "_blank",
          "noopener,noreferrer",
        );
      },
    },
  },
  pptPreview,
  wordPreview,
  excelPreview,
  acpConversation: new Proxy(
    {
      sendMessage: {
        invoke: sendRendererMessage,
      },
      responseStream: {
        emit: emitResponse,
        on: (listener: (event: RendererResponseMessage) => void) => {
          responseStreamListeners.add(listener);
          return () => responseStreamListeners.delete(listener);
        },
      },
      getManagedAgents: { invoke: getManagedAgents },
      checkManagedAgentHealthById: {
        invoke: async ({ id }: { id: string }) => {
          const agent = (await getManagedAgents()).find(
            (item) => item.id === id,
          );
          if (!agent) throw new Error("engine_not_found");
          return agent;
        },
      },
      checkProviderHealth: {
        invoke: async ({
          provider_id,
        }: {
          provider_id: string;
          model?: string;
        }) => {
          if (provider_id !== "managed-workagent-harness")
            return {
              status: "unknown",
              message: "managed_health_status_only",
              elapsed_ms: 0,
            };
          return providerCredentialPort.test();
        },
      },
    },
    {
      get: (target, key) => {
        if (key in target) return target[key as keyof typeof target];
        return {
          invoke: async () => {
            throw new Error(`unsupported_browser_agent_command:${String(key)}`);
          },
          on: () => () => undefined,
          emit: () => undefined,
        };
      },
    },
  ),
};
