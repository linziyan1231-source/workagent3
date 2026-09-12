import assert from "node:assert/strict";
import { createRequire } from "node:module";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  symlinkSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { Readable, Writable } from "node:stream";

const repository = fileURLToPath(new URL("..", import.meta.url));
const profile = process.env.WORKAGENT_SMOKE_PROFILE;
const bundle = profile
  ? join(profile, "node_modules", "@workagent", "harness-bundle")
  : join(repository, "harness-bundle");
const require = createRequire(join(bundle, "package.json"));
const load = async (name) => import(pathToFileURL(require.resolve(name)).href);
const { JsonLineRpc } = await import(
  pathToFileURL(join(bundle, "dist", "engines", "jsonl-rpc.js")).href
);
const { codexCapabilityConfig } = await import(
  pathToFileURL(join(bundle, "dist", "engines", "codex.js")).href
);
const { kimiSkillDirectories } = await import(
  pathToFileURL(join(bundle, "dist", "engines", "skills.js")).href
);
const { Context } = await load("@deepseek-ai/cordis");
const { apply: installSkills } = await load(
  "@deepseek-ai/dsh-skill-filesystem",
);
const { ClientSideConnection, ndJsonStream, PROTOCOL_VERSION } = await load(
  "@agentclientprotocol/sdk",
);
const root = mkdtempSync(
  join(
    process.env.WORKAGENT_SMOKE_EVIDENCE_DIR ?? tmpdir(),
    "wa3-global-native-",
  ),
);
const write = (path, text) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};
const workspace = join(root, "workspace");
mkdirSync(workspace);
mkdirSync(join(workspace, ".git"));
const codexHome = join(root, "codex"),
  kimiHome = join(root, "kimi");
process.env.CODEX_HOME = codexHome;
process.env.KIMI_CODE_HOME = kimiHome;
process.env.DSH_HOME = join(root, "dsh");
write(
  join(codexHome, "auth.json"),
  JSON.stringify({
    auth_mode: "apikey",
    OPENAI_API_KEY: "fixture-not-a-real-key",
  }),
);
write(
  join(codexHome, "config.toml"),
  'model="gpt-5"\nopenai_base_url="http://127.0.0.1:9/v1"\ncli_auth_credentials_store="file"\n',
);
write(
  join(kimiHome, "config.toml"),
  'default_model="kimi-code/kimi-k3"\n[providers."managed:kimi-code"]\ntype="kimi"\nbase_url="http://127.0.0.1:9/v1"\napi_key="cpa_abcdefghijklmnopqrstuvwxyz"\n[models."kimi-code/kimi-k3"]\nprovider="managed:kimi-code"\nmodel="kimi-k3"\nmax_context_size=1048576\ncapabilities=["thinking"]\n',
);
const makeSkill = (id) => {
  const source = join(root, "original", id),
    reference = join(root, "references", id);
  write(
    join(source, "SKILL.md"),
    `---\nname: ${id}\ndescription: Read the shared resource fixture\n---\nRead resources/example.txt.\n`,
  );
  write(join(source, "resources", "example.txt"), "shared resource");
  mkdirSync(reference, { recursive: true });
  symlinkSync(
    source,
    join(reference, id),
    process.platform === "win32" ? "junction" : "dir",
  );
  return {
    root: reference,
    entry: {
      id,
      name: id,
      description: "Read shared resource",
      version: "1",
      source: "user",
      enabled: true,
      referenceDirectory: source,
      relativePath: `${id}/${id}`,
      requiredMcpServerIds: [],
      requiredCommands: [],
      health: "ready",
    },
  };
};
const shared = makeSkill("global-fixture"),
  disabled = makeSkill("disabled-fixture");
