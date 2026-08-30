import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const nativeHome = join(root, ".cache", "native-engine-smoke");
process.env.CODEX_HOME = join(nativeHome, "codex");
process.env.KIMI_CODE_HOME = join(nativeHome, "kimi");
await mkdir(process.env.CODEX_HOME, { recursive: true });
await mkdir(process.env.KIMI_CODE_HOME, { recursive: true });

const [{ CodexBridge }, { KimiBridge }] = await Promise.all([
  import("../harness-bundle/dist/engines/codex.js"),
  import("../harness-bundle/dist/engines/kimi.js"),
]);
const codex = new CodexBridge();
const kimi = new KimiBridge();
try {
  await Promise.all([codex.probe(), kimi.probe()]);
  process.stdout.write(
    "Codex app-server and Kimi ACP initialized successfully\n",
  );
} finally {
  await Promise.all([codex.close(), kimi.close()]);
}
