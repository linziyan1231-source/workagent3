import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { sessionToolsResponse } from "./session-tools-mcp.js";
let server: Server;
let home: string;
let status: number;
let body: unknown;
beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), "session-mcp-wire-"));
  mkdirSync(join(home, "workagent"));
  status = 200;
  body = { tools: [{ name: "automation_list", inputSchema: { type: "object", properties: {} } }] };
  server = createServer(async (req, res) => {
    let input = "";
    for await (const chunk of req) input += chunk;
    expect(JSON.parse(input).scopeToken).toBe("scope");
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  writeFileSync(join(home, "workagent", "runtime-gateway.json"), JSON.stringify({ baseURL: `http://127.0.0.1:${port}`, token: "local-test" }));
  vi.stubEnv("DSH_HOME", home);
  vi.stubEnv("WORKAGENT_SESSION_ID", "session");
  vi.stubEnv("WORKAGENT_SCOPE_TOKEN", "scope");
});
afterEach(async () => {
  await new Promise<void>(resolve => server.close(() => resolve()));
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});
it("returns MCP initialization and tool discovery results without the HTTP envelope", async () => {
  expect(await sessionToolsResponse({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).toMatchObject({ result: { protocolVersion: "2025-06-18", capabilities: { tools: {} } } });
  expect(await sessionToolsResponse({ method: "notifications/initialized" })).toBeUndefined();
  expect(await sessionToolsResponse({ id: 2, method: "tools/list" })).toEqual({ jsonrpc: "2.0", id: 2, result: body });
});
it("returns tool data and flags failed tool execution", async () => {
  body = [];
  expect(await sessionToolsResponse({ id: 3, method: "tools/call", params: { name: "automation_list" } })).toMatchObject({ result: { content: [{ type: "text", text: "[]" }] } });
  status = 400; body = { error: "session_scope_expired" };
  expect(await sessionToolsResponse({ id: 4, method: "tools/call", params: { name: "automation_list" } })).toMatchObject({ result: { isError: true, content: [{ type: "text", text: JSON.stringify(body) }] } });
});
it("returns protocol errors for failed discovery and unsupported methods", async () => {
  status = 400; body = { error: "session_scope_expired" };
  const result = await sessionToolsResponse({ id: 5, method: "tools/list" });
  expect(result).toMatchObject({ error: { code: -32603 } });
  expect(result).not.toHaveProperty("result");
  expect(await sessionToolsResponse({ id: 6, method: "unknown" })).toMatchObject({ error: { code: -32601 } });
});
