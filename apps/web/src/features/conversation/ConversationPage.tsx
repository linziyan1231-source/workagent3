import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type {
  EngineEvent,
  EngineId,
  EngineStatus,
  PendingInteraction,
  RuntimeSession,
  RuntimeMessage,
  WorkspaceAsset,
} from "@workagent/contracts";
import type { AuthUser } from "../../shared/types/auth.js";
import { conversationPort, type ConversationPort } from "./conversationPort.js";

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
};

export function ConversationPage({
  user,
  onLogout,
  port = conversationPort,
  workspaceId,
  workspacePanel,
  onWorkspaceSelect,
  assetPort,
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
  const inputRef = useRef<HTMLTextAreaElement>(null);
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
  }, [onWorkspaceSelect, port]);

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

  function applyEvent(sessionId: string, event: EngineEvent) {
    if (event.type === "turn.started") {
      setRunning((current) =>
        current.includes(sessionId) ? current : [...current, sessionId],
      );
    }
    if (
      event.type === "assistant.completed" ||
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
      });
      setSessions((current) => [session, ...current]);
      setActiveId(session.id);
      onWorkspaceSelect?.(session.workspaceId);
      setSidebarOpen(false);
      inputRef.current?.focus();
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

  async function send(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeId) return;
    const form = new FormData(event.currentTarget);
    const content = String(form.get("message") ?? "").trim();
    if (!content) return;
    event.currentTarget.reset();
    setMessages((current) => ({
      ...current,
      [activeId]: [
        ...(current[activeId] ?? []),
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
      await port.send(activeId, prompt, content);
      setStagedAssets((current) => ({ ...current, [activeId]: [] }));
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

  async function renameSession() {
    if (active === undefined) return;
    const title = window.prompt("Conversation name", active.title)?.trim();
    if (!title || title === active.title) return;
    try {
      const updated = await port.rename(active.id, title);
      setSessions((current) =>
        current.map((session) =>
          session.id === updated.id ? updated : session,
        ),
      );
    } catch {
      setNotice("The conversation could not be renamed.");
    }
  }

  async function deleteSession() {
    if (active === undefined) return;
    if (!window.confirm(`Delete “${active.title}”?`)) return;
    try {
      await port.remove(active.id);
      const remaining = sessions.filter((session) => session.id !== active.id);
      setSessions(remaining);
      setActiveId(remaining[0]?.id);
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

  return (
    <main
      className={`workbench${workspacePanel ? " has-workspace" : ""}${workspaceOpen ? " workspace-open" : ""}${sidebarOpen ? " sidebar-open" : ""}`}
    >
      {sidebarOpen && (
        <button
          className="sidebar-scrim"
          type="button"
          aria-label="Close conversations"
          onClick={() => setSidebarOpen(false)}
        />
      )}
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark small">WA</span>
          <div>
            <strong>WorkAgent</strong>
            <span>Personal workspace</span>
          </div>
        </div>
        <button
          className="new-button"
          onClick={newSession}
          disabled={busy || engineBlocked}
        >
          <span>＋</span> New conversation
        </button>
        <label className="session-search">
          <span aria-hidden="true">⌕</span>
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
        </label>
        <div className="session-heading">Recent</div>
        <nav className="session-list" aria-label="Conversations">
          {sessions
            .filter((session) =>
              session.title
                .toLocaleLowerCase()
                .includes(query.toLocaleLowerCase()),
            )
            .map((session) => (
              <button
                className={session.id === activeId ? "active" : ""}
                key={session.id}
                onClick={() => {
                  setActiveId(session.id);
                  onWorkspaceSelect?.(session.workspaceId);
                  setSidebarOpen(false);
                }}
              >
                <span>{session.title}</span>
                <small>{session.engine}</small>
              </button>
            ))}
          {sessions.length === 0 && (
            <p className="empty-sidebar">No conversations yet.</p>
          )}
        </nav>
        <div className="sidebar-footer">
          <span className="avatar">
            {user.username.slice(0, 1).toUpperCase()}
          </span>
          <div>
            <strong>{user.username}</strong>
            <span>Employee workspace</span>
          </div>
          <button onClick={onLogout} aria-label="Sign out" title="Sign out">
            ↗
          </button>
        </div>
      </aside>
      <section className="conversation">
        <header className="conversation-header">
          <button
            className="mobile-menu"
            type="button"
            aria-label="Open conversations"
            onClick={() => {
              setWorkspaceOpen(false);
              setSidebarOpen(true);
            }}
          >
            ☰
          </button>
          <div>
            <h1>{active?.title ?? "Start something useful"}</h1>
            <p className="conversation-subtitle">Personal workspace</p>
          </div>
          <div className="header-actions">
            <label className="engine-picker">
              <select
                value={engine}
                onChange={(event) => setEngine(event.target.value as EngineId)}
                aria-label="Engine"
              >
                {(["harness", "codex", "kimi"] as const).map((id) => {
                  const status = engineStatuses.find((item) => item.id === id);
                  return (
                    <option
                      value={id}
                      key={id}
                      disabled={
                        status?.state === "needs_auth" ||
                        status?.state === "unavailable"
                      }
                    >
                      {status?.label ??
                        (id === "harness"
                          ? "Harness"
                          : id === "codex"
                            ? "Codex"
                            : "Kimi")}
                      {status?.state === "needs_auth"
                        ? " · sign in required"
                        : status?.state === "unavailable"
                          ? " · unavailable"
                          : ""}
                    </option>
                  );
                })}
              </select>
              {selectedEngine?.detail &&
                (selectedEngine.state === "needs_auth" ||
                  selectedEngine.state === "unavailable") && (
                  <small className={`engine-state ${selectedEngine.state}`}>
                    {selectedEngine.detail}
                  </small>
                )}
            </label>
            {workspacePanel && (
              <button
                className="workspace-toggle"
                type="button"
                aria-label={
                  workspaceOpen
                    ? "Close workspace files"
                    : "Open workspace files"
                }
                aria-expanded={workspaceOpen}
                onClick={() => {
                  setSidebarOpen(false);
                  setWorkspaceOpen((open) => !open);
                }}
              >
                ▣ <span>Workspace</span>
              </button>
            )}
            {active && (
              <div className="session-actions">
                {running.includes(active.id) && (
                  <button
                    className="cancel-button"
                    type="button"
                    onClick={cancelSession}
                  >
                    Stop
                  </button>
                )}
                <button
                  type="button"
                  onClick={renameSession}
                  aria-label="Rename conversation"
                  title="Rename conversation"
                >
                  ✎
                </button>
                <button
                  type="button"
                  onClick={deleteSession}
                  aria-label="Delete conversation"
                  title="Delete conversation"
                >
                  ⋯
                </button>
              </div>
            )}
          </div>
        </header>
        <div className="message-scroll" aria-live="polite">
          {notice && <div className="notice">{notice}</div>}
          {!active && (
            <div className="empty-state">
              <span className="spark">✦</span>
              <h2>What would you like to move forward?</h2>
              <p>
                Choose an engine, open a conversation, and give WorkAgent the
                outcome you want.
              </p>
              <button
                className="primary-button compact"
                onClick={newSession}
                disabled={engineBlocked}
              >
                Start a conversation
              </button>
            </div>
          )}
          {activeInteractions.map((interaction) => (
            <article className="approval-card" key={interaction.id}>
              <div>
                <span className="approval-label">Approval required</span>
                <strong>{interaction.tool}</strong>
                <p>{interaction.summary}</p>
              </div>
              <div className="approval-actions">
                <button
                  className="approval-reject"
                  disabled={resolving === interaction.id}
                  onClick={() => resolveInteraction(interaction, "reject")}
                >
                  Reject
                </button>
                <button
                  className="approval-allow"
                  disabled={resolving === interaction.id}
                  onClick={() => resolveInteraction(interaction, "allow")}
                >
                  Allow once
                </button>
              </div>
            </article>
          ))}
          {activeMessages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <span>{message.role === "user" ? "You" : "WA"}</span>
              <p>{message.text}</p>
            </article>
          ))}
        </div>
        {active && activeAssets.length > 0 && assetPort && (
          <div className="conversation-assets" aria-label="Session files">
            {activeAssets.map((asset) =>
              asset.kind === "attachment" ? (
                <button
                  type="button"
                  key={asset.id}
                  className={activeStaged.includes(asset.id) ? "staged" : ""}
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
                  href={assetPort.downloadUrl(active.workspaceId, asset.path)}
                >
                  ↧ {asset.name}
                </a>
              ),
            )}
          </div>
        )}
        <form className="composer" onSubmit={send}>
          <textarea
            ref={inputRef}
            name="message"
            placeholder={
              active
                ? "Describe the outcome you want…"
                : "Create a conversation first"
            }
            disabled={!active}
            rows={2}
          />
          <div className="composer-footer">
            <div>
              <input
                ref={attachmentInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => attach(event.target.files)}
              />
              <button
                className="attach-button"
                type="button"
                disabled={!active || assetPort === undefined}
                aria-label="Attach files"
                onClick={() => attachmentInputRef.current?.click()}
              >
                ＋
              </button>
              <span>Workspace · Personal</span>
            </div>
            <button
              className="send-button"
              disabled={!active}
              aria-label="Send message"
            >
              ↑
            </button>
          </div>
        </form>
      </section>
      {workspaceOpen && (
        <button
          className="workspace-scrim"
          type="button"
          aria-label="Close workspace files"
          onClick={() => setWorkspaceOpen(false)}
        />
      )}
      {workspacePanel}
    </main>
  );
}
