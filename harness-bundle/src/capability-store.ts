import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, dirname, join, relative } from "node:path";
import { randomUUID } from "node:crypto";
import {
  runtimeMcpMutationSchema,
  runtimeMcpServerListSchema,
  skillCatalogListSchema,
  type RuntimeMcpMutation,
  type RuntimeMcpServer,
  type SkillCatalogEntry,
} from "@workagent/contracts";

const writePrivate = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  renameSync(temporary, path);
};

export class SkillCatalogStore {
  readonly #path: string;
  readonly #skills = new Map<string, SkillCatalogEntry>();

  constructor(dshHome: string) {
    this.#path = join(dshHome, "workagent", "skills.json");
    if (!existsSync(this.#path)) return;
    for (const skill of skillCatalogListSchema.parse(
      JSON.parse(readFileSync(this.#path, "utf8")),
    ))
      this.#skills.set(skill.id, skill);
  }

  listSkills(): readonly SkillCatalogEntry[] {
    return [...this.#skills.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  getSkill(id: string): SkillCatalogEntry | undefined {
    return this.#skills.get(id);
  }

  setEnabled(id: string, enabled: boolean): SkillCatalogEntry {
    const skill = this.#skills.get(id);
    if (skill === undefined) throw new Error("skill_not_found");
    const next = { ...skill, enabled };
    this.#skills.set(id, next);
    writePrivate(this.#path, this.listSkills());
    return next;
  }
}

export class McpCatalogStore {
  readonly #path: string;
  readonly #managedRoot: string;
  readonly #servers = new Map<string, RuntimeMcpServer>();

  constructor(dshHome: string) {
    this.#path = join(dshHome, "workagent", "mcp-servers.json");
    this.#managedRoot = join(dshHome, "managed-tools");
    if (!existsSync(this.#path)) return;
    for (const server of runtimeMcpServerListSchema.parse(
      JSON.parse(readFileSync(this.#path, "utf8")),
    )) {
      this.#validateTransport(server);
      this.#servers.set(server.id, server);
    }
  }

  listServers(): readonly RuntimeMcpServer[] {
    return [...this.#servers.values()].sort((left, right) =>
      left.name.localeCompare(right.name),
    );
  }

  getServer(id: string): RuntimeMcpServer | undefined {
    return this.#servers.get(id);
  }

  create(input: RuntimeMcpMutation): RuntimeMcpServer {
    const value = runtimeMcpMutationSchema.parse(input);
    const now = new Date().toISOString();
    const server = {
      ...value,
      id: `mcp-${randomUUID()}`,
      health: value.health ?? "unknown",
      createdAt: now,
      updatedAt: now,
    } satisfies RuntimeMcpServer;
    this.#validateTransport(server);
    this.#servers.set(server.id, server);
    this.#save();
    return server;
  }

  update(id: string, input: unknown): RuntimeMcpServer {
    const current = this.#servers.get(id);
    if (current === undefined) throw new Error("mcp_server_not_found");
    const value = runtimeMcpMutationSchema.partial().parse(input);
    const server = runtimeMcpServerListSchema.element.parse({
      ...current,
      ...value,
      id,
      updatedAt: new Date().toISOString(),
    });
    this.#validateTransport(server);
    this.#servers.set(id, server);
    this.#save();
    return server;
  }

  delete(id: string): void {
    if (!this.#servers.delete(id)) throw new Error("mcp_server_not_found");
    this.#save();
  }

  #validateTransport(server: RuntimeMcpServer): void {
    if (server.transport.kind === "stdio") {
      if (!isAbsolute(server.transport.command))
        throw new Error("mcp_stdio_command_must_be_absolute");
      if (server.source === "managed") {
        const candidate = relative(this.#managedRoot, server.transport.command);
        if (candidate.startsWith("..") || isAbsolute(candidate))
          throw new Error("managed_mcp_outside_managed_tools");
      }
      return;
    }
    const url = new URL(server.transport.url);
    const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
      throw new Error("mcp_endpoint_requires_https");
  }

  #save(): void {
    writePrivate(this.#path, this.listServers());
  }
}
