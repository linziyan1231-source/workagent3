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
});
