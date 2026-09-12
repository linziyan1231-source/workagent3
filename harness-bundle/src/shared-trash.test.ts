import { afterEach, describe, expect, it, vi } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { WorkspaceStore } from "./workspace-store.js";
import { WorkspaceController } from "./workspace-api.js";
import {
  PlatformSharedTrashClient,
  SHARED_TRASH_REQUEST_TIMEOUT_MS,
  SHARED_TRASH_TOOL_TIMEOUT_MS,
  SharedTrashError,
} from "./shared-trash-client.js";
import { handleSharedTrashMcp, sharedTrashServer } from "./shared-trash-mcp.js";
import { projectHarnessMcpServers } from "./engines/harness-mcp.js";
import { projectCodexMcpServers } from "./engines/codex.js";
import { projectMcpServers } from "./engines/kimi.js";

const projectId = "project-trash-123456";
const roots: string[] = [];
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "workagent-shared-trash-"));
  roots.push(root);
  const files = join(root, "shared");
  const home = join(root, "home");
  mkdirSync(join(files, projectId), { recursive: true });
  writeFileSync(join(files, projectId, "notes.txt"), "keep me");
  return { root, files, home };
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

describe("shared recycle routing", () => {
  it.each([
    { directory: false, disconnect: false },
    { directory: true, disconnect: false },
    { directory: false, disconnect: true },
  ])(
    "finishes admitted recycling and invalidates identity %j",
    async ({ directory, disconnect }) => {
      const { root, files, home } = fixture();
      if (directory) {
        rmSync(join(files, projectId, "notes.txt"));
        mkdirSync(join(files, projectId, "notes.txt"));
        writeFileSync(
          join(files, projectId, "notes.txt", "child.txt"),
          "child",
        );
      }
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      let finish!: () => void;
      const gate = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const recycle = vi.fn(async (id: string, path: string) => {
        enter();
        await gate;
        renameSync(join(files, id, path), join(root, "recycled"));
      });
      const store = new WorkspaceStore(files, home, true, recycle);
      const identity = store.moves.identify(projectId, "notes.txt");
      const childIdentity = directory
        ? store.moves.identify(projectId, "notes.txt/child.txt")
        : undefined;
      store.move(projectId, "notes.txt", "current.txt");
      writeFileSync(join(files, projectId, "notes.txt"), "replacement");
      let handler!: (
        request: IncomingMessage,
        response: ServerResponse,
      ) => unknown;
      const disposers: (() => void)[] = [];
      const context = {
        effect(callback: () => unknown) {
          const dispose = callback();
          if (typeof dispose === "function")
            disposers.push(dispose as () => void);
        },
        webServer: {
          register(input: { handler: typeof handler }) {
            handler = input.handler;
          },
        },
      } as unknown as Context;
      new WorkspaceController(
        context,
        "runtime-token",
        store,
        () => undefined,
        "/v1/shared-workspaces",
      );
      const server = createServer((request, response) => {
        void handler(request, response);
      });
      await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
      );
      const address = server.address() as { port: number };
      try {
        const controller = new AbortController();
        const pending = fetch(
          `http://127.0.0.1:${address.port}/v1/shared-workspaces/${projectId}/content?path=notes.txt&fileId=${identity}`,
          {
            method: "DELETE",
            headers: { authorization: "Bearer runtime-token" },
            signal: controller.signal,
          },
        );
        await entered;
        expect(existsSync(join(files, projectId, "notes.txt"))).toBe(true);
        expect(store.moves.reference(projectId, "notes.txt", identity)).toBe(
          "current.txt",
        );
        const move = store.moves.request(projectId, [
          { source: "notes.txt", destination: "replacement.txt" },
        ]);
        expect(move.state).toBe("queued");
        if (disconnect) {
          controller.abort();
          await expect(pending).rejects.toMatchObject({ name: "AbortError" });
        }
        finish();
        if (disconnect)
          await vi.waitFor(() =>
            expect(store.moves.writes.get(projectId)).toBe(0),
          );
        else expect((await pending).status).toBe(204);
        expect(recycle).toHaveBeenCalledWith(projectId, "current.txt");
        expect(existsSync(join(root, "recycled"))).toBe(true);
        expect(() =>
          store.moves.reference(projectId, "notes.txt", identity),
        ).toThrow("file_not_found");
        if (childIdentity)
          expect(() =>
            store.moves.reference(
              projectId,
              "notes.txt/child.txt",
              childIdentity,
            ),
          ).toThrow("file_not_found");
        store.moves.drain(projectId);
        expect(move.state).toBe("completed");
        expect(store.read(projectId, "replacement.txt").toString()).toBe(
          "replacement",
        );
      } finally {
        finish();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        for (const dispose of disposers) dispose();
      }
    },
  );

  it("holds deletion admission until the independent central HTTP request settles", async () => {
    const { root, files, home } = fixture();
    let received!: () => void;
    const entered = new Promise<void>((resolve) => {
      received = resolve;
    });
    let finish!: () => void;
    const release = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let requestBody: unknown;
    const central = createServer((request, response) => {
      void (async () => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        requestBody = JSON.parse(Buffer.concat(chunks).toString());
        received();
        await release;
        renameSync(join(files, projectId, "notes.txt"), join(root, "recycled"));
        response.writeHead(200, { "content-type": "application/json" });
        response.end("{}");
      })();
    });
    await new Promise<void>((resolve) =>
      central.listen(0, "127.0.0.1", resolve),
    );
    const address = central.address() as { port: number };
    const client = PlatformSharedTrashClient.fromEnvironment({
      WORKAGENT_PLATFORM_URL: `http://127.0.0.1:${address.port}`,
      WORKAGENT_EMPLOYEE_SID: "S-1-5-21-test",
      WORKAGENT_PLATFORM_TOKEN: "runtime-registration-token",
    })!;
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const store = new WorkspaceStore(files, home, true, (projectId, path) =>
      client.operate(
        { projectId, operation: "recycle", path },
        "workspace-store",
      ),
    );
    const identity = store.moves.identify(projectId, "notes.txt");
    const deletion = store.delete(projectId, "notes.txt");
    try {
      await entered;
      expect(timeout).not.toHaveBeenCalled();
      expect(requestBody).toMatchObject({
        source: "workspace-store",
        projectId,
        path: "notes.txt",
      });
      expect(store.moves.writes.get(projectId)).toBe(1);
      expect(store.moves.reference(projectId, "notes.txt", identity)).toBe(
        "notes.txt",
      );
      finish();
      await deletion;
      expect(store.moves.writes.get(projectId)).toBe(0);
      expect(() =>
        store.moves.reference(projectId, "notes.txt", identity),
      ).toThrow("file_not_found");
      expect(existsSync(join(root, "recycled"))).toBe(true);
    } finally {
      finish();
      await deletion;
      timeout.mockRestore();
      central.closeAllConnections();
      await new Promise<void>((resolve) => central.close(() => resolve()));
    }
  });

  it("preserves files and identities if the central service rejects deletion", async () => {
    const { files, home } = fixture();
    const store = new WorkspaceStore(files, home, true, async () => {
      throw new SharedTrashError(403, "forbidden");
    });
    const identity = store.moves.identify(projectId, "notes.txt");
    await expect(store.delete(projectId, "notes.txt")).rejects.toThrow(
      "forbidden",
    );
    expect(store.read(projectId, "notes.txt").toString()).toBe("keep me");
    expect(store.moves.writes.get(projectId)).toBe(0);
    expect(store.moves.reference(projectId, "notes.txt", identity)).toBe(
      "notes.txt",
    );
    expect(() =>
      new WorkspaceStore(files, home, true).delete(projectId, "notes.txt"),
    ).toThrow("shared_trash_unavailable");
  });

  it("keeps private workspace soft-delete behavior synchronous", () => {
    const { root } = fixture();
    const recycle = vi.fn();
    const store = new WorkspaceStore(
      join(root, "private"),
      join(root, "private-home"),
      false,
      recycle,
    );
    const workspace = store.create("Personal");
    store.write(workspace.id, "draft.txt", Buffer.from("private"));
    expect(store.delete(workspace.id, "draft.txt")).toBeUndefined();
    expect(recycle).not.toHaveBeenCalled();
    expect(
      readdirSync(join(store.engineRoot(workspace.id), ".workagent-trash")),
    ).toHaveLength(1);
  });
});

