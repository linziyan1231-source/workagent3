import { type FormEvent, useEffect, useMemo, useRef, useState } from "react";
import type {
  EngineEvent,
  EngineId,
  RuntimeSession,
} from "@workagent/contracts";
import type { AuthUser } from "../auth/authPort.js";
import { conversationPort, type ConversationPort } from "./conversationPort.js";

export type Message = {
  id: string;
  role: "assistant" | "user";
  text: string;
};

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
};

export function ConversationPage({
  user,
  onLogout,
  port = conversationPort,
}: Props) {
  const [sessions, setSessions] = useState<RuntimeSession[]>([]);
  const [activeId, setActiveId] = useState<string>();
  const [messages, setMessages] = useState<Record<string, Message[]>>({});
  const [engine, setEngine] = useState<EngineId>("harness");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const active = sessions.find((session) => session.id === activeId);
  const activeMessages = useMemo(
    () => (activeId ? (messages[activeId] ?? []) : []),
    [activeId, messages],
  );

  useEffect(() => {
    void port
      .list()
      .then((items) => {
        setSessions(items);
        setActiveId(items[0]?.id);
      })
      .catch(() => setNotice("Your runtime is starting. Try again shortly."));
  }, [port]);

  useEffect(() => {
    if (!activeId) return;
    return port.subscribe(activeId, (event) => applyEvent(activeId, event));
  }, [activeId, port]);

  function applyEvent(sessionId: string, event: EngineEvent) {
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

  async function newSession() {
    setBusy(true);
    setNotice("");
    try {
      const session = await port.create({
        engine,
        title: "New conversation",
        workspace: ".",
      });
      setSessions((current) => [session, ...current]);
      setActiveId(session.id);
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
      await port.send(activeId, content);
    } catch {
      setNotice("Message delivery failed. Your draft is still visible above.");
    }
  }

  return (
    <main className="workbench">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark small">WA</span>
          <div>
            <strong>WorkAgent</strong>
            <span>Personal workspace</span>
          </div>
        </div>
        <button className="new-button" onClick={newSession} disabled={busy}>
          <span>＋</span> New conversation
        </button>
        <div className="session-heading">Recent</div>
        <nav className="session-list" aria-label="Conversations">
          {sessions.map((session) => (
            <button
              className={session.id === activeId ? "active" : ""}
              key={session.id}
              onClick={() => setActiveId(session.id)}
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
          <div>
            <p className="eyebrow">Personal work</p>
            <h1>{active?.title ?? "Start something useful"}</h1>
          </div>
          <label className="engine-picker">
            <span>Engine</span>
            <select
              value={engine}
              onChange={(event) => setEngine(event.target.value as EngineId)}
            >
              <option value="harness">Harness</option>
              <option value="codex">Codex</option>
              <option value="kimi">Kimi</option>
            </select>
          </label>
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
              <button className="primary-button compact" onClick={newSession}>
                Start a conversation
              </button>
            </div>
          )}
          {activeMessages.map((message) => (
            <article className={`message ${message.role}`} key={message.id}>
              <span>{message.role === "user" ? "You" : "WA"}</span>
              <p>{message.text}</p>
            </article>
          ))}
        </div>
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
            <span>Workspace · Personal</span>
            <button disabled={!active} aria-label="Send message">
              ↑
            </button>
          </div>
        </form>
      </section>
    </main>
  );
}
