import {
  presetDefinitionListSchema,
  presetDefinitionSchema,
  type PresetDefinition,
  type PresetMutation,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

export type PresetPort = {
  list(): Promise<PresetDefinition[]>;
  create(input: PresetMutation): Promise<PresetDefinition>;
  update(id: string, input: Partial<PresetMutation>): Promise<PresetDefinition>;
  copy(id: string, name: string): Promise<PresetDefinition>;
  remove(id: string): Promise<void>;
};

export const presetPort: PresetPort = {
  async list() {
    return presetDefinitionListSchema.parse(
      await requestJson<unknown>("/api/runtime/v1/presets"),
    );
  },
  async create(input) {
    return presetDefinitionSchema.parse(
      await requestJson<unknown>("/api/runtime/v1/presets", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(input),
      }),
    );
  },
  async update(id, input) {
    return presetDefinitionSchema.parse(
      await requestJson<unknown>(
        `/api/runtime/v1/presets/${encodeURIComponent(id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        },
      ),
    );
  },
  async copy(id, name) {
    return presetDefinitionSchema.parse(
      await requestJson<unknown>(
        `/api/runtime/v1/presets/${encodeURIComponent(id)}/copy`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name }),
        },
      ),
    );
  },
  async remove(id) {
    await requestJson<void>(
      `/api/runtime/v1/presets/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
  },
};
