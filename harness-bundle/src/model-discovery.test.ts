import { describe, expect, it, vi } from "vitest";
import type { Context } from "@deepseek-ai/cordis";
import { discoverModels } from "./model-discovery.js";
import { kimiModelOptions, kimiSessionModelOptions } from "./engines/kimi.js";
import type { SessionConfigOption } from "@agentclientprotocol/sdk";
import type { EngineBridge } from "./engines/types.js";

describe("live model discovery", () => {
  it("discovers Kimi thinking choices for each model while retaining the default", async () => {
    const config = (id: string): SessionConfigOption[] => [
      {
        type: "select",
        id: "model",
        name: "Model",
        category: "model",
        currentValue: id,
        options: ["k3", "k2.7", "fast"].map((value) => ({
          value,
          name: value,
        })),
      },
      {
        type: "select",
        id: "thinking",
        name: "Thinking",
        category: "thought_level",
        currentValue: id === "k3" ? "low" : "thinking",
        options: (id === "k3" ? ["low", "high", "max"] : ["thinking"]).map(
          (value) => ({ value, name: value }),
        ),
      },
    ];
    const connection = {
      setSessionConfigOption: vi.fn(async ({ value }) => ({
        configOptions: config(value),
      })),
    };
    const models = await kimiSessionModelOptions(
      connection as never,
      "probe",
      undefined,
      config("k3"),
    );
    expect(
      models.map((model) => [
        model.id,
        model.isDefault,
        model.reasoning.map((row) => row.id),
      ]),
    ).toEqual([
      ["k3", true, ["low", "high", "max"]],
      ["k2.7", false, ["thinking"]],
      ["fast", false, ["thinking"]],
    ]);
    expect(
      connection.setSessionConfigOption.mock.calls.map(([call]) => call.value),
    ).toEqual(["k2.7", "fast"]);
  });

  it("reads current capabilities on each refresh and contains failed engines", async () => {
    const resolveModelInfo = vi.fn().mockResolvedValue({
      reasoning: {
        efforts: [{ id: "xhigh", name: "Extended" }],
        defaultEffort: "xhigh",
      },
    });
    const ctx = {
      agentDefaultModel: {
        currentSelection: () => ({ provider: "managed", model: "live" }),
      },
      llm: {
        listModels: vi.fn().mockResolvedValue([{ id: "live", name: "Live" }]),
        resolveModelInfo,
      },
    } as unknown as Context;
    const bridges = new Map([
      [
        "codex",
        {
          listModels: vi
            .fn()
            .mockRejectedValue(new Error("private diagnostic")),
        } as unknown as EngineBridge,
      ],
    ]);
    const first = await discoverModels(ctx, bridges);
    expect(first[0]?.models[0]).toMatchObject({
      id: "live",
      isDefault: true,
      defaultReasoning: "xhigh",
    });
    expect(first[1]).toMatchObject({
      engine: "codex",
      state: "unavailable",
      models: [],
    });
    expect(JSON.stringify(first)).not.toContain("private diagnostic");
    resolveModelInfo.mockResolvedValue({
      reasoning: { efforts: [{ id: "max", name: "Maximum" }] },
    });
    const second = await discoverModels(ctx, bridges);
    expect(second[0]?.models[0]?.reasoning).toEqual([
      { id: "max", name: "Maximum" },
    ]);
  });

  it("derives Kimi thinking choices only from advertised ACP variants", () => {
    expect(
      kimiModelOptions({
        currentModelId: "kimi,thinking",
        availableModels: [
          { modelId: "kimi", name: "Kimi" },
          { modelId: "kimi,thinking", name: "Kimi (thinking)" },
          { modelId: "plain", name: "Plain" },
        ],
      }),
    ).toEqual([
      {
        id: "kimi",
        name: "Kimi",
        isDefault: true,
        defaultReasoning: "thinking",
        reasoning: [
          { id: "off", name: "关闭思考" },
          { id: "thinking", name: "开启思考" },
        ],
      },
      {
        id: "plain",
        name: "Plain",
        isDefault: false,
        reasoning: [{ id: "off", name: "关闭思考" }],
      },
    ]);
  });

  it("reads current Kimi models and effort levels from ACP config options", () => {
    expect(
      kimiModelOptions(undefined, [
        {
          type: "select",
          id: "model",
          name: "Model",
          category: "model",
          currentValue: "kimi-k3",
          options: [{ value: "kimi-k3", name: "Kimi" }],
        },
        {
          type: "select",
          id: "thinking",
          name: "Thinking",
          category: "thought_level",
          currentValue: "high",
          options: [
            { value: "off", name: "Off" },
            { value: "high", name: "High" },
            { value: "max", name: "Max" },
          ],
        },
      ]),
    ).toEqual([
      {
        id: "kimi-k3",
        name: "Kimi",
        isDefault: true,
        reasoning: [
          { id: "off", name: "Off" },
          { id: "high", name: "High" },
          { id: "max", name: "Max" },
        ],
        defaultReasoning: "high",
      },
    ]);
  });
});
