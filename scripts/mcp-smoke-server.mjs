import { appendFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const marker = process.argv[2];
if (!marker) throw new Error("MCP smoke marker path is required");

const reply = (id, result) => {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
};

createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  appendFileSync(`${marker}.methods`, `${request.method}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  if (request.method === "initialize") {
    writeFileSync(marker, "initialized", { encoding: "utf8", mode: 0o600 });
    reply(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {}, resources: {} },
      serverInfo: { name: "workagent-mcp-smoke", version: "1" },
    });
    return;
  }
  if (request.method === "tools/list") {
    reply(request.id, {
      tools: [
        {
          name: "ping",
          description: "Deterministic WorkAgent MCP smoke tool",
          inputSchema: { type: "object", additionalProperties: false },
        },
      ],
    });
    return;
  }
  if (request.method === "tools/call") {
    reply(request.id, {
      content: [{ type: "text", text: "pong" }],
      isError: false,
    });
    return;
  }
  if (request.method === "resources/list") {
    reply(request.id, {
      resources: [
        {
          uri: "fixture://resource",
          name: "Fixture resource",
          mimeType: "text/plain",
        },
      ],
    });
    return;
  }
  if (request.method === "resources/templates/list") {
    reply(request.id, { resourceTemplates: [] });
    return;
  }
  if (request.method === "resources/read") {
    reply(request.id, {
      contents: [
        {
          uri: "fixture://resource",
          mimeType: "text/plain",
          text: "shared resource",
        },
      ],
    });
    return;
  }
});
