import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const nativeHome =
  process.env.WORKAGENT_NATIVE_HOME ??
  join(root, ".cache", "dsh-home", "native-smoke");
const workspace = join(root, ".cache", "native-task-smoke", "workspace");
process.env.CODEX_HOME =
  process.env.WORKAGENT_CODEX_HOME ?? join(nativeHome, "codex");
process.env.KIMI_CODE_HOME =
  process.env.WORKAGENT_KIMI_HOME ?? join(nativeHome, "kimi");
await mkdir(workspace, { recursive: true });

const [{ CodexBridge }, { KimiBridge }] = await Promise.all([
  import("../harness-bundle/dist/engines/codex.js"),
  import("../harness-bundle/dist/engines/kimi.js"),
]);

const selected = process.env.WORKAGENT_NATIVE_ENGINE;
const engines = [new CodexBridge(), new KimiBridge()].filter(
  (engine) => selected === undefined || engine.id === selected,
);
if (engines.length === 0) throw new Error(`unknown native engine: ${selected}`);

class EventStream {
  events = [];
  waiter;

  push(event) {
    this.events.push(event);
    this.waiter?.();
  }

  async next(after, predicate, timeoutMs = 120_000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const event = this.events.slice(after).find(predicate);
      if (event !== undefined) return event;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("native engine turn timed out");
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiter = undefined;
          reject(new Error("native engine turn timed out"));
        }, remaining);
        this.waiter = () => {
          clearTimeout(timer);
          this.waiter = undefined;
          resolve();
        };
      });
    }
  }

  terminal(after, timeoutMs = 120_000) {
    return this.next(
      after,
      (candidate) =>
        ["turn.completed", "turn.cancelled", "turn.failed"].includes(
          candidate.type,
        ),
      timeoutMs,
    );
  }
}

const runEngine = async (engine) => {
  const terminalDescription = (event) =>
    event.type === "turn.failed"
      ? `${event.type} (${event.code}: ${event.message})`
      : event.type;
  const status = await engine.status();
  process.stdout.write(`${engine.id} status: ${status.state}\n`);
  if (status.state === "needs_auth" || status.state === "unavailable") {
    throw new Error(status.detail ?? `${engine.id} is not ready`);
  }

  const events = new EventStream();
  let session = await engine.create(workspace, (event) => events.push(event), {
    mcpServers: [],
  });
  const nativeId = session.nativeId;
  let offset = events.events.length;
  await session.send(
    "Reply with exactly WORKAGENT3_NATIVE_OK. Do not call tools or modify files.",
  );
  let terminal = await events.terminal(offset);
  if (terminal.type !== "turn.completed")
    throw new Error(
      `${engine.id} task ended as ${terminalDescription(terminal)}`,
    );
  const answer = events.events
    .slice(offset)
    .filter((event) => event.type === "assistant.completed")
    .map((event) => event.content)
    .join("");
  if (!answer.includes("WORKAGENT3_NATIVE_OK"))
    throw new Error(`${engine.id} did not return the task marker`);

  await session.close();
  session = await engine.resume(
    nativeId,
    workspace,
    (event) => events.push(event),
    { mcpServers: [] },
  );
  offset = events.events.length;
  await session.send(
    "Reply with exactly WORKAGENT3_RESUME_OK. Do not call tools or modify files.",
  );
  terminal = await events.terminal(offset);
  if (terminal.type !== "turn.completed")
    throw new Error(
      `${engine.id} resumed task ended as ${terminalDescription(terminal)}`,
    );

  offset = events.events.length;
  await session.send(
    "You must use the terminal to run this exact read-only command before replying: powershell -NoProfile -Command Start-Sleep -Seconds 120. After it exits, reply WORKAGENT3_CANCEL_MISSED. Do not modify files.",
  );
  const cancellable = await events.next(
    offset,
    (event) =>
      event.type === "tool.started" ||
      ["turn.completed", "turn.cancelled", "turn.failed"].includes(event.type),
    60_000,
  );
  if (cancellable.type !== "tool.started")
    throw new Error(
      `${engine.id} cancellation setup ended as ${terminalDescription(cancellable)}`,
    );
  await session.cancel();
  terminal = await events.terminal(offset);
  if (terminal.type !== "turn.cancelled")
    throw new Error(
      `${engine.id} cancellation ended as ${terminalDescription(terminal)}`,
    );
  await session.close();
  process.stdout.write(`${engine.id} task, resume, and cancellation passed\n`);
};

let failed = false;
for (const engine of engines) {
  try {
    await runEngine(engine);
  } catch (error) {
    failed = true;
    process.stderr.write(
      `${engine.id} task smoke failed: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  } finally {
    await engine.close();
  }
}
if (failed) process.exitCode = 1;
