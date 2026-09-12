import { Context } from "@deepseek-ai/cordis";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { expect, it } from "vitest";
import { installHarnessPrompt } from "./harness-configuration.js";

it("renders assistant instructions through the installed official prompt registry without interpolating user text", async () => {
  const require = createRequire(import.meta.url);
  const agentRequire = createRequire(require.resolve("@deepseek-ai/dsh-agent"));
  const { SystemPrompt, renderPrompt } = await import(
    pathToFileURL(agentRequire.resolve("@deepseek-ai/dsh-system-prompt")).href
  );
  const { createScope } = await import(
    pathToFileURL(agentRequire.resolve("@deepseek-ai/dsh-scope")).href
  );
  const ctx = new Context();
  new SystemPrompt(ctx, {
    includeHarnessIdentity: false,
    includeRuntimeContext: false,
    persona: "Deployment default",
  });
  const key = {};
  const scope = createScope(ctx, key);
  installHarnessPrompt(
    scope.ctx,
    "Use {{literal_variable}} exactly.\nKeep these instructions.",
  );
  const assembly = await ctx.systemPrompt.assemble({ scope: key });
  expect(renderPrompt(assembly)).toBe(
    "Use {{literal_variable}} exactly.\nKeep these instructions.",
  );
  expect(assembly.sections).toHaveLength(1);
  expect(renderPrompt(await ctx.systemPrompt.assemble())).toBe(
    "Deployment default",
  );
  await scope.dispose();
  expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: key }))).toBe(
    "Deployment default",
  );
});
