import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcBridge } from "./common.js";

afterEach(() => vi.unstubAllGlobals());

describe("production Renderer Skill Market adapter", () => {
  it("routes the original publish action through Portal", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await ipcBridge.portal.publishSkill.invoke({ skill_name: "My Skill" });

    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/skill-market",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ skill_name: "My Skill" }),
        credentials: "same-origin",
      }),
    );
  });

  it("routes the original install action through Portal", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: "market-wiki" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await ipcBridge.portal.installMarketSkill.invoke({ id: "market-wiki" });

    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/skill-market/install",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ id: "market-wiki" }),
        credentials: "same-origin",
      }),
    );
  });

  it("routes market deletion without changing the old Skills Hub action", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await ipcBridge.portal.deleteMarketSkill.invoke({ id: "market/unsafe" });

    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/skill-market?id=market%2Funsafe",
      expect.objectContaining({ method: "DELETE", credentials: "same-origin" }),
    );
  });
});

describe("production Renderer conversation adapter", () => {
  it("maps WorkAgent3 sessions into the original Renderer list contract", async () => {
    const now = "2026-08-31T06:00:00.000Z";
    const preset = {
      id: "builtin-general",
      version: 1,
      source: "builtin",
      name: "Puxin AI",
      description: "",
      avatar: null,
      enabled: true,
      engine: "harness",
      modelId: null,
      systemPrompt: "",
      workspacePolicy: "default",
      skillIds: [],
      mcpServerIds: [],
      toolAllowlist: [],
      approvalPolicy: "on_risk",
      createdAt: now,
      updatedAt: now,
    };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify([
            {
              id: "session-1",
              engine: "harness",
              title: "Project review",
              createdAt: now,
              updatedAt: now,
              workspaceId: "default",
              preset: {
                presetId: preset.id,
                presetVersion: 1,
                resolvedSnapshot: { ...preset, resolvedAt: now },
              },
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await ipcBridge.database.getUserConversations.invoke({
      limit: 10000,
    });

    expect(result.items[0]).toMatchObject({
      id: "session-1",
      name: "Project review",
      type: "acp",
      extra: { backend: "harness", workspace: "default" },
    });
  });
});

describe("production Renderer collaboration adapter", () => {
  it("maps Portal invite fields into the unchanged Web 78 contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            invites: [
              {
                id: "invite-1",
                projectId: "project-1",
                projectName: "Design",
                inviterName: "Alice",
                status: "pending",
                createdAt: "2026-08-31T00:00:00Z",
                expiresAt: "2026-09-01T00:00:00Z",
              },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      ),
    );

    await expect(ipcBridge.portal.listSharedInvites.invoke()).resolves.toEqual({
      invites: [
        expect.objectContaining({
          id: "invite-1",
          project_id: "project-1",
          project_name: "Design",
          inviter_name: "Alice",
        }),
      ],
    });
  });

  it("routes hidden-project changes through the project resource", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await ipcBridge.portal.setSharedProjectHidden.invoke({
      project_id: "project/1",
      hidden: true,
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/shared-projects/project%2F1",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({ hidden: true }),
      }),
    );
  });
});