write(
  join(kimiHome, "config.toml"),
  `extra_skill_dirs=${JSON.stringify([shared.root])}\n` +
    readFileSync(join(kimiHome, "config.toml"), "utf8"),
);
write(
  join(workspace, ".agents", "skills", "project-fixture", "SKILL.md"),
  "---\nname: project-fixture\ndescription: Project-scoped fixture\n---\nOnly this project.\n",
);
const report = { root, checks: [] };
const ctx = new Context();
let provider;
ctx.provide("skills", {
  registerProvider(factory) {
    provider = factory({
      signal: new AbortController().signal,
      invalidate() {},
    });
    return () => {};
  },
});
installSkills(ctx, {
  providerName: "global-fixture",
  includeDefaultRoots: false,
  bundledSkillDir: shared.root,
  watch: false,
  watchFollowSymlinks: false,
});
const candidates = await provider.list({ cwd: workspace });
assert.equal(candidates.length, 1);
assert.equal(candidates[0].name, shared.entry.name);
const loaded = await provider.get(candidates[0], {
  signal: new AbortController().signal,
});
assert.equal(
  readFileSync(
    join(loaded.resourceBase.path, "resources", "example.txt"),
    "utf8",
  ),
  "shared resource",
);
await ctx.fiber.dispose();
report.checks.push(
  "DSH discovers directory reference and reads sibling resource",
);

