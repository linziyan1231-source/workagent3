import { describe, it, expect } from "vitest";
import { handlePublishMcp, publishServer } from "./publish-mcp.js";
import { allowedButlerRequest } from "./butler.js";

describe("workagent-app-publish MCP", () => {
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
});
