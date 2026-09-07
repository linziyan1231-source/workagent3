import { describe, expect, it } from "vitest";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import {
  automationTargetSessionId,
  eventsAfterLastId,
  nativeCredentialError,
  normalizeEvent,
  planMessageFork,
  searchRuntimeMessages,
  sessionActivity,
} from "./runtime.js";
import type {
  AutomationDefinition,
  RuntimeSession,
} from "@workagent/contracts";

const events = [
  { eventId: "session-with-hyphens-9" },
  { eventId: "session-with-hyphens-10" },
  { eventId: "session-with-hyphens-11" },
];

describe("authoritative conversation activity", () => {
  const event = (type: string, message?: string) => ({
    type,
    eventId: type,
    sessionId: "session",
    occurredAt: "2026-09-06T00:00:00Z",
    ...(message ? { message } : {}),
  });
  it("reports retries and does not treat a completed assistant item as a completed turn", () => {
    const history = [event("turn.started"), event("turn.retrying", "busy")];
    expect(sessionActivity(history)).toEqual({
      state: "retrying",
      message: "busy",
    });
    expect(
      sessionActivity([...history, event("assistant.completed")]).state,
    ).toBe("retrying");
    expect(sessionActivity([...history, event("turn.completed")])).toEqual({
      state: "idle",
    });
  });
  it("returns idle after a runtime restart or a failed turn", () => {
    expect(sessionActivity([])).toEqual({ state: "idle" });
    expect(
      sessionActivity([
        event("turn.started"),
        event("turn.failed", "service unavailable"),
      ]),
    ).toEqual({ state: "idle", message: "service unavailable" });
  });
});

describe("SSE event replay", () => {
  it("resumes after the exact event ID without lexical sequence ordering", () => {
    expect(eventsAfterLastId(events, "session-with-hyphens-9")).toEqual(
      events.slice(1),
    );
  });

  it("replays retained events when the client cursor is unknown", () => {
    expect(eventsAfterLastId(events, "expired-event-id")).toEqual(events);
  });
});

describe("native conversation branching", () => {
  const messages = [
    {
      id: "message-1",
      sessionId: "session-1",
      role: "user" as const,
      text: "first",
      createdAt: "2026-08-30T10:00:00.000Z",
      nativeTurnId: "turn-1",
    },
    {
      id: "turn-1",
      sessionId: "session-1",
      role: "assistant" as const,
      text: "first answer",
      createdAt: "2026-08-30T10:01:00.000Z",
      nativeTurnId: "turn-1",
    },
    {
      id: "message-2",
      sessionId: "session-1",
      role: "user" as const,
      text: "second",
      createdAt: "2026-08-30T10:02:00.000Z",
      nativeTurnId: "turn-2",
    },
  ];

  it("copies through the selected turn for a fork", () => {
    expect(planMessageFork(messages, "message-1", false)).toMatchObject({
      selectedTurnId: "turn-1",
      previousTurnId: undefined,
      hasLaterUser: true,
      copiedMessages: messages.slice(0, 2),
    });
  });

  it("copies only prior turns when replacing a user message", () => {
    expect(planMessageFork(messages, "message-2", true)).toMatchObject({
      selectedTurnId: "turn-2",
      previousTurnId: "turn-1",
      hasLaterUser: false,
      copiedMessages: messages.slice(0, 2),
    });
  });

  it("rejects legacy messages without a persisted native turn", () => {
    expect(() =>
      planMessageFork(
        [
          {
            id: "message-1",
            sessionId: "session-1",
            role: "user",
            text: "legacy",
            createdAt: "2026-08-30T10:00:00.000Z",
          },
        ],
        "message-1",
        false,
      ),
    ).toThrow("message_turn_unavailable");
  });

  it("allows Harness branches without native turn identifiers", () => {
    const legacy = messages.map(
      ({ nativeTurnId: _nativeTurnId, ...message }) => message,
    );
    expect(planMessageFork(legacy, "message-2", true, false)).toMatchObject({
      hasLaterUser: false,
      copiedMessages: legacy.slice(0, 2),
    });
  });
});

describe("terminal turn normalization", () => {
  const session = { id: "session-1" } as Session;
  const turnEnd = (reason: unknown) =>
    normalizeEvent(session, {
      type: "turn/end",
      seq: 4,
      time: Date.parse("2026-08-31T00:00:00.000Z"),
      data: { turn: 2, reason },
    } as SessionEvent);

  it("publishes an explicit success only for a completed turn", () => {
    expect(turnEnd({ kind: "completed" })).toMatchObject({
      type: "turn.completed",
      turnId: "turn-2",
    });
  });

  it("does not mistake blocked or interrupted turns for success", () => {
    expect(turnEnd({ kind: "blocked" })).toMatchObject({
      type: "turn.failed",
      code: "turn_blocked",
    });
    expect(turnEnd({ kind: "interrupted" })).toMatchObject({
      type: "turn.failed",
      code: "turn_interrupted",
    });
  });
});

