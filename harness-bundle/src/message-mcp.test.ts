import { describe, expect, it } from "vitest";
import { handleMessageMcp, messageServer } from "./message-mcp.js";

describe("employee messaging MCP", () => {
  it("is a managed server available to every assistant projection", async () => {
    expect(messageServer().server.id).toBe("workagent-messaging");
    const listed = (await handleMessageMcp({ method: "tools/list" })) as {
      tools: { name: string }[];
    };
    expect(listed.tools.map((tool) => tool.name)).toEqual([
      "message_targets",
      "message_send",
    ]);
  });
});
