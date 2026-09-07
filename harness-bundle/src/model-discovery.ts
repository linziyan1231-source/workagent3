import type { Context } from "@deepseek-ai/cordis";
import type { EngineBridge, EngineModel } from "./engines/types.js";

export async function discoverModels(
  ctx: Context,
  bridges: ReadonlyMap<string, EngineBridge>,
) {
  const fetchedAt = new Date().toISOString();
  const sources: Array<[string, () => Promise<EngineModel[]>]> = [
    [
      "harness",
      async () => {
        const selection = ctx.agentDefaultModel.currentSelection();
        const models = await ctx.llm.listModels(selection.provider);
        return Promise.all(
          models.map(async (model) => {
            const details = await ctx.llm.resolveModelInfo(
              selection.provider,
              model.id,
            );
            return {
              id: model.id,
              name: model.name,
              isDefault: model.id === selection.model,
              reasoning: (details.reasoning?.efforts ?? []).map((effort) => ({
                id: String(effort.id),
                name: effort.name,
              })),
              ...(details.reasoning?.defaultEffort
                ? { defaultReasoning: String(details.reasoning.defaultEffort) }
                : {}),
            };
          }),
        );
      },
    ],
    ...[...bridges].map(
      ([engine, bridge]): [string, () => Promise<EngineModel[]>] => [
        engine,
        () => bridge.listModels(),
      ],
    ),
  ];
  return Promise.all(
    sources.map(async ([engine, load]) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const models = await Promise.race([
          load(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(
              () => reject(new Error("model_discovery_timeout")),
              25_000,
            );
          }),
        ]);
        return {
          engine,
          state: models.length ? "ready" : "empty",
          models,
          fetchedAt,
        };
      } catch {
        // Native diagnostics can contain paths or provider details; keep them out of the UI.
        return { engine, state: "unavailable", models: [], fetchedAt };
      } finally {
        clearTimeout(timer);
      }
    }),
  );
}
