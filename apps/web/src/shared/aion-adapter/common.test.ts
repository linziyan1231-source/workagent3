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

describe("production Renderer managed Provider adapter", () => {
  it("keeps the formal Provider edit action and writes only through the SID Runtime Port", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: "provider-harness",
            kind: "provider",
            state: "ready",
            label: "Harness managed Provider",
            updatedAt: "2026-09-01T00:00:00Z",
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    await ipcBridge.mode.updateProvider.invoke({
      id: "managed-workagent-harness",
      api_key: "private-provider-key",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/provider-credentials/harness",
      expect.objectContaining({ method: "PUT", body: "private-provider-key" }),
    );
  });

  it("does not overwrite a configured Provider when the formal editor returns its mask", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await ipcBridge.mode.updateProvider.invoke({
      id: "managed-workagent-harness",
      api_key: "••••••••",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("revokes the credential without deleting the managed model catalog", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal("fetch", fetch);
    await ipcBridge.mode.deleteProvider.invoke({
      id: "managed-workagent-harness",
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/provider-credentials/harness",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("connects the formal health action to a real managed Provider probe", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            status: "healthy",
            message: "provider_request_succeeded",
            elapsed_ms: 19,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    await expect(
      ipcBridge.acpConversation.checkProviderHealth.invoke({
        provider_id: "managed-workagent-harness",
        model: "harness-default",
      }),
    ).resolves.toEqual({
      status: "healthy",
      message: "provider_request_succeeded",
      elapsed_ms: 19,
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/provider-credentials/harness/test",
      expect.objectContaining({ method: "POST" }),
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

  it("opens and mutates personal Workspace artifacts through the formal Preview bridge", async () => {
    const now = "2026-09-01T02:00:00.000Z";
    const fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const target = String(input);
        if (target.endsWith("/files?path=reports")) {
          return Response.json([
            {
              name: "final.md",
              path: "reports/final.md",
              kind: "file",
              size: 13,
              modifiedAt: now,
            },
          ]);
        }
        if (
          target.endsWith("/content?path=reports%2Ffinal.md") &&
          !init?.method
        ) {
          return new Response("artifact body", { status: 200 });
        }
        if (
          target.endsWith("/content?path=reports%2Ffinal.md") &&
          init?.method === "PUT"
        ) {
          return Response.json({
            name: "final.md",
            path: "reports/final.md",
            kind: "file",
            size: 7,
            modifiedAt: now,
          });
        }
        return new Response(null, { status: 204 });
      },
    );
    vi.stubGlobal("fetch", fetch);
    const input = {
      workspace: "workagent-workspace:workspace-1\\Browser QA",
      path: "workagent-workspace:workspace-1\\Browser QA\\reports\\final.md",
    };

    await expect(ipcBridge.fs.getFileMetadata.invoke(input)).resolves.toEqual({
      name: "final.md",
      path: input.path,
      size: 13,
      type: "text/markdown; charset=utf-8",
      lastModified: Date.parse(now),
      isDirectory: false,
    });
    await expect(ipcBridge.fs.readFile.invoke(input)).resolves.toBe(
      "artifact body",
    );
    await expect(
      ipcBridge.fs.writeFile.invoke({ ...input, data: "updated" }),
    ).resolves.toBe(true);
    await expect(
      ipcBridge.fs.removeEntry.invoke(input),
    ).resolves.toBeUndefined();
    await expect(
      ipcBridge.fs.renameEntry.invoke({ ...input, new_name: "approved.md" }),
    ).resolves.toEqual({
      new_path:
        "workagent-workspace:workspace-1\\Browser QA/reports/approved.md",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/workspaces/workspace-1/content?path=reports%2Ffinal.md",
      expect.objectContaining({ method: "PUT", body: expect.any(Blob) }),
    );
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/workspaces/workspace-1/move",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          source: "reports/final.md",
          destination: "reports/approved.md",
        }),
      }),
    );
  });

  it("projects personal Workspace images as data URLs for the formal Image preview", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(new Uint8Array([137, 80, 78, 71]), { status: 200 }),
      ),
    );
    await expect(
      ipcBridge.fs.getImageBase64.invoke({
        workspace: "workspace-1",
        path: "workspace-1/images/chart.png",
      }),
    ).resolves.toBe("data:image/png;base64,iVBORw==");
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

  it("maps SID Runtime message search into the formal Renderer search popup", async () => {
    const now = "2026-08-31T06:00:00.000Z";
    const snapshot = {
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
    };
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            items: [
              {
                session: {
                  id: "session-1",
                  engine: "harness",
                  title: "Project review",
                  createdAt: now,
                  updatedAt: now,
                  workspaceId: "workspace-1",
                  preset: {
                    presetId: "builtin-general",
                    presetVersion: 1,
                    resolvedSnapshot: snapshot,
                  },
                },
                message: {
                  id: "message-1",
                  sessionId: "session-1",
                  role: "assistant",
                  text: "Revenue increased 18 percent",
                  createdAt: now,
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
    vi.stubGlobal("fetch", fetch);

    await expect(
      ipcBridge.database.searchConversationMessages.invoke({
        keyword: "revenue",
        page: 0,
        page_size: 20,
      }),
    ).resolves.toMatchObject({
      items: [
        {
          conversation: { id: "session-1", name: "Project review" },
          message_id: "message-1",
          message_type: "text",
          preview_text: "Revenue increased 18 percent",
        },
      ],
      total: 1,
      has_more: false,
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
        body: JSON.stringify({ content: "Hello", messageId: result.msg_id }),
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

    const result = await ipcBridge.acpConversation.sendMessage.invoke({
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
        messageId: result.msg_id,
      }),
    });
  });

  it("routes the formal fork action through the native Runtime session port", async () => {
    const now = "2026-08-31T06:00:00.000Z";
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: "session-fork",
          engine: "codex",
          title: "Review (Fork)",
          workspaceId: "workspace-1",
          preset: {
            presetId: "builtin-codex",
            presetVersion: 1,
            resolvedSnapshot: {
              id: "builtin-codex",
              version: 1,
              source: "builtin",
              name: "Codex",
              description: "",
              avatar: null,
              enabled: true,
              engine: "codex",
              modelId: null,
              systemPrompt: "",
              workspacePolicy: "default",
              skillIds: [],
              mcpServerIds: [],
              toolAllowlist: [],
              approvalPolicy: "never",
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

    const result = await ipcBridge.conversation.fork.invoke({
      conversation_id: "session-1",
      message_id: "message-1",
      replacement_content: "Use the revised request",
    });

    expect(result.conversation).toMatchObject({
      id: "session-fork",
      extra: { backend: "codex" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "/api/runtime/v1/sessions/session-1/fork",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          messageId: "message-1",
          replacementContent: "Use the revised request",
        }),
      }),
    );
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

  it("preserves the formal conversation rename and pin actions for shared sessions", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ conversation: { id: "conversation-1" } }),
          {
            status: 200,
            headers: { "content-type": "application/json" },
          },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    await ipcBridge.conversation.update.invoke({
      id: "shared:conversation-1",
      updates: { name: "Renamed", extra: { pinned: true } },
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/shared-conversations",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          conversation_id: "conversation-1",
          name: "Renamed",
          pinned: true,
        }),
      }),
    );
  });

  it("routes the formal shared stop action to the shared run", async () => {
    const fetch = vi.fn(async () =>
      Response.json({ stopped: true }, { status: 200 }),
    );
    vi.stubGlobal("fetch", fetch);

    await ipcBridge.conversation.stop.invoke({
      conversation_id: "shared:conversation-1",
    });

    expect(fetch).toHaveBeenCalledWith(
      "/api/portal/shared-runs/cancel",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ conversation_id: "conversation-1" }),
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

  it("loads shared text preview metadata and content through the Portal port", async () => {
    const fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        const request = JSON.parse(String(init?.body)) as {
          operation: string;
        };
        const data =
          request.operation === "metadata"
            ? {
                name: "notes.md",
                path: "shared://project_1234567890/notes.md",
                size: 5,
                type: "text/markdown; charset=utf-8",
                lastModified: 1_788_000_000_000,
                isDirectory: false,
              }
            : "hello";
        return new Response(JSON.stringify({ success: true, data }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    );
    vi.stubGlobal("fetch", fetch);

    const input = {
      workspace: "shared://project_1234567890",
      path: "shared://project_1234567890/notes.md",
    };
    await expect(ipcBridge.fs.getFileMetadata.invoke(input)).resolves.toEqual(
      expect.objectContaining({
        name: "notes.md",
        size: 5,
        isDirectory: false,
      }),
    );
    await expect(ipcBridge.fs.readFile.invoke(input)).resolves.toBe("hello");

    expect(fetch).toHaveBeenNthCalledWith(
      1,
      "/api/portal/shared-files",
      expect.objectContaining({
        body: JSON.stringify({
          project_id: "project_1234567890",
          operation: "metadata",
          path: "notes.md",
        }),
      }),
    );
    expect(fetch).toHaveBeenNthCalledWith(
      2,
      "/api/portal/shared-files",
      expect.objectContaining({
        body: JSON.stringify({
          project_id: "project_1234567890",
          operation: "read",
          path: "notes.md",
        }),
      }),
    );
  });
});
