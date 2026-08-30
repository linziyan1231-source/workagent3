import {
  lazy,
  Suspense,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import type {
  EngineEvent,
  EngineId,
  EngineStatus,
  PendingInteraction,
  PresetDefinition,
  PresetMutation,
  RuntimeSession,
  RuntimeMessage,
  RuntimeMcpServer,
  SkillCatalogEntry,
  WorkspaceAsset,
} from "@workagent/contracts";
import type { AuthUser } from "../../shared/types/auth.js";
import { conversationPort, type ConversationPort } from "./conversationPort.js";
import { AionSendBox } from "../../shared/ui/aionui/AionSendBox.js";
import { AionSettingsModal } from "../../shared/ui/aionui/AionSettingsModal.js";
import { AionSider } from "../../shared/ui/aionui/AionSider.js";
import type { AutomationUiPort } from "../../shared/ui/aionui/AionAutomationPage.js";
import { AionGuidEmptyState } from "../../shared/ui/aionui/AionGuidEmptyState.js";
import { AionMessage } from "../../shared/ui/aionui/AionMessage.js";
import RendererLayout from "@renderer/components/layout/Layout";
import {
  WORKSPACE_STATE_EVENT,
  WORKSPACE_TOGGLE_EVENT,
  dispatchWorkspaceStateEvent,
} from "@renderer/utils/workspace/workspaceEvents";

const AionPresetPage = lazy(() =>
  import("../../shared/ui/aionui/AionPresetPage.js").then((module) => ({
    default: module.AionPresetPage,
  })),
);

const AionAutomationPage = lazy(() =>
  import("../../shared/ui/aionui/AionAutomationPage.js").then((module) => ({
    default: module.AionAutomationPage,
  })),
);

export type Message = Pick<RuntimeMessage, "id" | "role" | "text">;

export function reduceMessages(
  messages: readonly Message[],
  event: EngineEvent,
): Message[] {
  const list = [...messages];
  if (event.type === "turn.failed") {
    list.push({
      id: event.eventId,
      role: "assistant",
      text: `I couldn't finish that request: ${event.message}`,
    });
  }
  if (event.type === "assistant.delta") {
    const last = list.at(-1);
    if (last?.role === "assistant" && last.id === event.turnId) {
      list[list.length - 1] = { ...last, text: last.text + event.delta };
    } else {
      list.push({ id: event.turnId, role: "assistant", text: event.delta });
    }
  }
  if (event.type === "assistant.completed") {
    const existing = list.findIndex((message) => message.id === event.turnId);
    const completed = {
      id: event.turnId,
      role: "assistant" as const,
      text: event.content,
    };
    if (existing === -1) list.push(completed);
    else list[existing] = completed;
  }
  return list;
}

type Props = {
  user: AuthUser;
  onLogout: () => Promise<void>;
  port?: ConversationPort;
  workspaceId?: string;
  workspacePanel?: ReactNode;
  onWorkspaceSelect?: (workspaceId: string) => void;
  assetPort?: {
    list(workspaceId: string, sessionId: string): Promise<WorkspaceAsset[]>;
    attach(
      workspaceId: string,
      sessionId: string,
      file: File,
    ): Promise<WorkspaceAsset>;
    downloadUrl(workspaceId: string, path: string): string;
  };
  presetPort?: {
    list(): Promise<PresetDefinition[]>;
    create(input: PresetMutation): Promise<PresetDefinition>;
    update(
      id: string,
      input: Partial<PresetMutation>,
    ): Promise<PresetDefinition>;
    copy(id: string, name: string): Promise<PresetDefinition>;
    remove(id: string): Promise<void>;
  };
  capabilityPort?: {
    skills(): Promise<SkillCatalogEntry[]>;
    mcpServers(): Promise<RuntimeMcpServer[]>;
  };
  automationPort?: AutomationUiPort;
};

export function ConversationPage({
  user,
  onLogout,
  port = conversationPort,
  workspaceId,
  workspacePanel,
  onWorkspaceSelect,
  assetPort,
  presetPort,
  capabilityPort,
  automationPort,
}: Props) {
  const [sessions, setSessions] = useState<RuntimeSession[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [interactions, setInteractions] = useState<
    Record<string, PendingInteraction[]>
  >({});
  const [resolving, setResolving] = useState<string>();
  const [query, setQuery] = useState("");
  const [running, setRunning] = useState<string[]>([]);
  const [engine, setEngine] = useState<EngineId>("harness");
  const [engineStatuses, setEngineStatuses] = useState<EngineStatus[]>([]);
  const [presets, setPresets] = useState<PresetDefinition[]>([]);
  const [skills, setSkills] = useState<SkillCatalogEntry[]>([]);
  const [mcpServers, setMcpServers] = useState<RuntimeMcpServer[]>([]);
  const [presetId, setPresetId] = useState("builtin-general");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [assets, setAssets] = useState<Record<string, WorkspaceAsset[]>>({});
  const [stagedAssets, setStagedAssets] = useState<Record<string, string[]>>(
    {},
  );
  const [workspaceOpen, setWorkspaceOpen] = useState(
    () => typeof window !== "undefined" && window.innerWidth > 1080,
  );
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assistantsOpen, setAssistantsOpen] = useState(false);
  const [scheduledOpen, setScheduledOpen] = useState(false);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const active = sessions.find((session) => session.id === activeId);
  const activeMessages = useMemo(
    () => (activeId ? (messages[activeId] ?? []) : []),
    [activeId, messages],
  );
  const activeInteractions = activeId ? (interactions[activeId] ?? []) : [];
  const activeAssets = activeId ? (assets[activeId] ?? []) : [];
  const activeStaged = activeId ? (stagedAssets[activeId] ?? []) : [];
  const selectedEngine = engineStatuses.find((item) => item.id === engine);
  const engineBlocked =
    selectedEngine?.state === "needs_auth" ||
    selectedEngine?.state === "unavailable";
  const isGuid =
    active === undefined ||
    (activeMessages.length === 0 &&
      activeInteractions.length === 0 &&
      !running.includes(active.id));

  useEffect(() => {
    void port
      .engines()
      .then(setEngineStatuses)
      .catch(() => setNotice("Engine status is temporarily unavailable."));
    void port
      .list()
      .then((items) => {
        setSessions(items);
        setActiveId(items[0]?.id);
        if (items[0] !== undefined) onWorkspaceSelect?.(items[0].workspaceId);
      })
      .catch(() => setNotice("Your runtime is starting. Try again shortly."));
    void presetPort
      ?.list()
      .then(setPresets)
      .catch(() => setNotice("Assistant presets could not be loaded."));
    void capabilityPort
      ?.skills()
      .then(setSkills)
      .catch(() => setSkills([]));
    void capabilityPort
      ?.mcpServers()
      .then(setMcpServers)
      .catch(() => setMcpServers([]));
  }, [capabilityPort, onWorkspaceSelect, port, presetPort]);

  useEffect(() => {
    if (active === undefined) return;
    setEngine(active.engine);
    setPresetId(active.preset.presetId);
  }, [active]);

  useEffect(() => {
    if (active === undefined || assetPort === undefined) return;
    onWorkspaceSelect?.(active.workspaceId);
    void assetPort
      .list(active.workspaceId, active.id)
      .then((items) =>
        setAssets((current) => ({ ...current, [active.id]: items })),
      )
      .catch(() => setNotice("Session attachments could not be refreshed."));
  }, [active, assetPort, onWorkspaceSelect]);

  useEffect(() => {
    if (!activeId) return;
    void port
      .pending(activeId)
      .then((items) =>
        setInteractions((current) => ({ ...current, [activeId]: items })),
      )
      .catch(() => setNotice("Pending approvals could not be refreshed."));
    void port
      .messages(activeId)
      .then((items) =>
        setMessages((current) => {
          const merged = new Map<string, Message>(
            items.map(({ id, role, text }) => [id, { id, role, text }]),
          );
          for (const message of current[activeId] ?? [])
            merged.set(message.id, message);
          return { ...current, [activeId]: [...merged.values()] };
        }),
      )
      .catch(() => setNotice("Conversation history could not be refreshed."));
    return port.subscribe(activeId, (event) => applyEvent(activeId, event));
  }, [activeId, port]);

  useEffect(() => {
    const toggleWorkspace = () => setWorkspaceOpen((open) => !open);
    window.addEventListener(WORKSPACE_TOGGLE_EVENT, toggleWorkspace);
    return () =>
      window.removeEventListener(WORKSPACE_TOGGLE_EVENT, toggleWorkspace);
  }, []);

  useEffect(() => {
    dispatchWorkspaceStateEvent(!workspaceOpen);
  }, [workspaceOpen]);

  function applyEvent(sessionId: string, event: EngineEvent) {
    if (event.type === "turn.started") {
      setRunning((current) =>
        current.includes(sessionId) ? current : [...current, sessionId],
      );
    }
    if (
      event.type === "assistant.completed" ||
      event.type === "turn.completed" ||
      event.type === "turn.failed" ||
      event.type === "turn.cancelled"
    ) {
      setRunning((current) => current.filter((id) => id !== sessionId));
    }
    if (event.type === "approval.requested") {
      void port
        .pending(sessionId)
        .then((items) =>
          setInteractions((current) => ({ ...current, [sessionId]: items })),
        );
      return;
    }
    if (event.type === "approval.resolved") {
      setInteractions((current) => ({
        ...current,
        [sessionId]: (current[sessionId] ?? []).filter(
          (item) => item.id !== event.approvalId,
        ),
      }));
      return;
    }
    if (
      event.type !== "assistant.delta" &&
      event.type !== "assistant.completed" &&
      event.type !== "turn.failed"
    )
      return;
    setMessages((current) => {
      return {
        ...current,
        [sessionId]: reduceMessages(current[sessionId] ?? [], event),
      };
    });
  }

  async function resolveInteraction(
    interaction: PendingInteraction,
    decision: "allow" | "reject",
  ) {
    setResolving(interaction.id);
    setNotice("");
    try {
      await port.respond(interaction.id, decision);
      setInteractions((current) => ({
        ...current,
        [interaction.sessionId]: (current[interaction.sessionId] ?? []).filter(
          (item) => item.id !== interaction.id,
        ),
      }));
    } catch {
      setNotice(
        "That approval is no longer pending. The action stayed blocked.",
      );
    } finally {
      setResolving(undefined);
    }
  }

  async function newSession() {
    setBusy(true);
    setNotice("");
    try {
      const session = await port.create({
        engine,
        title: "New conversation",
        workspace: workspaceId ?? "default",
        presetId,
      });
      setSessions((current) => [session, ...current]);
      setActiveId(session.id);
      onWorkspaceSelect?.(session.workspaceId);
      setSidebarOpen(false);
    } catch {
      setNotice(
        engine === "harness"
          ? "The personal runtime is unavailable."
          : `${engine === "codex" ? "Codex" : "Kimi"} is not enabled yet.`,
      );
    } finally {
      setBusy(false);
    }
  }

  async function send(content: string) {
    let sessionId = activeId;
    if (!sessionId) {
      try {
        const session = await port.create({
          engine,
          title: content.slice(0, 48) || "New conversation",
          workspace: workspaceId ?? "default",
          presetId,
        });
        sessionId = session.id;
        setSessions((current) => [session, ...current]);
        setActiveId(session.id);
        onWorkspaceSelect?.(session.workspaceId);
      } catch {
        setNotice("The personal runtime is unavailable.");
        return;
      }
    }
    setMessages((current) => ({
      ...current,
      [sessionId]: [
        ...(current[sessionId] ?? []),
        { id: crypto.randomUUID(), role: "user", text: content },
      ],
    }));
    try {
      const referenced = activeAssets.filter((asset) =>
        activeStaged.includes(asset.id),
      );
      const prompt =
        referenced.length === 0
          ? content
          : `${content}\n\nAttached workspace files:\n${referenced.map((asset) => `- ${asset.path}`).join("\n")}`;
      await port.send(sessionId, prompt, content);
      setStagedAssets((current) => ({ ...current, [sessionId]: [] }));
    } catch {
      setNotice("Message delivery failed. Your draft is still visible above.");
    }
  }

  async function attach(files: FileList | null) {
    if (active === undefined || assetPort === undefined || files === null)
      return;
    try {
      for (const file of files) {
        const asset = await assetPort.attach(
          active.workspaceId,
          active.id,
          file,
        );
        setAssets((current) => ({
          ...current,
          [active.id]: [...(current[active.id] ?? []), asset],
        }));
        setStagedAssets((current) => ({
          ...current,
          [active.id]: [...(current[active.id] ?? []), asset.id],
        }));
      }
    } catch {
      setNotice("Attachment upload failed. Files up to 25 MB are supported.");
    } finally {
      if (attachmentInputRef.current !== null)
        attachmentInputRef.current.value = "";
    }
  }

  async function renameSession(session: RuntimeSession = active!) {
    if (session === undefined) return;
    const title = window.prompt("Conversation name", session.title)?.trim();
    if (!title || title === session.title) return;
    try {
      const updated = await port.rename(session.id, title);
      setSessions((current) =>
        current.map((session) =>
          session.id === updated.id ? updated : session,
        ),
      );
    } catch {
      setNotice("The conversation could not be renamed.");
    }
  }

  async function deleteSession(session: RuntimeSession = active!) {
    if (session === undefined) return;
    if (!window.confirm(`Delete “${session.title}”?`)) return;
    try {
      await port.remove(session.id);
      const remaining = sessions.filter((item) => item.id !== session.id);
      setSessions(remaining);
      if (session.id === activeId) setActiveId(remaining[0]?.id);
      if (remaining[0] !== undefined)
        onWorkspaceSelect?.(remaining[0].workspaceId);
    } catch {
      setNotice("The conversation could not be deleted.");
    }
  }

  async function cancelSession() {
    if (active === undefined) return;
    try {
      await port.cancel(active.id);
      setRunning((current) => current.filter((id) => id !== active.id));
    } catch {
      setNotice("The running turn could not be stopped.");
    }
  }

  function toggleAsset(assetId: string) {
    if (activeId === undefined) return;
    setStagedAssets((current) => {
      const selected = current[activeId] ?? [];
      return {
        ...current,
        [activeId]: selected.includes(assetId)
          ? selected.filter((id) => id !== assetId)
          : [...selected, assetId],
      };
    });
  }

  const sider = (
    <AionSider
      sessions={sessions}
      activeId={activeId}
      query={query}
      username={user.username}
      busy={busy || engineBlocked}
      onQuery={setQuery}
      onNew={() => {
        setAssistantsOpen(false);
        setScheduledOpen(false);
        void newSession();
      }}
      onSelect={(session) => {
        setActiveId(session.id);
        onWorkspaceSelect?.(session.workspaceId);
        setAssistantsOpen(false);
        setScheduledOpen(false);
        setSidebarOpen(false);
      }}
      onRename={renameSession}
      onDelete={deleteSession}
      onSettings={() => {
        setSidebarOpen(false);
        setSettingsOpen(true);
      }}
      onAssistants={() => {
        setSidebarOpen(false);
        setScheduledOpen(false);
        setAssistantsOpen((open) => !open);
      }}
      assistantsActive={assistantsOpen}
      onScheduled={() => {
        setSidebarOpen(false);
        setAssistantsOpen(false);
        setScheduledOpen((open) => !open);
      }}
      scheduledActive={scheduledOpen}
      onLogout={onLogout}
      onClose={() => setSidebarOpen(false)}
    />
  );

  return (
    <MemoryRouter initialEntries={["/conversation/workagent"]}>
      <Routes>
        <Route element={<RendererLayout sider={sider} />}>
          <Route
            path="*"
            element={
              <main
                className={`workagent-route-shell${!assistantsOpen && !scheduledOpen && workspacePanel ? " has-workspace" : ""}${!assistantsOpen && !scheduledOpen && workspaceOpen ? " workspace-open" : ""}`}
              >
                {scheduledOpen && automationPort ? (
                  <Suspense fallback={<div className="size-full bg-bg-0" />}>
                    <AionAutomationPage
                      port={automationPort}
                      presets={presets}
                      workspaceId={workspaceId}
                    />
                  </Suspense>
                ) : assistantsOpen && presetPort ? (
                  <Suspense fallback={<div className="size-full bg-bg-0" />}>
                    <AionPresetPage
                      engines={engineStatuses}
                      port={presetPort}
                      presets={presets}
                      skills={skills}
                      mcpServers={mcpServers}
                      onChange={setPresets}
                      onStartChat={(preset) => {
                        setPresetId(preset.id);
                        setEngine(preset.engine);
                        setActiveId(undefined);
                        setAssistantsOpen(false);
                      }}
                    />
                  </Suspense>
                ) : (
                  <section
                    className={`aion-conversation bg-1${isGuid ? " is-guid" : ""}`}
                  >
                    <div
                      className="aion-message-scroll chat-surface-container"
                      aria-live="polite"
                    >
                      {isGuid && (
                        <AionGuidEmptyState
                          engine={engine}
                          engines={engineStatuses}
                          presets={presets}
                          presetId={presetId}
                          disabled={engineBlocked}
                          onEngineChange={(next) => {
                            setEngine(next);
                            const matching = presets.find(
                              (preset) =>
                                preset.engine === next && preset.enabled,
                            );
                            if (matching !== undefined)
                              setPresetId(matching.id);
                          }}
                          onPresetChange={(next) => {
                            setPresetId(next.id);
                            setEngine(next.engine);
                          }}
                          onSend={send}
                          onAttach={() => attachmentInputRef.current?.click()}
                        />
                      )}
                      <div className="chat-surface-fluid">
                        {notice && <div className="notice">{notice}</div>}
                        {!isGuid &&
                          activeInteractions.map((interaction) => (
                            <article
                              className="approval-card message-item"
                              key={interaction.id}
                            >
                              <div>
                                <span className="approval-label">
                                  Approval required
                                </span>
                                <strong>{interaction.tool}</strong>
                                <p>{interaction.summary}</p>
                              </div>
                              <div className="approval-actions">
                                <button
                                  className="approval-reject"
                                  disabled={resolving === interaction.id}
                                  onClick={() =>
                                    resolveInteraction(interaction, "reject")
                                  }
                                >
                                  Reject
                                </button>
                                <button
                                  className="approval-allow"
                                  disabled={resolving === interaction.id}
                                  onClick={() =>
                                    resolveInteraction(interaction, "allow")
                                  }
                                >
                                  Allow once
                                </button>
                              </div>
                            </article>
                          ))}
                        {!isGuid &&
                          activeMessages.map((message) => (
                            <AionMessage
                              key={message.id}
                              conversationId={activeId!}
                              id={message.id}
                              role={message.role}
                              text={message.text}
                            />
                          ))}
                      </div>
                    </div>
                    {active && activeAssets.length > 0 && assetPort && (
                      <div
                        className="conversation-assets"
                        aria-label="Session files"
                      >
                        {activeAssets.map((asset) =>
                          asset.kind === "attachment" ? (
                            <button
                              type="button"
                              key={asset.id}
                              className={
                                activeStaged.includes(asset.id) ? "staged" : ""
                              }
                              onClick={() => toggleAsset(asset.id)}
                              title={
                                activeStaged.includes(asset.id)
                                  ? "Remove from next message"
                                  : "Attach to next message"
                              }
                            >
                              ＋ {asset.name}
                            </button>
                          ) : (
                            <a
                              key={asset.id}
                              href={assetPort.downloadUrl(
                                active.workspaceId,
                                asset.path,
                              )}
                            >
                              ↧ {asset.name}
                            </a>
                          ),
                        )}
                      </div>
                    )}
                    <div
                      className={`aion-composer chat-surface-container${isGuid ? " guid-hidden-composer" : ""}`}
                    >
                      <input
                        ref={attachmentInputRef}
                        type="file"
                        multiple
                        hidden
                        onChange={(event) => attach(event.target.files)}
                      />
                      <AionSendBox
                        disabled={!active}
                        loading={active ? running.includes(active.id) : false}
                        onSend={send}
                        onStop={cancelSession}
                        onAttach={() => attachmentInputRef.current?.click()}
                      />
                    </div>
                  </section>
                )}
                {!assistantsOpen && !scheduledOpen && workspaceOpen && (
                  <button
                    className="workspace-scrim"
                    type="button"
                    aria-label="Close workspace files"
                    onClick={() => setWorkspaceOpen(false)}
                  />
                )}
                {!assistantsOpen && !scheduledOpen && workspacePanel}
                <AionSettingsModal
                  visible={settingsOpen}
                  onClose={() => setSettingsOpen(false)}
                />
              </main>
            }
          />
        </Route>
      </Routes>
    </MemoryRouter>
  );
}
