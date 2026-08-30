import {
  presetDefinitionListSchema,
  type PresetDefinition,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

export type PresetPort = {
  list(): Promise<PresetDefinition[]>;
};

export const presetPort: PresetPort = {
  async list() {
    return presetDefinitionListSchema.parse(
      await requestJson<unknown>("/api/runtime/v1/presets"),
    );
  },
};
