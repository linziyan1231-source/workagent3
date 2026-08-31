import { afterEach, describe, expect, it, vi } from "vitest";
import { ipcBridge } from "./common.js";
import { FileService } from "./fileService.js";

afterEach(() => vi.unstubAllGlobals());

it("relays formal Renderer theme changes within the browser surface", async () => {
  const listener = vi.fn();
  const off = ipcBridge.theme.changed.on(listener);
  const theme = { id: "dark", appearance: "dark" } as Parameters<
    typeof listener
  >[0];

  await ipcBridge.theme.setActive.invoke(theme);
  off();
  await ipcBridge.theme.setActive.invoke(theme);

  expect(listener).toHaveBeenCalledOnce();
  expect(listener).toHaveBeenCalledWith(theme);
});

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

describe("production Renderer project adapter", () => {
  it("creates the formal guide project through the Runtime workspace port", async () => {
    const now = "2026-08-31T06:00:00.000Z";
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "workspace-1",
            name: "Browser QA",
            createdAt: now,
          }),
          {
            status: 201,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      ipcBridge.portal.createProject.invoke({ name: "Browser QA" }),
    ).resolves.toEqual({
      path: "workagent-workspace:workspace-1\\Browser QA",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/workspaces",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ name: "Browser QA" }),
        credentials: "same-origin",
      }),
    );
  });

  it("resolves the formal project path back to the Runtime workspace id", async () => {
    const now = "2026-08-31T06:00:00.000Z";
    const fetch = vi.fn(
      async (input: RequestInfo | URL) =>
        new Response(
          JSON.stringify(
            String(input) === "/api/runtime/v1/presets"
              ? []
              : {
                  id: "session-1",
                  engine: "harness",
                  title: "New conversation",
                  createdAt: now,
                  updatedAt: now,
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
                      modelId: null,
                      systemPrompt: "",
                      workspacePolicy: "default",
                      skillIds: [],
                      mcpServerIds: [],
                      toolAllowlist: [],
                      approvalPolicy: "on_risk",
                      createdAt: now,
                      updatedAt: now,
                      resolvedAt: now,
                    },
                  },
                },
          ),
          {
            status: String(input) === "/api/runtime/v1/presets" ? 200 : 201,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    await ipcBridge.conversation.create.invoke({
      name: "New conversation",
      extra: {
        workspace: "workagent-workspace:workspace-1\\Browser QA",
      },
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/sessions",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"workspace":"workspace-1"'),
      }),
    );
  });

  it("maps Runtime workspaces into the formal project picker contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: "workspace-1",
                name: "Browser QA",
                createdAt: "2026-08-31T06:00:00.000Z",
              },
            ]),
            {
              status: 200,
              headers: { "content-type": "application/json" },
            },
          ),
      ),
    );

    await expect(ipcBridge.portal.listProjects.invoke()).resolves.toEqual({
      projects: [{ project_id: "workspace-1", name: "Browser QA" }],
    });
  });
});

