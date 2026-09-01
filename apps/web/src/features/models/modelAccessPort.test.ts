import { afterEach, describe, expect, it, vi } from "vitest";
import {
  maskedProviderCredential,
  modelAccessPort,
  toRendererProviders,
} from "./modelAccessPort.js";

const model = {
  id: "codex-native",
  providerId: "codex",
  displayName: "Codex native",
  aliases: [],
  contextWindow: 128_000,
  inputPricePerMillion: null,
  outputPricePerMillion: null,
  health: "healthy" as const,
  authorization: { modelId: "codex-native", authorized: true },
};

afterEach(() => vi.unstubAllGlobals());

describe("Model Access HTTP port", () => {
  it("projects centrally managed models into the production Renderer shape", () => {
    expect(toRendererProviders([model])).toEqual([
      expect.objectContaining({
        id: "managed-cliproxy-chatgpt",
        name: "ChatGPT",
        api_key: "",
        models: ["codex-native"],
        model_enabled: { "codex-native": true },
      }),
    ]);
  });

  it("shows only a fixed mask for a ready managed Provider credential", () => {
    const harness = { ...model, id: "harness-default", providerId: "harness" };
    expect(
      toRendererProviders(
        [harness],
        [
          {
            id: "provider-harness",
            kind: "provider",
            state: "ready",
            label: "Harness managed Provider",
            updatedAt: null,
          },
        ],
      )[0]?.api_key,
    ).toBe(maskedProviderCredential);
  });

  it("loads model authorization and credential status together", async () => {
    const fetch = vi.fn(
      async (path: string) =>
        new Response(
          JSON.stringify(
            path.endsWith("/models")
              ? [model]
              : [
                  {
                    id: "codex-native",
                    kind: "codex_native",
                    state: "ready",
                    label: "Codex",
                    updatedAt: null,
                  },
                ],
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);

    const snapshot = await modelAccessPort.snapshot();
    expect(snapshot.models).toHaveLength(1);
    expect(snapshot.credentials[0]?.state).toBe("ready");
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith("/api/models", expect.any(Object));
  });
});
