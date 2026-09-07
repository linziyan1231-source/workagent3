import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

const tokensPath = new URL("./tokens.css", import.meta.url);
const previewAssets = {
  "document-preview.html": [
    new URL("./document-preview.html", import.meta.url),
    "text/html",
  ],
  "docx-preview.js": [require.resolve("docx-preview"), "text/javascript"],
  "jszip.js": [
    join(dirname(require.resolve("jszip/package.json")), "dist/jszip.min.js"),
    "text/javascript",
  ],
};

// Host half: client-modules intentionally serves only client.js artifacts, so
// the external WorkAgent token sheet gets one explicit plugin-owned route.
export const inject = ["webServer"];

export function apply(ctx) {
  for (const [name, [path, type]] of Object.entries(previewAssets)) {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "exact",
          path: `/plugins/@workagent/dsh-client/${name}`,
          handler: async (request, response) => {
            if (!["GET", "HEAD"].includes(request.method)) {
              response.writeHead(405, { allow: "GET, HEAD" });
              response.end();
              return;
            }
            const data = await readFile(path);
            response.writeHead(200, {
              "content-type": `${type}; charset=utf-8`,
              "cache-control": "no-cache",
              "content-length": data.length,
            });
            response.end(request.method === "HEAD" ? undefined : data);
          },
        }),
      `workagent-client: ${name}`,
    );
  }
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/plugins/@workagent/dsh-client/tokens.css",
        handler: async (request, response) => {
          if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { allow: "GET, HEAD" });
            response.end();
            return;
          }
          const css = await readFile(tokensPath);
          response.writeHead(200, {
            "cache-control": "no-cache",
            "content-length": css.length,
            "content-type": "text/css; charset=utf-8",
          });
          response.end(request.method === "HEAD" ? undefined : css);
        },
      }),
    "workagent-client: token stylesheet route",
  );
}
