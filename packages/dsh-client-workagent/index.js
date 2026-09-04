import { readFile } from "node:fs/promises";

const tokensPath = new URL("./tokens.css", import.meta.url);

// Host half: client-modules intentionally serves only client.js artifacts, so
// the external WorkAgent token sheet gets one explicit plugin-owned route.
export const inject = ["webServer"];

export function apply(ctx) {
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
