import {
  skillMcpMigrationReportSchema,
  type SkillMcpMigrationReport,
} from "@workagent/contracts";
import { requestJson } from "../../shared/api/http.js";

export const migrationPort = {
  async skillMcpReport(): Promise<SkillMcpMigrationReport> {
    return skillMcpMigrationReportSchema.parse(
      await requestJson<unknown>("/api/runtime/v1/migrations/skills-mcp"),
    );
  },
};
