import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute } from "node:path";

const configPath = process.env.WORKAGENT_LEGACY_USERHOST_CONFIG;
if (!configPath || !isAbsolute(configPath)) {
  throw new Error(
    "WORKAGENT_LEGACY_USERHOST_CONFIG must be an absolute protected WorkAgent2 UserHost config path",
  );
}
const info = lstatSync(configPath);
if (!info.isFile() || info.isSymbolicLink()) {
  throw new Error("legacy UserHost config must be a regular non-symlink file");
}
const config = JSON.parse(readFileSync(configPath, "utf8"));
const endpoint = new URL(config.kimi_datasource?.endpoint ?? "");
let token = config.kimi_datasource?.token;
config.kimi_datasource = undefined;
if (
  endpoint.protocol !== "http:" ||
  endpoint.hostname !== "127.0.0.1" ||
  endpoint.pathname !== "/mcp" ||
  endpoint.search !== "" ||
  endpoint.hash !== "" ||
  typeof token !== "string" ||
  token.trim().length < 32
) {
  token = "";
  throw new Error("legacy professional-database grant is invalid or unsafe");
}

const call = async (id, method, params = {}) => {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok)
    throw new Error(`professional-database HTTP ${response.status}`);
  const message = await response.json();
  if (
    message.jsonrpc !== "2.0" ||
    message.id !== id ||
    !message.result ||
    message.error
  ) {
    throw new Error(
      `professional-database ${method} returned an invalid MCP response`,
    );
  }
  return message.result;
};

try {
  const initialized = await call(1, "initialize", {
    protocolVersion: "2025-03-26",
    capabilities: {},
    clientInfo: {
      name: "WorkAgent3 professional database smoke",
      version: "0.1.0",
    },
  });
  if (initialized.serverInfo?.name !== "workagent2-professional-datasource") {
    throw new Error("unexpected professional-database server identity");
  }
  const listed = await call(2, "tools/list");
  const tools = Array.isArray(listed.tools) ? listed.tools : [];
  const names = new Set(tools.map((tool) => tool.name));
  if (
    !names.has("get_data_source_desc") ||
    !names.has("call_data_source_tool")
  ) {
    throw new Error("professional-database tools are incomplete");
  }
  const sourceEnum = tools.find((tool) => tool.name === "get_data_source_desc")
    ?.inputSchema?.properties?.name?.enum;
  if (!Array.isArray(sourceEnum) || sourceEnum.length === 0) {
    throw new Error("professional-database employee source allowlist is empty");
  }
  let liveCall = false;
  if (process.env.WORKAGENT_PROFESSIONAL_DATABASE_LIVE_CALL === "1") {
    const result = await call(3, "tools/call", {
      name: "get_data_source_desc",
      arguments: { name: sourceEnum[0] },
    });
    const text = result.content?.find((item) => item.type === "text")?.text;
    if (
      result.isError === true ||
      typeof text !== "string" ||
      text.trim().length === 0
    ) {
      throw new Error("professional-database live description call failed");
    }
    liveCall = true;
  }
  console.log(
    `Professional database smoke passed: authenticated MCP initialize, ${sourceEnum.length} authorized sources${liveCall ? ", and one live description call" : ""}.`,
  );
} finally {
  token = "";
}
