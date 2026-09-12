import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { StoredMessage } from "./message-store.js";

const rolloutIndexes = new Map<string, string[]>();

/** Recover presentation metadata from native history, never from message wording. */
export function readCodexMessageKinds(
  home: string,
  nativeId: string,
): Map<string, NonNullable<StoredMessage["kind"]>> {
  const result = new Map<string, NonNullable<StoredMessage["kind"]>>();
  const root = join(home, "sessions");
  if (!existsSync(root)) return result;
  let paths = rolloutIndexes.get(root);
  if (!paths) {
    paths = readdirSync(root, { recursive: true }) as string[];
    rolloutIndexes.set(root, paths);
  }
  const path = paths.find((path) => path.endsWith(`-${nativeId}.jsonl`));
  if (!path) return result;
  // An active native writer can leave an incomplete final line. Do not inspect
  // reasoning or tool outputs, and do not change the source rollout.
  const lines = readFileSync(join(root, path), "utf8").split("\n");
  for (const line of lines.slice(0, -1)) {
    if (!line) continue;
    const record = JSON.parse(line);
    if (record.type !== "response_item") continue;
    const item = record.payload;
    if (item.type === "message" && item.role === "assistant" && item.id) {
      if (item.phase === "commentary") result.set(item.id, "commentary");
      if (item.phase === "final_answer") result.set(item.id, "answer");
    } else if (
      item.type === "function_call" &&
      item.name === "request_user_input_async" &&
      item.call_id
    ) {
      result.set(item.call_id, "question");
    }
  }
  return result;
}