describe("project-bound recycle MCP", () => {
  it("projects a fixed project and tools without permanent deletion", async () => {
    const server = sharedTrashServer(projectId);
    expect(server.server.transport).toMatchObject({
      kind: "stdio",
      args: [expect.stringContaining("shared-trash-mcp.js"), projectId],
    });
    expect(projectHarnessMcpServers([server], "C:/shared")[0]).toMatchObject({
      serverName: "workagent-shared-trash",
      args: [expect.any(String), projectId],
      toolCallTimeoutMs: SHARED_TRASH_TOOL_TIMEOUT_MS,
    });
    expect(
      projectCodexMcpServers([server])["workagent-shared-trash"],
    ).toMatchObject({
      args: [expect.any(String), projectId],
      tool_timeout_sec: SHARED_TRASH_TOOL_TIMEOUT_MS / 1000,
    });
    expect(projectMcpServers([server])[0]).toMatchObject({
      args: [expect.any(String), projectId],
    });
    const result = await handleSharedTrashMcp(projectId, {
      method: "tools/list",
    });
    expect("tools" in result && result.tools.map((tool) => tool.name)).toEqual([
      "shared_file_recycle",
      "shared_trash_list",
      "shared_trash_restore",
    ]);
    const operate = vi.fn().mockResolvedValue({ id: "trash-entry" });
    await handleSharedTrashMcp(
      projectId,
      {
        method: "tools/call",
        params: {
          name: "shared_file_recycle",
          arguments: { path: "docs\\notes.txt" },
        },
      },
      operate,
    );
    await handleSharedTrashMcp(
      projectId,
      {
        method: "tools/call",
        params: {
          name: "shared_trash_restore",
          arguments: { entryId: "trash-entry" },
        },
      },
      operate,
    );
    expect(operate.mock.calls.map(([input]) => input)).toEqual([
      { projectId, operation: "recycle", path: "docs/notes.txt" },
      { projectId, operation: "restore", entryId: "trash-entry" },
    ]);
  });

  it.each([
    { path: "../other/secret.txt" },
    { path: "C:\\other\\secret.txt" },
    { path: "shared://another-project/secret.txt" },
    { path: "notes.txt", projectId: "another-project-1234" },
  ])("rejects cross-project and escaping arguments %j", async (args) => {
    const operate = vi.fn();
    await expect(
      handleSharedTrashMcp(
        projectId,
        {
          method: "tools/call",
          params: { name: "shared_file_recycle", arguments: args },
        },
        operate,
      ),
    ).rejects.toThrow();
    expect(operate).not.toHaveBeenCalled();
  });

  it("uses the scoped platform identity and preserves restore conflicts", async () => {
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const fetch = vi
      .fn()
      .mockResolvedValue(
        new Response(JSON.stringify({ error: "file_exists" }), { status: 409 }),
      );
    vi.stubGlobal("fetch", fetch);
    const client = PlatformSharedTrashClient.fromEnvironment({
      WORKAGENT_PLATFORM_URL: "http://127.0.0.1:8088",
      WORKAGENT_EMPLOYEE_SID: "S-1-5-21-test",
      WORKAGENT_PLATFORM_TOKEN: "runtime-registration-token",
    })!;
    await expect(
      client.operate({ projectId, operation: "restore", entryId: "entry-1" }),
    ).rejects.toMatchObject({ status: 409, message: "file_exists" });
    const [url, init] = fetch.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe(
      "http://127.0.0.1:8088/internal/runtime/shared-trash",
    );
    expect(init.headers).toMatchObject({
      authorization: "Bearer runtime-registration-token",
    });
    expect(JSON.parse(String(init.body))).toEqual({
      sid: "S-1-5-21-test",
      projectId,
      operation: "restore",
      entryId: "entry-1",
    });
    expect(timeout).toHaveBeenCalledWith(SHARED_TRASH_REQUEST_TIMEOUT_MS);
    timeout.mockRestore();
  });
});
