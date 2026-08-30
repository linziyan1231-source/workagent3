import { afterEach, describe, expect, it, vi } from "vitest";
import { conversationPort } from "./conversationPort.js";

afterEach(() => vi.unstubAllGlobals());

describe("ConversationPort", () => {
  it("creates sessions only through the same-origin runtime proxy", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "session-1",
          engine: "harness",
          title: "Quarterly plan",
          workspaceId: "workspace-1",
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

  it("routes rename, cancel, and delete through the session resource", async () => {
    const session = {
      id: "session-1",
      engine: "harness",
      title: "Renamed",
      workspaceId: "workspace-1",
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
