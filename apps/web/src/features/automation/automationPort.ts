import {
  automationDefinitionListSchema,
  automationDefinitionSchema,
  automationRunListSchema,
  automationRunSchema,
  type AutomationDefinition,
  type AutomationMutation,
  type AutomationRun,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

const base = "/api/runtime/v1/automations";

export type AutomationPort = {
  list(): Promise<AutomationDefinition[]>;
  create(input: AutomationMutation): Promise<AutomationDefinition>;
  update(
    definition: AutomationDefinition,
    input: Partial<AutomationMutation>,
  ): Promise<AutomationDefinition>;
  remove(id: string): Promise<void>;
  run(id: string): Promise<AutomationRun>;
  history(id: string): Promise<AutomationRun[]>;
  cancel(automationId: string, runId: string): Promise<AutomationRun>;
};

const path = (id: string) => `${base}/${encodeURIComponent(id)}`;

export const automationPort: AutomationPort = {
  async list() {
    return automationDefinitionListSchema.parse(
      await requestJson<unknown>(base),
    );
  },
  async create(input) {
    return automationDefinitionSchema.parse(
      await requestJson<unknown>(base, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },
  async update(definition, input) {
    return automationDefinitionSchema.parse(
      await requestJson<unknown>(path(definition.id), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ version: definition.version, ...input }),
      }),
    );
  },
  async remove(id) {
    await requestJson(path(id), { method: "DELETE" });
  },
  async run(id) {
    return automationRunSchema.parse(
      await requestJson<unknown>(`${path(id)}/run`, { method: "POST" }),
    );
  },
  async history(id) {
    return automationRunListSchema.parse(
      await requestJson<unknown>(`${path(id)}/runs`),
    );
  },
  async cancel(automationId, runId) {
    return automationRunSchema.parse(
      await requestJson<unknown>(
        `${path(automationId)}/runs/${encodeURIComponent(runId)}/cancel`,
        { method: "POST" },
      ),
    );
  },
};