describe("automation conversation targeting", () => {
  const definition = {
    executionMode: "new_conversation",
    conversationId: null,
  } as AutomationDefinition;

  it("uses a stable run-owned session for new-conversation jobs", () => {
    expect(automationTargetSessionId("run-1", definition)).toBe(
      "session-run-1",
    );
  });

  it("targets the configured conversation and rejects missing ownership", () => {
    expect(
      automationTargetSessionId("run-1", {
        ...definition,
        executionMode: "existing",
        conversationId: "conversation-1",
      }),
    ).toBe("conversation-1");
    expect(() =>
      automationTargetSessionId("run-1", {
        ...definition,
        executionMode: "existing",
      }),
    ).toThrow("automation_conversation_required");
  });
});

describe("native engine credential gate", () => {
  it("requires SID-private credentials before native session startup", () => {
    expect(nativeCredentialError("kimi", undefined)).toBe(
      "credential_needs_auth:kimi",
    );
    expect(
      nativeCredentialError("codex", {
        id: "codex-native",
        kind: "codex_native",
        label: "Codex",
        state: "needs_auth",
        updatedAt: null,
      }),
    ).toBe("credential_needs_auth:codex");
  });

  it("does not couple Harness or ready native engines to the gate", () => {
    expect(nativeCredentialError("harness", undefined)).toBeUndefined();
    expect(
      nativeCredentialError("kimi", {
        id: "kimi-native",
        kind: "kimi_native",
        label: "Kimi",
        state: "ready",
        updatedAt: null,
      }),
    ).toBeUndefined();
  });
});

describe("persisted message search", () => {
  const session: RuntimeSession = {
    id: "session-1",
    engine: "harness",
    title: "Quarterly plan",
    createdAt: "2026-08-30T10:00:00.000Z",
    updatedAt: "2026-08-30T10:02:00.000Z",
    workspaceId: "workspace-1",
    preset: {
      presetId: "builtin-general",
      presetVersion: 1,
      resolvedSnapshot: {
        id: "builtin-general",
        version: 1,
        source: "builtin",
        name: "General",
        description: "",
        avatar: null,
        enabled: true,
        engine: "harness",
        modelId: "harness-default",
        systemPrompt: "",
        workspacePolicy: "default",
        skillIds: [],
        mcpServerIds: [],
        toolAllowlist: [],
        approvalPolicy: "on_risk",
        createdAt: "2026-08-30T10:00:00.000Z",
        updatedAt: "2026-08-30T10:00:00.000Z",
        resolvedAt: "2026-08-30T10:00:00.000Z",
      },
    },
  };

  it("filters case-insensitively, orders newest first, and paginates", () => {
    const items = [
      {
        session,
        message: {
          id: "message-1",
          sessionId: session.id,
          role: "user" as const,
          text: "Quarterly revenue",
          createdAt: "2026-08-30T10:01:00.000Z",
        },
      },
      {
        session,
        message: {
          id: "message-2",
          sessionId: session.id,
          role: "assistant" as const,
          text: "REVENUE increased",
          createdAt: "2026-08-30T10:02:00.000Z",
        },
      },
      {
        session,
        message: {
          id: "message-3",
          sessionId: session.id,
          role: "assistant" as const,
          text: "No match",
          createdAt: "2026-08-30T10:03:00.000Z",
        },
      },
    ];
    const first = searchRuntimeMessages(items, "revenue", 0, 1);
    expect(first).toMatchObject({ total: 2, hasMore: true });
    expect(first.items[0]!.message.id).toBe("message-2");
    expect(
      searchRuntimeMessages(items, "revenue", 1, 1).items[0]!.message.id,
    ).toBe("message-1");
  });

  it("filters by session before pagination", () => {
    const other = { ...session, id: "session-2", title: "Other" };
    const items = [
      {
        session,
        message: {
          id: "wanted",
          sessionId: session.id,
          role: "user" as const,
          text: "needle",
          createdAt: "2026-08-30T10:00:00.000Z",
        },
      },
      ...Array.from({ length: 20 }, (_, index) => ({
        session: other,
        message: {
          id: `newer-${index}`,
          sessionId: other.id,
          role: "user" as const,
          text: "needle",
          createdAt: `2026-08-31T10:${String(index).padStart(2, "0")}:00.000Z`,
        },
      })),
    ];

    const result = searchRuntimeMessages(items, "needle", 0, 20, session.id);
    expect(result).toMatchObject({ total: 1, hasMore: false });
    expect(result.items[0]!.message.id).toBe("wanted");
  });
});
