import { readFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import {
  acpCatalogEntrySchema,
  type AcpCatalogEntry,
} from "@workagent/contracts";
import { AcpBridge } from "./engines/acp-transport.js";
import { nativeEngineEnvironment } from "./engines/environment.js";

/** Reads the trusted UserHost route; package definitions and Broker values never come from a session prompt. */
export class ManagedAcpCatalog {
  readonly #bridges = new Map<string, AcpBridge>();
  constructor(readonly dshHome: string) {}

  async #request(path: string): Promise<unknown> {
    const endpoint = JSON.parse(
      readFileSync(join(this.dshHome, "workagent", "acp-gateway.json"), "utf8"),
    ) as { baseURL: string; token: string };
    const base = new URL(endpoint.baseURL);
    if (
      base.protocol !== "http:" ||
      !["127.0.0.1", "[::1]"].includes(base.hostname)
    )
      throw new Error("acp_gateway_invalid");
    const response = await fetch(new URL(path, base), {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) {
      const value = (await response.json().catch(() => ({}))) as {
        error?: string;
      };
      throw new Error(value.error || "acp_catalog_unavailable");
    }
    return response.json();
  }
  async list(): Promise<AcpCatalogEntry[]> {
    const value = (await this.#request("/internal/acp-catalog")) as {
      entries: unknown[];
    };
    return value.entries.map((row) => acpCatalogEntrySchema.parse(row));
  }
  async resolve(id: string, revision?: string): Promise<AcpCatalogEntry> {
    const value = acpCatalogEntrySchema.parse(
      await this.#request(
        `/internal/acp-catalog/${encodeURIComponent(id)}${revision ? `?revision=${encodeURIComponent(revision)}` : ""}`,
      ),
    );
    if (!value.enabled) throw new Error("acp_catalog_disabled");
    return value;
  }
  async bridge(entry: AcpCatalogEntry): Promise<AcpBridge> {
    const current = await this.resolve(entry.id, entry.revision);
    if (
      current.packageRef !== entry.packageRef ||
      current.command !== entry.command ||
      JSON.stringify(current.args) !== JSON.stringify(entry.args) ||
      current.billingModelId !== entry.billingModelId
    )
      throw new Error("acp_catalog_revision_changed");
    const key = `${entry.id}:${entry.revision}`;
    let bridge = this.#bridges.get(key);
    if (bridge) return bridge;
    bridge = new AcpBridge({
      id: "acp",
      command: current.resolvedCommand ?? current.command,
      cwd: dirname(current.resolvedCommand ?? current.command),
      args: entry.args,
      environment: async () => {
        await this.resolve(entry.id, entry.revision);
        const value = (await this.#request(
          `/internal/acp-catalog/${encodeURIComponent(entry.id)}/credentials?revision=${encodeURIComponent(entry.revision)}`,
        )) as { environment: Record<string, string> };
        const env = nativeEngineEnvironment(process.env, "ACP_HOME");
        env.ACP_HOME = join(this.dshHome, "workagent", "acp", entry.id);
        mkdirSync(env.ACP_HOME, { recursive: true });
        for (const field of entry.credentialFields) {
          const secret = value.environment[field.environment];
          if (field.required && !secret)
            throw new Error("acp_credentials_required");
          if (secret !== undefined) env[field.environment] = secret;
        }
        return env;
      },
      applyOptions: async (connection, sessionId, options, modes, config) => {
        if (options?.modelId && options.modelId !== "default") {
          const model = config?.find(
            (row) => row.category === "model" && row.type === "select",
          );
          if (model)
            await connection.setSessionConfigOption({
              sessionId,
              configId: model.id,
              value: options.modelId,
            });
          else
            await connection.unstable_setSessionModel({
              sessionId,
              modelId: options.modelId,
            });
        }
        if (options?.permissionMode) {
          const modeId = entry.permissionModes?.[options.permissionMode];
          if (
            !modeId ||
            !modes?.availableModes.some((mode) => mode.id === modeId)
          ) {
            if (options.requirePermission)
              throw new Error("engine_permission_unavailable");
          } else if (modeId !== modes.currentModeId)
            await connection.setSessionMode({ sessionId, modeId });
        }
      },
      permission: (result) => {
        const selected = Object.entries(entry.permissionModes || {}).find(
          ([, id]) => id === result.modes?.currentModeId,
        )?.[0];
        return (
          (selected as
            | "read_only"
            | "workspace_write"
            | "full_access"
            | undefined) ?? "manual_approval"
        );
      },
      models: async (_connection, _sessionId, models, config) => {
        const select = config?.find(
          (item) => item.category === "model" && item.type === "select",
        );
        if (select?.type === "select")
          return select.options
            .flatMap((option) =>
              "options" in option ? option.options : [option],
            )
            .map((option) => ({
              id: option.value,
              name: option.name,
              isDefault: option.value === select.currentValue,
              reasoning: [],
            }));
        return (
          models?.availableModels.map((model) => ({
            id: model.modelId,
            name: model.name,
            isDefault: model.modelId === models.currentModelId,
            reasoning: [],
          })) || [
            { id: "default", name: "默认模型", isDefault: true, reasoning: [] },
          ]
        );
      },
    });
    this.#bridges.set(key, bridge);
    return bridge;
  }
  async close(): Promise<void> {
    await Promise.all(
      [...this.#bridges.values()].map((bridge) => bridge.close()),
    );
    this.#bridges.clear();
  }
}
