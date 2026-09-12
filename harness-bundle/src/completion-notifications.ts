import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import {
  basename,
  dirname,
  join,
  isAbsolute,
  relative,
  resolve,
} from "node:path";
import type { WorkspaceStore } from "./workspace-store.js";
import {
  collaborationId,
  type CollaborationChannels,
} from "./collaboration-channels.js";

export type NotificationTarget = {
  id: string;
  label: string;
  connected: boolean;
  channelId: string;
  chatId: string;
  kind: "dm" | "group";
  supportsFiles?: boolean;
};
export type NotificationTransport = {
  targets(): NotificationTarget[];
  send(targetId: string, text: string, sessionId?: string): Promise<void>;
  sendFile?(targetId: string, path: string): Promise<void>;
  active?(): boolean;
};
export type Completion = {
  collaboration?: {
    conversationId: string;
    projectName: string;
    assistantName: string;
  };
  source?: "im" | "web";
  sessionId: string;
  turnId: string;
  title: string;
  reply: string;
  workspaceId: string;
  startedAt: string;
  notification?: {
    enabled: boolean;
    targetId: string;
    attachFiles?: boolean;
  };
};

export function splitNotification(text: string) {
  const parts: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (Buffer.byteLength(current + "\n" + line) > 1800 && current) {
      parts.push(current);
      current = "";
    }
    if (current) current += "\n";
    for (const point of line) {
      if (Buffer.byteLength(current + point) > 1800) {
        parts.push(current);
        current = "";
      }
      current += point;
    }
  }
  if (current) parts.push(current);
  return parts;
}
type Settings = { enabled: boolean; targetId: string; attachFiles?: boolean };
type SessionSettings = { enabled: boolean; targetId: string };
type DeliveryFile = { workspaceId: string; path: string; name: string };
type Delivery = {
  id: string;
  title: string;
  sessionId: string;
  targetId: string;
  targetLabel: string;
  messages: string[];
  next: number;
  status: "pending" | "sending" | "sent" | "failed" | "cancelled";
  error: string;
  createdAt: string;
  files?: DeliveryFile[];
  nextFile?: number;
  scope?: "global" | "session" | "automation";
};

