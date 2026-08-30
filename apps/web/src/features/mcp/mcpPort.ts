import {
  runtimeMcpMutationSchema,
  runtimeMcpConnectionResultSchema,
  runtimeMcpServerListSchema,
  runtimeMcpServerSchema,
  type RuntimeMcpMutation,
  type RuntimeMcpConnectionResult,
  type RuntimeMcpServer,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

const base = "/api/runtime/v1/mcp-servers";

export const mcpPort = {
  async list(): Promise<RuntimeMcpServer[]> {
    return runtimeMcpServerListSchema.parse(await requestJson<unknown>(base));
  },
  async create(input: RuntimeMcpMutation): Promise<RuntimeMcpServer> {
    return runtimeMcpServerSchema.parse(
      await requestJson<unknown>(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(runtimeMcpMutationSchema.parse(input)),
      }),
    );
  },
  async update(
    id: string,
    input: Partial<RuntimeMcpMutation>,
  ): Promise<RuntimeMcpServer> {
    return runtimeMcpServerSchema.parse(
      await requestJson<unknown>(`${base}/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },
  async remove(id: string): Promise<void> {
    await requestJson<void>(`${base}/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  },
  async test(id: string): Promise<RuntimeMcpConnectionResult> {
    return runtimeMcpConnectionResultSchema.parse(
      await requestJson<unknown>(`${base}/${encodeURIComponent(id)}/test`, {
        method: "POST",
      }),
    );
  },
};
