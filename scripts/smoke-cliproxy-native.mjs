import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const nativeHome = process.env.WORKAGENT_NATIVE_HOME;
if (nativeHome === undefined)
  throw new Error("WORKAGENT_NATIVE_HOME is required");
process.env.CODEX_HOME = join(nativeHome, "codex");
process.env.KIMI_CODE_HOME = join(nativeHome, "kimi");
const workspace = join(root, ".cache", "cliproxy-native-smoke", "workspace");
await mkdir(workspace, { recursive: true });

const [{ CodexBridge }, { KimiBridge }] = await Promise.all([
  import("../harness-bundle/dist/engines/codex.js"),
  import("../harness-bundle/dist/engines/kimi.js"),
]);
const requested = process.env.WORKAGENT_NATIVE_ENGINE;
const engines = [new CodexBridge(), new KimiBridge()].filter(
  (engine) => requested === undefined || requested === engine.id,
);
if (engines.length === 0)
  throw new Error(`unknown native engine: ${requested}`);

const run = async (engine) => {
  const status = await engine.status();
  if (status.state === "needs_auth" || status.state === "unavailable")
    throw new Error(`${engine.id} status is ${status.state}`);
  let answer = "";
  let finish;
  const terminal = new Promise((resolve) => {
    finish = resolve;
  });
  const session = await engine.create(workspace, (event) => {
    if (event.type === "assistant.completed") answer += event.content;
    if (
      ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type)
    )
      finish(event);
  });
  await session.send(
    `Reply with exactly WORKAGENT3_${engine.id.toUpperCase()}_CLIPROXY_OK. Do not call tools or modify files.`,
  );
  const outcome = await Promise.race([
    terminal,
    new Promise((_, reject) =>
      setTimeout(
        () => reject(new Error(`${engine.id} turn timed out`)),
        90_000,
      ),
    ),
  ]);
  const expected = `WORKAGENT3_${engine.id.toUpperCase()}_CLIPROXY_OK`;
  if (outcome.type !== "turn.completed" || !answer.includes(expected))
    throw new Error(`${engine.id} terminal=${outcome.type} answer=${answer}`);
  process.stdout.write(`${engine.id} CLIProxyAPI turn passed\n`);
  await session.close();
  await engine.close();
};

let failed = false;
for (const engine of engines) {
  try {
    await run(engine);
  } catch (error) {
    failed = true;
    process.stderr.write(
      `${engine.id} CLIProxyAPI turn failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    await engine.close();
  }
}
process.exit(failed ? 1 : 0);
