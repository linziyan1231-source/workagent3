import { readFile } from "node:fs/promises";

export const inject = ["webServer"];
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "exact",
        path: "/plugins/@workagent/dsh-appearance/tokens.css",
        handler: async (request, response) => {
          if (request.method !== "GET" && request.method !== "HEAD") {
            response.writeHead(405, { allow: "GET, HEAD" });
            response.end();
            return;
          }
          const css = await readFile(new URL("./tokens.css", import.meta.url));
          response.writeHead(200, {
            "content-type": "text/css; charset=utf-8",
            "content-length": css.length,
            "cache-control": "no-cache",
          });
          response.end(request.method === "HEAD" ? undefined : css);
        },
      }),
    "workagent-appearance: stylesheet route",
  );
}
