import { z } from "zod";
import type {
  PresetBinding,
  SharedTurnRuntimeRequest,
} from "@workagent/contracts";
import { sharedTurnRequestSchema } from "@workagent/contracts";
import { platformQuotaConfiguration } from "./quota-client.js";

export async function runtimeMarketCapabilities(
  workspaceId: string,
): Promise<SharedTurnRuntimeRequest["capabilities"]> {
  const configuration = platformQuotaConfiguration(process.env);
  if (!configuration) return undefined;
  const response = await fetch(
    new URL("/internal/runtime/market-capabilities", configuration.baseURL),
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${configuration.token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        sid: configuration.sid,
        projectId: workspaceId.startsWith("shared:")
          ? workspaceId.slice(7)
          : "",
        workspaceId: workspaceId.startsWith("shared:") ? "" : workspaceId,
      }),
      signal: AbortSignal.timeout(30000),
    },
  );
  const result = (await response.json()) as {
    error?: string;
    capabilities?: unknown;
  };
  if (!response.ok)
    throw new Error(result.error || "market_capabilities_unavailable");
  return sharedTurnRequestSchema.shape.capabilities.parse(result.capabilities);
}

export const marketChangeSchema = z.object({
  skills: z.record(z.string(), z.string()),
  mcp: z.record(z.string(), z.string()),
  assistants: z.record(z.string(), z.string()).default({}),
  urgent: z.boolean().default(false),
});
export type MarketChange = z.infer<typeof marketChangeSchema>;
export function remapCapabilityIds(
  ids: readonly string[],
  changes: Record<string, string>,
): string[] {
  return [...new Set(ids.map((id) => changes[id] ?? id).filter(Boolean))];
}
export function projectCapabilityBinding(
  binding: PresetBinding,
  cap: SharedTurnRuntimeRequest["capabilities"],
): PresetBinding {
  if (!cap) return binding;
  if (!binding.projectBase && !cap.entryIds.length) return binding;
  const base = binding.projectBase ?? binding.resolvedSnapshot;
  const snapshot = { ...base };
  snapshot.skillIds = [
    ...new Set([
      ...snapshot.skillIds.filter((id) => !cap.excludedSkillIds.includes(id)),
      ...cap.skillIds,
    ]),
  ];
  snapshot.mcpServerIds = [
    ...new Set([
      ...snapshot.mcpServerIds.filter((id) => !cap.excludedMcpIds.includes(id)),
      ...cap.mcpServerIds,
    ]),
  ];
  delete snapshot.resolvedMcpServers;
  return { ...binding, projectBase: base, resolvedSnapshot: snapshot };
}