describe("production Renderer employee lifecycle adapter", () => {
  it("routes every extended administrator action through its explicit Portal endpoint", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        new Response(JSON.stringify({ success: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await ipcBridge.portal.setManagedUserLimits.invoke({
      username: "alice",
      limits: {
        memory_bytes: 805306368,
        cpu_percent: 35,
        active_processes: 32,
      },
    });
    await ipcBridge.portal.repairManagedUser.invoke({
      username: "alice",
      windows_password: "windows secret",
    });
    await ipcBridge.portal.renameManagedWindowsAccount.invoke({
      username: "alice",
      new_windows_username: "alice2",
      windows_password: "windows secret 2",
    });
    await ipcBridge.portal.offboardManagedUserRetainingData.invoke({
      username: "alice",
    });
    await ipcBridge.portal.deleteOffboardedManagedUser.invoke({
      username: "alice",
      confirmation: "DELETE alice",
    });

    const calls = fetch.mock.calls.map(([path, init]) => ({
      path,
      body: JSON.parse(String((init as RequestInit).body)),
    }));
    expect(calls).toEqual([
      {
        path: "/api/portal/admin/users/set-limits",
        body: {
          username: "alice",
          limits: {
            memory_bytes: 805306368,
            cpu_percent: 35,
            active_processes: 32,
          },
        },
      },
      {
        path: "/api/portal/admin/users/repair",
        body: { username: "alice", windows_password: "windows secret" },
      },
      {
        path: "/api/portal/admin/users/rename-windows",
        body: {
          username: "alice",
          new_windows_username: "alice2",
          windows_password: "windows secret 2",
        },
      },
      {
        path: "/api/portal/admin/users/offboard-retain",
        body: { username: "alice" },
      },
      {
        path: "/api/portal/admin/users/offboard-delete",
        body: { username: "alice", confirmation: "DELETE alice" },
      },
    ]);
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
    const fetch = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("/api/portal/shared-conversations")
        ? new Response(JSON.stringify({ conversations: [] }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        : new Response(
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
              {
                id: "session-codex",
                engine: "codex",
                title: "Native Codex",
                createdAt: now,
                updatedAt: now,
                workspaceId: "default",
                preset: {
                  presetId: preset.id,
                  presetVersion: 1,
                  resolvedSnapshot: {
                    ...preset,
                    engine: "codex",
                    resolvedAt: now,
                  },
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
    expect(result.items[1]).toMatchObject({
      id: "session-codex",
      type: "acp",
      extra: { backend: "codex", workspace: "default" },
    });
  });

  it("maps pending runtime approvals into formal Renderer confirmations", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify([
              {
                id: "interaction-1",
                sessionId: "session-1",
                turnId: "turn-1",
                kind: "approval",
                summary: "Run the build",
                tool: "pwsh",
                status: "pending",
                createdAt: "2026-08-31T06:00:00.000Z",
              },
            ]),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      ),
    );

    await expect(
      ipcBridge.conversation.confirmation.list.invoke({
        conversation_id: "session-1",
      }),
    ).resolves.toEqual([
      {
        id: "interaction-1",
        call_id: "interaction-1",
        title: "pwsh",
        action: "exec",
        description: "Run the build",
        command_type: "pwsh",
        options: [
          { label: "Allow once", value: "allow_once" },
          { label: "Decline", value: "decline" },
        ],
      },
    ]);
  });

  it("answers runtime approvals and emits the formal removal event", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ accepted: true, status: "rejected" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);
    const removed = vi.fn();
    const off = ipcBridge.conversation.confirmation.remove.on(removed);

    await ipcBridge.conversation.confirmation.confirm.invoke({
      conversation_id: "session-1",
      msg_id: "confirmation:interaction-1",
      call_id: "interaction-1",
      data: { value: "decline" },
    });
    off();

    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/interactions/interaction-1/respond",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ decision: "reject" }),
      }),
    );
    expect(removed).toHaveBeenCalledWith({
      conversation_id: "session-1",
      id: "interaction-1",
    });
  });

  it("creates a runtime session from the formal Renderer conversation input", async () => {
    const now = "2026-08-31T06:00:00.000Z";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify([
            {
              id: "preset-1",
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
            },
          ]),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "session-created",
            engine: "harness",
            title: "Review this document",
            workspaceId: "default",
            preset: {
              presetId: "preset-1",
              presetVersion: 1,
              resolvedSnapshot: {
                id: "preset-1",
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
                resolvedAt: now,
              },
            },
            createdAt: now,
            updatedAt: now,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetch);

    const created = await ipcBridge.conversation.create.invoke({
      name: "Review this document",
      assistant: { id: "preset-1" },
      extra: { workspace: "" },
    });

    expect(created).toMatchObject({
      id: "session-created",
      name: "Review this document",
      type: "acp",
    });
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        engine: "harness",
        title: "Review this document",
        workspace: "default",
        presetId: "preset-1",
      }),
    });
  });

  it("sends through Runtime while publishing the formal user message event", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    const streamed = vi.fn();
    const off = ipcBridge.acpConversation.responseStream.on(streamed);

    const result = await ipcBridge.acpConversation.sendMessage.invoke({
      conversation_id: "session-1",
      input: "Hello",
      files: [],
    });
    off();

    expect(result.runtime.is_processing).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/sessions/session-1/turns",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ content: "Hello" }),
      }),
    );
    expect(streamed).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "user_content",
        data: "Hello",
        conversation_id: "session-1",
      }),
    );
  });

  it("materializes pre-conversation SendBox files inside the session workspace", async () => {
    const now = "2026-08-31T06:00:00.000Z";
    const staged = await FileService.processDroppedFiles([
      new File(["private brief"], "brief.txt", { type: "text/plain" }),
    ]);
    const stagedPath = staged[0]!.path!;
    const privatePath =
      ".workagent/sessions/session-1/attachments/asset-1-brief.txt";
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "session-1",
            engine: "harness",
            title: "Review",
            workspaceId: "workspace-1",
            preset: {
              presetId: "builtin-general",
              presetVersion: 1,
              resolvedSnapshot: {
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
                resolvedAt: now,
              },
            },
            createdAt: now,
            updatedAt: now,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            id: "asset-1",
            workspaceId: "workspace-1",
            sessionId: "session-1",
            kind: "attachment",
            name: "brief.txt",
            path: privatePath,
            mediaType: "text/plain",
            size: 13,
            createdAt: now,
          }),
          { status: 201, headers: { "content-type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);

    await ipcBridge.acpConversation.sendMessage.invoke({
      conversation_id: "session-1",
      input: `Review this file\n\n${stagedPath}`,
      files: [stagedPath],
    });

    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/runtime/v1/workspaces/workspace-1/attachments?sessionId=session-1&name=brief.txt",
      expect.objectContaining({ method: "PUT", body: expect.any(File) }),
    );
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({
      method: "POST",
      body: JSON.stringify({
        content: `Review this file\n\n${privatePath}`,
        displayContent: "Review this file\n\nbrief.txt",
      }),
    });
  });
});

describe("production Renderer collaboration adapter", () => {
  it("maps Portal invite fields into the unchanged Web 78 contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
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

describe("production Renderer shared-file adapter", () => {
  it("routes the formal file tree through the shared Portal port", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: [
              { name: "docs", type: "directory" },
              { name: "notes.md", type: "file" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      ipcBridge.fs.getFilesByDir.invoke({
        root: "shared://project_1234567890",
        dir: "shared://project_1234567890",
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        name: "docs",
        fullPath: "shared://project_1234567890/docs",
        isDir: true,
      }),
      expect.objectContaining({
        name: "notes.md",
        fullPath: "shared://project_1234567890/notes.md",
        isFile: true,
      }),
    ]);
    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/shared-files",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          project_id: "project_1234567890",
          operation: "dir",
          path: "",
        }),
      }),
    );
  });

  it("keeps shared write paths stable and forwards file content", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ success: true, data: true }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      ipcBridge.fs.writeFile.invoke({
        workspace: "shared://project_1234567890",
        path: "shared://project_1234567890/notes.md",
        data: "hello",
      }),
    ).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/shared-files",
      expect.objectContaining({
        body: JSON.stringify({
          project_id: "project_1234567890",
          operation: "write",
          path: "notes.md",
          data: "hello",
        }),
      }),
    );
  });
});
