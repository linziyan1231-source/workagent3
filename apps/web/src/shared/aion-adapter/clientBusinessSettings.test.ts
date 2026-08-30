import { afterEach, describe, expect, it, vi } from "vitest";
import { getClientBusinessSetting } from "./clientBusinessSettings";

describe("managed speech settings adapter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("projects only server capability into the formal AionUi speech config", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          enabled: true,
          streaming: true,
          maxAudioBytes: 1024,
          maxStreamSeconds: 60,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const config = await getClientBusinessSetting("tools.speechToText");

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/speech/capability",
      expect.objectContaining({ credentials: "same-origin" }),
    );
    expect(config).toMatchObject({ enabled: true, provider: "deepgram" });
    expect(JSON.stringify(config)).not.toContain("speech-adapter-secret");
  });

  it("hides the formal microphone when the server disables speech", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ enabled: false, streaming: false }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );

    await expect(
      getClientBusinessSetting("tools.speechToText"),
    ).resolves.toBeUndefined();
  });
});