export async function completionMessage(
  completion: Completion,
  baseURL: string,
  workspaces: WorkspaceStore,
  files?: DeliveryFile[],
) {
  const origin = new URL(baseURL).origin;
  const conversation = completion.collaboration
    ? `${origin}/?frontend=dsh&workagent=shared&project=${encodeURIComponent(completion.workspaceId)}&discussion=${encodeURIComponent(completion.collaboration.conversationId)}`
    : `${origin}/?frontend=dsh&session=${encodeURIComponent(completion.sessionId)}`;
  const contentURL = (path: string) =>
    completion.collaboration
      ? `${origin}/api/portal/shared-workspaces/${encodeURIComponent(completion.workspaceId)}/content?path=${encodeURIComponent(path)}`
      : `${origin}/api/runtime/v1/workspaces/${encodeURIComponent(completion.workspaceId)}/content?path=${encodeURIComponent(path)}`;
  const candidates = new Map<string, string>();
  for (const asset of workspaces.listAssets(
    completion.workspaceId,
    completion.sessionId,
  )) {
    if (asset.kind === "artifact" && asset.createdAt >= completion.startedAt)
      candidates.set(asset.path, asset.name);
  }
  const root = workspaces.engineRoot(completion.workspaceId);
  let reply = completion.reply;
  const matches = [...reply.matchAll(/\[([^\]\n]+)\]\((<[^>]+>|[^)\n]+)\)/g)];
  for (const match of matches) {
    const raw = match[2]!.replace(/^<|>$/g, "").replace(/^sandbox:/, "");
    if (/^[a-z]+:\/\//i.test(raw) && !raw.startsWith("file:")) continue;
    let path: string;
    try {
      const decoded = decodeURIComponent(raw).replace(/^file:\/\//, "");
      path = relative(
        root,
        isAbsolute(decoded) ? decoded : resolve(root, decoded),
      ).replaceAll("\\", "/");
      // The workspace reader rejects traversal and symlinks before publishing a link.
      const file = await workspaces.readStream(completion.workspaceId, path);
      file.stream.destroy();
    } catch {
      continue;
    }
    candidates.set(path, match[1]!);
    const url = contentURL(path);
    reply = reply.replace(match[0], `[${match[1]}](${url})`);
  }
  const artifacts: string[] = [];
  for (const [path, name] of candidates) {
    try {
      const file = await workspaces.readStream(completion.workspaceId, path);
      file.stream.destroy();
      if (file.size <= 50 * 1024 * 1024)
        files?.push({
          workspaceId: completion.workspaceId,
          path,
          name: basename(path),
        });
      artifacts.push(`${name}\n${contentURL(path)}`);
    } catch {
      /* Removed or moved files are not advertised as downloadable. */
    }
  }
  return [
    `${completion.collaboration ? "协作 Agent 已完成" : "任务已完成"}：${completion.title}`,
    `项目：${completion.collaboration?.projectName || workspaces.get(completion.workspaceId)?.name || completion.workspaceId}`,
    ...(completion.collaboration
      ? [`Agent：${completion.collaboration.assistantName}`]
      : []),
    reply || "任务已完成，请打开会话查看结果。",
    ...(artifacts.length
      ? ["产物（登录 WorkAgent 后下载）", ...artifacts]
      : []),
    `查看会话\n${conversation}`,
    completion.collaboration
      ? "协作暂不支持直接发消息或控制执行，请去网页操作。/历史 [n] 查看消息。"
      : `当前聊天已关联到该任务，直接回复即可继续。`,
  ].join("\n\n");
}

// Durable per-employee delivery state. Each successful chunk is checkpointed;
// failed/ambiguous delivery is visible and requires an explicit retry.
export class CompletionNotifications {
  readonly #path: string;
  readonly #workspaces: WorkspaceStore;
  readonly #baseURL: string;
  #settings: Settings = { enabled: false, targetId: "" };
  #lastTargetId = "";
  #deliveries: Delivery[] = [];
  #transport: NotificationTransport | undefined;
  #running = new Set<string>();
  #mutedSessions = new Set<string>();
  #sessionSettings = new Map<string, SessionSettings>();
  #collaboration?: CollaborationChannels;

  attachCollaboration(channels: CollaborationChannels) {
    this.#collaboration = channels;
  }
  enabledFor(id: string) {
    return (
      this.#sessionSettings.get(id)?.enabled === true ||
      (this.#settings.enabled && !this.#mutedSessions.has(id))
    );
  }

  constructor(home: string, workspaces: WorkspaceStore, publicBaseURL = "") {
    this.#baseURL = publicBaseURL.trim();
    if (this.#baseURL) {
      const url = new URL(this.#baseURL);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.pathname !== "/" ||
        url.search ||
        url.hash
      )
        throw new Error("WorkAgent publicBaseURL must be an HTTP(S) origin");
      this.#baseURL = url.origin;
    }
    this.#path = join(home, "workagent", "completion-notifications.json");
    this.#workspaces = workspaces;
    if (existsSync(this.#path)) {
      const saved = JSON.parse(readFileSync(this.#path, "utf8"));
      this.#settings = {
        enabled: saved.settings.enabled,
        targetId: saved.settings.targetId,
        attachFiles: saved.settings.attachFiles === true,
      };
      this.#lastTargetId =
        typeof saved.lastTargetId === "string"
          ? saved.lastTargetId
          : this.#settings.targetId;
      this.#deliveries = saved.deliveries;
      this.#mutedSessions = new Set(saved.mutedSessions ?? []);
      this.#sessionSettings = new Map(
        Object.entries(saved.sessionSettings ?? {}).filter(
          ([, value]) =>
            typeof value === "object" &&
            value !== null &&
            typeof (value as SessionSettings).enabled === "boolean" &&
            typeof (value as SessionSettings).targetId === "string",
        ) as [string, SessionSettings][],
      );
      for (const delivery of this.#deliveries) {
        if (delivery.status === "sending") {
          delivery.status = "failed";
          delivery.error = "运行环境重启，发送结果未确认，请检查聊天后重试。";
        }
      }
      this.#save();
    }
  }

  attach(transport: NotificationTransport) {
    this.#transport = transport;
    for (const delivery of this.#deliveries)
      if (delivery.status === "pending") void this.#send(delivery);
    return () => {
      if (this.#transport === transport) this.#transport = undefined;
    };
  }

  snapshot() {
    return {
      ...this.#settings,
      lastTargetId: this.#lastTargetId,
      mutedSessions: [...this.#mutedSessions],
      sessionSettings: Object.fromEntries(this.#sessionSettings),
      channelActive: this.#transport?.active?.() ?? false,
      targets: this.#transport?.targets() ?? [],
      deliveries: this.#deliveries
        .slice(-30)
        .reverse()
        .map(({ messages, next, ...delivery }) => ({
          ...delivery,
          sentParts: next,
          totalParts: messages.length,
          sentFiles: delivery.nextFile ?? 0,
          totalFiles: delivery.files?.length ?? 0,
        })),
    };
  }

  configure(input: Settings) {
    if (
      typeof input.enabled !== "boolean" ||
      typeof input.targetId !== "string"
    )
      throw new Error("提醒设置格式不正确");
    if (input.enabled && !this.#baseURL)
      throw new Error("管理员尚未配置 WorkAgent 对外访问地址");
    if (
      input.enabled &&
      !this.#transport
        ?.targets()
        .some((target) => target.id === input.targetId && target.connected)
    )
      throw new Error("请选择已连接的接收聊天");
    if (
      input.enabled &&
      input.attachFiles &&
      !this.#transport
        ?.targets()
        .some((target) => target.id === input.targetId && target.supportsFiles)
    )
      throw new Error("此渠道暂不支持文件发送，请关闭附带文件后保存");
    this.#settings = {
      enabled: input.enabled,
      targetId: input.targetId,
      attachFiles: input.attachFiles === true,
    };
    if (input.targetId) this.#lastTargetId = input.targetId;
    if (!input.enabled)
      for (const delivery of this.#deliveries) {
        if (
          (delivery.scope ?? "global") === "global" &&
          (delivery.status === "pending" || delivery.status === "sending")
        )
          delivery.status = "cancelled";
      }
    this.#save();
    return this.snapshot();
  }

  configureSession(sessionId: string, enabled: boolean, targetId = "") {
    if (enabled) {
      const selectedTargetId = targetId || this.#settings.targetId;
      this.#validateTarget(selectedTargetId);
      this.#sessionSettings.set(sessionId, {
        enabled: true,
        targetId: selectedTargetId,
      });
      this.#lastTargetId = selectedTargetId;
      this.#mutedSessions.delete(sessionId);
    } else {
      this.#sessionSettings.delete(sessionId);
      this.#mutedSessions.add(sessionId);
      for (const delivery of this.#deliveries)
        if (
          delivery.sessionId === sessionId &&
          ["pending", "sending"].includes(delivery.status)
        )
          delivery.status = "cancelled";
    }
    this.#save();
    return this.snapshot();
  }

  targets() {
    return (this.#transport?.targets() ?? []).filter(
      (target) => target.connected,
    );
  }

  async sendMessage(input: {
    targetId: string;
    text?: string;
    workspaceId?: string;
    filePath?: string;
  }) {
    const target = this.targets().find((row) => row.id === input.targetId);
    if (!target) throw new Error("请选择已连接的接收聊天");
    const text = input.text?.trim() ?? "";
    const filePath = input.filePath?.trim() ?? "";
    if (!text && !filePath) throw new Error("请输入消息或选择文件");
    if (text)
      for (const part of splitNotification(text))
        await this.#transport!.send(target.id, part);
    if (filePath) {
      if (!input.workspaceId) throw new Error("发送文件时需要项目 ID");
      if (!target.supportsFiles || !this.#transport?.sendFile)
        throw new Error("此渠道暂不支持文件发送");
      await this.#sendWorkspaceFile(target.id, input.workspaceId, filePath);
    }
    this.#lastTargetId = target.id;
    this.#save();
    return { targetId: target.id, targetLabel: target.label, sent: true };
  }

  async complete(completion: Completion) {
    if (!this.#baseURL || completion.source === "im") return;
    const session = this.#sessionSettings.get(completion.sessionId);
    const selected =
      completion.notification !== undefined
        ? {
            ...completion.notification,
            scope: "automation" as const,
          }
        : session?.enabled
          ? {
              enabled: true,
              targetId: session.targetId,
              attachFiles: this.#settings.attachFiles,
              scope: "session" as const,
            }
          : this.#mutedSessions.has(completion.sessionId)
            ? undefined
            : {
                ...this.#settings,
                scope: "global" as const,
              };
    if (!selected?.enabled || !selected.targetId) return;
    const id = `${completion.sessionId}:${completion.turnId}`;
    if (
      this.#deliveries.some((delivery) => delivery.id === id) ||
      this.#running.has(id)
    )
      return;
    this.#running.add(id);
    const settings = { ...selected };
    try {
      const files: DeliveryFile[] = [];
      const text = await completionMessage(
        completion,
        this.#baseURL,
        completion.collaboration
          ? (
              await this.#collaboration!.workspace(
                completion.collaboration.conversationId,
              )
            ).store
          : this.#workspaces,
        settings.attachFiles ? files : undefined,
      );
      if (completion.collaboration)
        for (const file of files) file.workspaceId = completion.sessionId;
      if (!this.#deliveryEnabled(completion.sessionId, settings.scope)) return;
      const target = this.#transport
        ?.targets()
        .find((row) => row.id === settings.targetId);
      const messages = splitNotification(text);
      const delivery: Delivery = {
        id,
        title: completion.title,
        sessionId: completion.sessionId,
        targetId: settings.targetId,
        targetLabel: target?.label ?? "原接收聊天",
        messages,
        next: 0,
        status: "pending",
        error: "",
        createdAt: new Date().toISOString(),
        files,
        nextFile: 0,
        scope: settings.scope,
      };
      this.#deliveries.push(delivery);
      this.#save();
      await this.#send(delivery);
    } finally {
      this.#running.delete(id);
    }
  }

  async retry(id: string) {
    const delivery = this.#deliveries.find((row) => row.id === id);
    if (!delivery || delivery.status !== "failed" || this.#running.has(id))
      throw new Error("该提醒当前不能重试");
    if (!this.#deliveryEnabled(delivery.sessionId, delivery.scope ?? "global"))
      throw new Error("请先开启这项消息提醒");
    this.#running.add(id);
    try {
      await this.#send(delivery);
    } finally {
      this.#running.delete(id);
    }
  }

  async #send(delivery: Delivery) {
    if (!this.#deliveryEnabled(delivery.sessionId, delivery.scope ?? "global"))
      return;
    delivery.status = "sending";
    delivery.error = "";
    this.#save();
    try {
      while (delivery.next < delivery.messages.length) {
        const sharedId = collaborationId(delivery.sessionId);
        if (sharedId) await this.#collaboration!.access(sharedId);
        if (
          !this.#deliveryEnabled(
            delivery.sessionId,
            delivery.scope ?? "global",
          ) ||
          delivery.status === ("cancelled" as string)
        )
          return;
        const transport = this.#transport;
        if (
          !transport
            ?.targets()
            .some((row) => row.id === delivery.targetId && row.connected)
        )
          throw new Error("接收聊天不可用，请连接原渠道后重试。");
        await transport.send(
          delivery.targetId,
          delivery.messages[delivery.next]!,
          delivery.sessionId,
        );
        delivery.next++;
        this.#save();
      }
      for (; (delivery.nextFile ?? 0) < (delivery.files?.length ?? 0); ) {
        if (
          !this.#deliveryEnabled(
            delivery.sessionId,
            delivery.scope ?? "global",
          ) ||
          delivery.status === ("cancelled" as string)
        )
          return;
        const transport = this.#transport;
        if (
          !transport?.sendFile ||
          !transport
            .targets()
            .some(
              (target) =>
                target.id === delivery.targetId &&
                target.connected &&
                target.supportsFiles,
            )
        )
          throw new Error("此渠道暂不支持文件发送");
        const item = delivery.files![delivery.nextFile ?? 0]!;
        await this.#sendWorkspaceFile(
          delivery.targetId,
          item.workspaceId,
          item.path,
        );
        delivery.nextFile = (delivery.nextFile ?? 0) + 1;
        this.#save();
      }
      if (
        this.#deliveryEnabled(delivery.sessionId, delivery.scope ?? "global") &&
        delivery.status !== ("cancelled" as string)
      )
        delivery.status = "sent";
    } catch {
      if (delivery.status !== ("cancelled" as string)) {
        delivery.status = "failed";
        delivery.error =
          "发送失败，请检查渠道连接、机器人主动发送权限及接收聊天后重试。";
      }
    }
    this.#save();
  }

  #save() {
    mkdirSync(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temp = `${this.#path}.tmp`;
    writeFileSync(
      temp,
      JSON.stringify({
        settings: this.#settings,
        lastTargetId: this.#lastTargetId,
        deliveries: this.#deliveries,
        mutedSessions: [...this.#mutedSessions],
        sessionSettings: Object.fromEntries(this.#sessionSettings),
      }),
      { mode: 0o600 },
    );
    renameSync(temp, this.#path);
  }

  #validateTarget(targetId: string) {
    if (!this.#baseURL)
      throw new Error("管理员尚未配置 WorkAgent 对外访问地址");
    if (
      !this.#transport
        ?.targets()
        .some((target) => target.id === targetId && target.connected)
    )
      throw new Error("请选择已连接的接收聊天");
  }

  async #sendWorkspaceFile(
    targetId: string,
    workspaceId: string,
    filePath: string,
  ) {
    const sharedId = collaborationId(workspaceId);
    const shared = sharedId
      ? await this.#collaboration!.workspace(sharedId)
      : undefined;
    const file = await (shared?.store ?? this.#workspaces).readStream(
      shared?.projectId ?? workspaceId,
      filePath,
    );
    const chunks: Buffer[] = [];
    try {
      let size = 0;
      for await (const chunk of file.stream) {
        size += chunk.length;
        if (size > 50 * 1024 * 1024) throw new Error("发送文件不能超过 50 MB");
        chunks.push(Buffer.from(chunk));
      }
    } finally {
      file.stream.destroy();
    }
    const staging = mkdtempSync(
      join(dirname(this.#path), "notification-file-"),
    );
    try {
      const path = join(staging, basename(filePath));
      writeFileSync(path, Buffer.concat(chunks), { mode: 0o600 });
      await this.#transport!.sendFile!(targetId, path);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }

  #deliveryEnabled(
    sessionId: string,
    scope: "global" | "session" | "automation",
  ) {
    if (scope === "automation") return true;
    if (scope === "session")
      return this.#sessionSettings.get(sessionId)?.enabled === true;
    return this.#settings.enabled && !this.#mutedSessions.has(sessionId);
  }
}
