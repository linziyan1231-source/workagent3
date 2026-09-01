import { describe, expect, it } from "vitest";
import type { Session, SessionEvent } from "@deepseek-ai/dsh-session";
import {
  automationTargetSessionId,
  eventsAfterLastId,
  nativeCredentialError,
  normalizeEvent,
  searchRuntimeMessages,
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
});