const marker = join(root, "codex-mcp");
const now = new Date().toISOString();
const server = {
  server: {
    id: "platform-fixture",
    name: "fixture",
    source: "user",
    enabled: true,
    transport: {
      kind: "stdio",
      command: process.execPath,
      args: [
        join(dirname(fileURLToPath(import.meta.url)), "mcp-smoke-server.mjs"),
        marker,
      ],
      environmentCredentialIds: {},
      globalSource: "codex/config:fixture",
      nativeName: "fixture",
    },
    toolPolicy: "all",
    allowedTools: [],
    oauthState: "none",
    health: "healthy",
    createdAt: now,
    updatedAt: now,
  },
  environment: {},
  headers: {},
  state: "ready",
};
const options = {
  mcpServers: [server],
  skills: [shared],
  catalogSkills: [shared, disabled],
  nativeMcpNames: ["fixture", "removed"],
  nativeMcpConfig: {
    removed: { url: "https://removed.invalid/mcp", enabled: false },
  },
};
const { butlerServer } = await import(
  pathToFileURL(join(bundle, "dist", "butler-mcp.js")).href
);
let accountName = "before";
const butlerAPI = createServer(async (req, res) => {
  assert.equal(req.headers.authorization, "Bearer fixture-butler-token");
  if (req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    accountName = JSON.parse(body).name;
  }
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ name: accountName, token: "must-be-hidden" }));
});
await new Promise((resolve) => butlerAPI.listen(0, "127.0.0.1", resolve));
write(
  join(process.env.DSH_HOME, "workagent", "runtime-gateway.json"),
  JSON.stringify({
    baseURL: `http://127.0.0.1:${butlerAPI.address().port}`,
    token: "fixture-butler-token",
  }),
);
options.mcpServers.push(butlerServer());
const codex = spawn(
  process.env.WORKAGENT_CODEX_BIN ?? "codex",
  ["app-server", "--listen", "stdio://"],
  { env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);
codex.stderr.resume();
const rpc = new JsonLineRpc(codex.stdout, codex.stdin);
try {
  await rpc.request("initialize", {
    clientInfo: { name: "wa3-capability-verification", version: "1" },
    capabilities: { experimentalApi: true },
  });
  rpc.notify("initialized", {});
  await rpc.request("skills/extraRoots/set", {
    extraRoots: [shared.root, disabled.root],
  });
  const skills = await rpc.request("skills/list", {
    cwds: [workspace],
    forceReload: true,
  });
  assert.ok(
    skills.data[0].skills.some((skill) => skill.name === "global-fixture"),
  );
  assert.ok(
    skills.data[0].skills.some((skill) => skill.name === "project-fixture"),
  );
  const result = await rpc.request(
    "thread/start",
    { cwd: workspace, config: codexCapabilityConfig(options, workspace) },
    60000,
  );
  const call = await rpc.request(
    "mcpServer/tool/call",
    {
      threadId: result.thread.id,
      server: "fixture",
      tool: "ping",
      arguments: {},
    },
    60000,
  );
  assert.equal(call.content[0].text, "pong");
  const resource = await rpc.request("mcpServer/resource/read", {
    threadId: result.thread.id,
    server: "fixture",
    uri: "fixture://resource",
  });
  assert.equal(resource.contents[0].text, "shared resource");
  const butlerCall = async (tool, args = {}) =>
    rpc.request(
      "mcpServer/tool/call",
      {
        threadId: result.thread.id,
        server: "workagent-butler",
        tool,
        arguments: args,
      },
      60000,
    );
  const overview = await butlerCall("butler_overview");
  assert.equal(overview.isError, false);
  const overviewData = JSON.parse(overview.content[0].text);
  for (const key of ["mcp", "skills", "assistants", "channels"]) {
    assert.equal(overviewData[key].status, 200);
    assert.equal(overviewData[key].data.token, "[已隐藏]");
  }
  const configured = await butlerCall("butler_configure", {
    method: "POST",
    path: "/dsh-im-connect/api/accounts/fixture/settings",
    body: { name: "after" },
  });
  assert.equal(configured.isError, false);
  const readback = await butlerCall("butler_read", {
    path: "/dsh-im-connect/api/channels",
  });
  assert.equal(JSON.parse(readback.content[0].text).data.name, "after");
  assert.equal(
    (
      await butlerCall("butler_configure", {
        method: "POST",
        path: "/internal/mcp-projection",
        body: {},
      })
    ).isError,
    true,
  );
  report.checks.push(
    "actual Codex MCP butler reads status, configures fixture channel, verifies readback, redacts secrets and rejects internal routes",
  );
  report.checks.push(
    "Codex discovers shared and project skills, invokes canonical MCP tool and reads MCP resource",
  );
} finally {
  rpc.close();
  codex.kill();
  butlerAPI.closeAllConnections();
  await new Promise((resolve) => butlerAPI.close(resolve));
}

const updates = [];
const kimi = spawn(
  process.env.WORKAGENT_KIMI_BIN ?? "kimi",
  [
    ...kimiSkillDirectories(workspace, options).flatMap((path) => [
      "--skills-dir",
      path,
    ]),
    "acp",
  ],
  { env: process.env, stdio: ["pipe", "pipe", "pipe"], windowsHide: true },
);
kimi.stderr.resume();
const connection = new ClientSideConnection(
  () => ({
    sessionUpdate: async (update) => updates.push(update),
    requestPermission: async () => ({ outcome: { outcome: "cancelled" } }),
  }),
  ndJsonStream(Writable.toWeb(kimi.stdin), Readable.toWeb(kimi.stdout)),
);
const timeout = setTimeout(() => kimi.kill(), 60000);
try {
  await connection.initialize({
    protocolVersion: PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: "wa3-capability-verification", version: "1" },
  });
  const response = await connection.newSession({
    cwd: workspace,
    mcpServers: [
      {
        name: "fixture",
        command: process.execPath,
        args: [
          join(dirname(fileURLToPath(import.meta.url)), "mcp-smoke-server.mjs"),
          join(root, "kimi-mcp"),
        ],
        env: [],
      },
    ],
  });
  assert.ok(response.sessionId);
  await new Promise((resolve) => setTimeout(resolve, 1000));
  write(join(root, "kimi-updates.json"), JSON.stringify(updates, null, 2));
  const names = updates
    .flatMap(({ update }) => update.availableCommands ?? [])
    .map((command) => command.name);
  write(
    join(root, "kimi-command-discovery.json"),
    JSON.stringify(names, null, 2),
  );
  assert.ok(
    names.some((name) => name.includes("global-fixture")),
    "Kimi did not discover shared skill via ACP",
  );
  assert.ok(
    names.some((name) => name.includes("project-fixture")),
    "Kimi lost project skill",
  );
  assert.ok(
    !names.some((name) => name.includes("disabled-fixture")),
    "Kimi discovered disabled skill",
  );
  assert.ok(
    existsSync(join(root, "kimi-mcp")),
    "Kimi did not initialize projected MCP",
  );
  report.checks.push(
    "Kimi ACP discovers enabled shared and project skills, excludes disabled skills, initializes MCP",
  );
} finally {
  clearTimeout(timeout);
  kimi.kill();
}
write(join(root, "report.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
