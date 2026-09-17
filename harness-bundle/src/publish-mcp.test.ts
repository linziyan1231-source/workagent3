import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

vi.mock("./butler.js", async () => {
  const actual = await vi.importActual<typeof import("./butler.js")>(
    "./butler.js",
  );
  return {
    ...actual,
    butlerRequest: vi.fn(),
  };
});

import { handlePublishMcp, publishServer } from "./publish-mcp.js";
import { allowedButlerRequest, butlerRequest } from "./butler.js";

describe("workagent-app-publish MCP", () => {
  const originalDSH_HOME = process.env.DSH_HOME;
  let dataRoot: string;
  let tempHome: string;

  beforeEach(() => {
    // Mirror the real layout: DSH_HOME is <dataRoot>/dsh-home and the
    // workspace root is the sibling <dataRoot>/workspace.
    dataRoot = join(tmpdir(), `publish-mcp-data-${Date.now()}`);
    tempHome = join(dataRoot, "dsh-home");
    mkdirSync(join(tempHome, "workagent"), { recursive: true });
    process.env.DSH_HOME = tempHome;
  });

  afterEach(() => {
    process.env.DSH_HOME = originalDSH_HOME;
    rmSync(dataRoot, { recursive: true, force: true });
  });

  it("registers a managed stdio server with the two publish tools", async () => {
    const server = publishServer();
    expect(server.server.id).toBe("workagent-app-publish");
    expect(server.server.transport.kind).toBe("stdio");
    const list = (await handlePublishMcp({ method: "tools/list" })) as {
      tools: { name: string }[];
    };
    expect(list.tools.map((tool) => tool.name).sort()).toEqual([
      "app_publish",
      "app_publish_list",
    ]);
  });
  it("routes publish calls through the butler-scoped runtime gateway", async () => {
    expect(allowedButlerRequest("GET", "/v1/app-publishing")).toBe(true);
    expect(allowedButlerRequest("POST", "/v1/app-publishing/publish")).toBe(
      true,
    );
    expect(allowedButlerRequest("DELETE", "/v1/app-publishing")).toBe(false);
    await expect(
      handlePublishMcp({ method: "tools/call", params: { name: "nope" } }),
    ).rejects.toThrow("invalid_tool_request");
  });
  it("auto-detects workspaceId when entry exists in a non-default workspace", async () => {
    const mocked = vi.mocked(butlerRequest);
    mocked.mockReset();
    const workspaceId = "workspace-test-123";
    const workspaceDir = "web-test-dir";
    mocked.mockImplementation(async (method, path) => {
      if (method === "GET" && path === "/v1/workspaces") {
        return {
          ok: true,
          status: 200,
          data: [{ id: workspaceId, directory: workspaceDir }],
        };
      }
      if (method === "POST" && path === "/v1/app-publishing/publish") {
        return { ok: true, status: 200, data: { appId: "app-123" } };
      }
      return { ok: false, status: 404, data: { error: "not found" } };
    });

    const root = join(tempHome, "..", "workspace");
    const target = join(root, workspaceDir);
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, "index.html"), "<html></html>");

    await handlePublishMcp({
      method: "tools/call",
      params: {
        name: "app_publish",
        arguments: { name: "test", access: "authenticated" },
      },
    });

    const publishCall = mocked.mock.calls.find(
      ([method, path]) =>
        method === "POST" && path === "/v1/app-publishing/publish",
    );
    expect(publishCall).toBeDefined();
    expect((publishCall![2] as Record<string, unknown>).workspaceId).toBe(
      workspaceId,
    );
  });
  it("surfaces the server error code with actionable guidance on failure", async () => {
    const mocked = vi.mocked(butlerRequest);
    mocked.mockReset();
    mocked.mockImplementation(async () => ({
      ok: false,
      status: 422,
      data: { error: "application_employee_ports_exceeded" },
    }));
    const result = (await handlePublishMcp({
      method: "tools/call",
      params: {
        name: "app_publish",
        arguments: { name: "x", access: "authenticated", workspaceId: "w" },
      },
    })) as { isError: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("application_employee_ports_exceeded");
    expect(result.content[0]!.text).toContain("上限");
  });
});
