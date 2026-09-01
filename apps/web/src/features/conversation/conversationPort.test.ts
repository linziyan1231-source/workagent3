import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationPort } from "./conversationPort.js";

afterEach(() => vi.unstubAllGlobals());

const preset = {
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
};

describe("ConversationPort", () => {
  it("creates sessions only through the same-origin runtime proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "session-1",
          engine: "harness",
          title: "Quarterly plan",
          workspaceId: "workspace-1",
          preset,
          createdAt: "2026-08-30T10:00:00.000Z",
          updatedAt: "2026-08-30T10:00:00.000Z",
        }),
        { status: 201, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await conversationPort.create({
      engine: "harness",
      title: "Quarterly plan",
      workspace: "default",
    });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/sessions",
      expect.objectContaining({ method: "POST" }),
    );
    expect(JSON.stringify(fetchMock.mock.calls)).not.toContain("S-1-");
  });

  it("rejects runtime responses that violate the shared contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: "missing-fields" }), {
          status: 201,
        }),
      ),
    );

    await expect(
      conversationPort.create({
        engine: "harness",
        title: "Invalid response",
        workspace: "default",
      }),
    ).rejects.toThrow();
  });

  it("answers approvals through the same-origin interaction endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ accepted: true, status: "allowed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await conversationPort.respond("interaction-1", "allow");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/interactions/interaction-1/respond",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "allow" }),
      }),
    );
  });

  it("validates capability-driven engine status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify([
            {
              id: "codex",
              label: "Codex",
              available: true,
              authenticated: false,
              state: "needs_auth",
              capabilities: {
                approval: false,
                resume: true,
                steer: false,
                toolEvents: true,
                usage: false,
              },
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(conversationPort.engines()).resolves.toMatchObject([
      { id: "codex", state: "needs_auth" },
    ]);
  });

  it("restores messages and separates the displayed text from engine context", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "message-1",
              sessionId: "session-1",
              role: "user",
              text: "Review this",
              createdAt: "2026-08-30T10:00:00.000Z",
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ accepted: true }), {
          status: 202,
          headers: { "content-type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await conversationPort.messages("session-1");
    await conversationPort.send(
      "session-1",
      "Review this\n\nAttached workspace files:\n- .workagent/file.txt",
      "Review this",
    );

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/runtime/v1/sessions/session-1/messages",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/runtime/v1/sessions/session-1/turns",
      expect.objectContaining({
        body: JSON.stringify({
          content:
            "Review this\n\nAttached workspace files:\n- .workagent/file.txt",
          displayContent: "Review this",
        }),
      }),
    );
  });

  it("searches persisted messages through the SID Runtime", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          items: [
            {
              session: {
                id: "session-1",
                engine: "harness",
                title: "Quarterly plan",
                workspaceId: "workspace-1",
                preset,
                createdAt: "2026-08-30T10:00:00.000Z",
                updatedAt: "2026-08-30T10:01:00.000Z",
              },
              message: {
                id: "message-1",
                sessionId: "session-1",
                role: "assistant",
                text: "Revenue increased",
                createdAt: "2026-08-30T10:01:00.000Z",
              },
            },
          ],
          total: 1,
          page: 0,
          pageSize: 20,
          hasMore: false,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      conversationPort.searchMessages("revenue growth", 0, 20),
    ).resolves.toMatchObject({ total: 1, hasMore: false });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/messages/search?keyword=revenue+growth&page=0&page_size=20",
      expect.objectContaining({ credentials: "same-origin" }),
    );
  });

  it("forks a conversation from the selected persisted message", async () => {
    const session = {
      id: "session-fork",
      engine: "codex",
      title: "Quarterly plan (Fork)",
      workspaceId: "workspace-1",
      preset,
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:01:00.000Z",
    };
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(session), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      conversationPort.fork("session-1", "message-1", "revised prompt"),
    ).resolves.toMatchObject({ id: "session-fork", engine: "codex" });
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/runtime/v1/sessions/session-1/fork",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          messageId: "message-1",
          replacementContent: "revised prompt",
        }),
      }),
    );
  });

  it("routes rename, cancel, and delete through the session resource", async () => {
    const session = {
      id: "session-1",
      engine: "harness",
      title: "Renamed",
      workspaceId: "workspace-1",
      preset,
      createdAt: "2026-08-30T10:00:00.000Z",
      updatedAt: "2026-08-30T10:01:00.000Z",
    };
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(session), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetchMock);

    await conversationPort.rename("session-1", "Renamed");
    await conversationPort.cancel("session-1");
    await conversationPort.remove("session-1");

    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      "/api/runtime/v1/sessions/session-1",
      expect.objectContaining({ method: "PATCH" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "/api/runtime/v1/sessions/session-1/cancel",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      3,
      "/api/runtime/v1/sessions/session-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });
});
