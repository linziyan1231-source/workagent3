import { validateModuleGraph, type ModuleManifest } from "@workagent/contracts";

export const RUNTIME_MODULES = [
  {
    id: "engine-registry",
    version: "1.0.0",
    layer: "runtime",
    required: true,
    capabilities: ["engine.catalog", "engine.status", "engine.capabilities"],
    dependencies: [],
    configSchema: "workagent://schemas/engine-registry/v1",
    dataOwner: "native engine configuration under the employee SID",
    healthCheck: "/v1/engines",
  },
  {
    id: "workspace-runtime",
    version: "1.0.0",
    layer: "runtime",
    required: true,
    capabilities: [
      "workspace.files",
      "workspace.attachments",
      "workspace.artifacts",
    ],
    dependencies: [],
    configSchema: "workagent://schemas/workspace-runtime/v1",
    dataOwner: "employee SID private workspace root and asset index",
    healthCheck: "/v1/workspaces",
  },
  {
    id: "personal-work",
    version: "1.0.0",
    layer: "runtime",
    required: true,
    capabilities: ["session.lifecycle", "session.messages", "session.events"],
    dependencies: [
      { id: "engine-registry", contract: "AgentEngine/v1" },
      { id: "workspace-runtime", contract: "WorkspaceBinding/v1" },
    ],
    configSchema: "workagent://schemas/personal-work/v1",
    dataOwner: "employee SID private session index and message logs",
    healthCheck: "/v1/sessions",
  },
  {
    id: "approval-bridge",
    version: "1.0.0",
    layer: "runtime",
    required: true,
    capabilities: [
      "interaction.pending",
      "interaction.respond",
      "interaction.recover",
    ],
    dependencies: [
      { id: "personal-work", contract: "SessionInteractionSink/v1" },
    ],
    configSchema: "workagent://schemas/approval-bridge/v1",
    dataOwner: "employee SID private pending interaction index",
    healthCheck: "/v1/interactions",
  },
  {
    id: "runtime-api",
    version: "1.0.0",
    layer: "runtime",
    required: true,
    capabilities: ["runtime.health", "runtime.proxy-contract"],
    dependencies: [
      { id: "personal-work", contract: "PersonalWorkPort/v1" },
      { id: "approval-bridge", contract: "ApprovalPort/v1" },
    ],
    configSchema: "workagent://schemas/runtime-api/v1",
    dataOwner: "none; routing and DTO projection only",
    healthCheck: "/health",
  },
] satisfies ModuleManifest[];

validateModuleGraph(RUNTIME_MODULES);
