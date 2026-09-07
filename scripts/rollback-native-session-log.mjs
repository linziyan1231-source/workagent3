import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  copyFileSync,
  writeFileSync,
} from "node:fs";
import { resolve, join } from "node:path";

// Run only with Portal ingress and the employee runtime stopped. Export visible
// messages before reverting the profile; keep full protocol history for recovery.
const [home, backup, mode = "check"] = process.argv.slice(2);
if (!home || !backup || !["check", "apply"].includes(mode))
  throw new Error(
    "Usage: node rollback-native-session-log.mjs DSH_HOME BACKUP_DIRECTORY [check|apply]",
  );
const base = join(resolve(home), "workagent", "personal-work");
const source = join(base, "native-sessions", "v1");
const destination = resolve(backup);
if (destination.startsWith(source + "\\") || destination === source)
  throw new Error("Backup must be outside the native log directory");
if (!existsSync(source)) {
  console.log(
    JSON.stringify({ sessions: 0, message: "No active native log directory" }),
  );
  process.exit(0);
}
const plans = readdirSync(source)
  .filter((name) => /^session-[a-zA-Z0-9-]+\.jsonl$/.test(name))
  .filter((name) => !existsSync(join(source, `${name.slice(0, -6)}.tombstone`)))
  .map((name) => {
    const id = name.slice(0, -6);
    const rows = readFileSync(join(source, name), "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
    if (
      rows[0]?.id !== id ||
      rows.slice(1).some((event, seq) => event.seq !== seq)
    )
      throw new Error(`Invalid canonical header or sequence in ${name}`);
    const messages = rows
      .filter((event) => event.type === "workagent/native/message")
      .map((event) => event.data);
    for (const message of messages)
      if (
        message.sessionId !== id ||
        typeof message.text !== "string" ||
        !["user", "assistant"].includes(message.role)
      )
        throw new Error(`Invalid canonical message in ${name}`);
    return { name, messages };
  });
if (mode === "apply") {
  if (existsSync(destination))
    throw new Error(
      "Use a fresh backup directory; inspect any previous rollback journal first",
    );
  mkdirSync(destination, { recursive: true });
  mkdirSync(join(base, "messages"), { recursive: true });
  writeFileSync(
    join(destination, "journal.json"),
    JSON.stringify({
      phase: "exporting",
      home: resolve(home),
      sessions: plans.map((plan) => plan.name),
    }),
  );
  for (const { name, messages } of plans) {
    const target = join(base, "messages", name);
    if (existsSync(target)) copyFileSync(target, join(destination, name));
    const stage = `${target}.native-rollback-stage`;
    writeFileSync(
      stage,
      messages.map((message) => JSON.stringify(message) + "\n").join(""),
      { flag: "wx" },
    );
    renameSync(stage, target);
  }
  // A later upgrade now imports all messages written by the reverted release.
  // Never reuse an obsolete native log beside a newer legacy transcript.
  renameSync(source, join(destination, "native-v1"));
  writeFileSync(
    join(destination, "journal.json"),
    JSON.stringify({
      phase: "complete",
      home: resolve(home),
      sessions: plans.map((plan) => plan.name),
    }),
  );
}
console.log(
  JSON.stringify({
    mode,
    sessions: plans.length,
    messages: plans.reduce((count, plan) => count + plan.messages.length, 0),
  }),
);
