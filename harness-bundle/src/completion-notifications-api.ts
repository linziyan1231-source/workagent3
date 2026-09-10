import type { Context } from "@deepseek-ai/cordis";
import type { IncomingMessage, ServerResponse } from "node:http";
import { authorized } from "./index.js";
import type { CompletionNotifications } from "./completion-notifications.js";

export function mountCompletionNotifications(
  ctx: Context,
  token: string,
  notifications: CompletionNotifications,
  hasSession: (id: string) => boolean,
) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: "prefix",
        path: "/v1/completion-notifications",
        handler: async (request: IncomingMessage, response: ServerResponse) => {
          const send = (status: number, value: unknown) => {
            response.writeHead(status, {
              "content-type": "application/json",
              "cache-control": "no-store",
            });
            response.end(JSON.stringify(value));
          };
          if (!authorized(request, token)) {
            send(401, { error: "unauthorized" });
            return;
          }
          const path = new URL(request.url ?? "/", "http://runtime").pathname;
          try {
            if (
              path === "/v1/completion-notifications" &&
              request.method === "GET"
            ) {
              send(200, notifications.snapshot());
              return;
            }
            if (request.method !== "PUT" && request.method !== "POST") {
              send(405, { error: "method_not_allowed" });
              return;
            }
            let raw = "";
            for await (const chunk of request) {
              raw += String(chunk);
              if (raw.length > 16384) throw new Error("提醒设置过长");
            }
            const input = JSON.parse(raw);
            if (path === "/v1/completion-notifications/session" && request.method === "PUT") {
              if (typeof input.sessionId !== "string" || !hasSession(input.sessionId) || typeof input.enabled !== "boolean") throw new Error("会话提醒设置不正确");
              send(200, notifications.configureSession(input.sessionId, input.enabled));
              return;
            }
            if (
              path === "/v1/completion-notifications" &&
              request.method === "PUT"
            ) {
              send(200, notifications.configure(input));
              return;
            }
            if (
              path === "/v1/completion-notifications/retry" &&
              request.method === "POST"
            ) {
              if (typeof input.id !== "string") throw new Error("缺少提醒记录");
              await notifications.retry(input.id);
              send(200, notifications.snapshot());
              return;
            }
            send(404, { error: "not_found" });
          } catch (error) {
            send(400, {
              error: error instanceof Error ? error.message : "提醒设置失败",
            });
          }
        },
      }),
    "workagent-completion-notifications: settings",
  );
}
