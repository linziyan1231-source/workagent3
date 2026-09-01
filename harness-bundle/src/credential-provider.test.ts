import { Context } from "@deepseek-ai/cordis";
import { credentialKey, credentialRef } from "@deepseek-ai/dsh-credentials";
import { describe, expect, it } from "vitest";
import WorkAgentCredentialProvider from "./credential-provider.js";

describe("WorkAgent credential Provider", () => {
  it("projects references only in memory and reports status without values", async () => {
    const provider = new WorkAgentCredentialProvider(new Context());
    const ref = credentialRef("DEEPSEEK_API_KEY");

    expect(await provider.resolve(ref)).toBeUndefined();
    await provider.set(ref, "private-provider-key");
    expect(await provider.resolve(ref)).toEqual({
      value: "private-provider-key",
      source: "workagent-broker-projection",
    });
    expect(await provider.describe(ref)).toEqual({
      configured: true,
      source: "workagent-broker-projection",
      writable: true,
    });
    expect(JSON.stringify(await provider.describe(ref))).not.toContain(
      "private-provider-key",
    );

    await provider.unset(ref);
    expect(await provider.resolve(ref)).toBeUndefined();
  });

  it("implements the official record seam without durable storage", async () => {
    const provider = new WorkAgentCredentialProvider(new Context());
    const key = credentialKey("llm-pi-ai", "managed");
    const record = await provider.modifyRecord(key, async () => ({
      kind: "api-key",
      apiKey: "private-provider-key",
    }));

    expect(record?.kind).toBe("api-key");
    expect(await provider.describeRecord(key)).toEqual({
      configured: true,
      kind: "api-key",
      writable: true,
    });
    expect(await provider.listRecords()).toEqual([{ key, kind: "api-key" }]);
    await provider.deleteRecord(key);
    expect(await provider.readRecord(key)).toBeUndefined();
  });
});
