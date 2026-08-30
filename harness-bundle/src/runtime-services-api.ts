import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { presetMutationSchema } from "@workagent/contracts";
import { authorized } from "./index.js";
import type {
  CredentialStatusStore,
  ModelAccessStore,
} from "./model-access-store.js";
import type { PresetStore } from "./preset-store.js";

const json = (
  response: ServerResponse,
  status: number,
  value: unknown,
): void => {
  response.writeHead(status, {
    "cache-control": "no-store",
    "content-type": "application/json",
  });
  response.end(JSON.stringify(value));
};

const body = async (request: IncomingMessage): Promise<unknown> => {
  let value = "";
  for await (const chunk of request) {
    value += String(chunk);
    if (value.length > 64 * 1024) throw new Error("request_too_large");
  }
  return JSON.parse(value);
};

export class RuntimeServicesController {
  constructor(
    ctx: Context,
    token: string,
    models: ModelAccessStore,
    credentials: CredentialStatusStore,
    presets: PresetStore,
  ) {
    const route = (
      path: string,
      handler: (
        req: IncomingMessage,
        res: ServerResponse,
      ) => void | Promise<void>,
    ) =>
      ctx.effect(
        () =>
          ctx.webServer.register({
            kind: path === "/v1/presets" ? "prefix" : "exact",
            path,
            handler: (request, response) => {
              if (!authorized(request, token)) {
                json(response, 401, { error: "authentication_required" });
                return;
              }
              return handler(request, response);
            },
          }),
        `workagent-runtime-api: ${path} route`,
      );

    route("/v1/models", (request, response) => {
      if (request.method !== "GET") return this.#method(response, "GET");
      json(
        response,
        200,
        models.listModels().map((model) => ({
          ...model,
          authorization: models.authorizationFor(model.id),
        })),
      );
    });
    route("/v1/credentials", (request, response) => {
      if (request.method !== "GET") return this.#method(response, "GET");
      json(response, 200, credentials.listStatuses());
    });
    route("/v1/presets", (request, response) =>
      this.#presets(request, response, presets),
    );
  }

  async #presets(
    request: IncomingMessage,
    response: ServerResponse,
    presets: PresetStore,
  ): Promise<void> {
    const path = new URL(request.url ?? "/", "http://runtime").pathname;
    try {
      if (path === "/v1/presets") {
        if (request.method === "GET")
          return json(response, 200, presets.list());
        if (request.method === "POST") {
          const preset = presets.create(
            presetMutationSchema.parse(await body(request)),
          );
          return json(response, 201, preset);
        }
        return this.#method(response, "GET, POST");
      }
      const match = /^\/v1\/presets\/([^/]+)(?:\/(copy|resolve))?$/.exec(path);
      if (match === null) return json(response, 404, { error: "not_found" });
      const id = decodeURIComponent(match[1] ?? "");
      if (match[2] === "resolve" && request.method === "POST")
        return json(response, 200, presets.resolve(id));
      if (match[2] === "copy" && request.method === "POST") {
        const input = await body(request);
        if (
          input === null ||
          typeof input !== "object" ||
          Array.isArray(input) ||
          typeof (input as Record<string, unknown>).name !== "string"
        )
          return json(response, 400, { error: "invalid_name" });
        return json(
          response,
          201,
          presets.copy(id, (input as { name: string }).name),
        );
      }
      if (match[2] !== undefined) return this.#method(response, "POST");
      if (request.method === "GET") {
        const preset = presets.get(id);
        return preset === undefined
          ? json(response, 404, { error: "preset_not_found" })
          : json(response, 200, preset);
      }
      if (request.method === "PATCH")
        return json(
          response,
          200,
          presets.update(
            id,
            presetMutationSchema.partial().parse(await body(request)),
          ),
        );
      if (request.method === "DELETE") {
        presets.delete(id);
        response.writeHead(204);
        response.end();
        return;
      }
      this.#method(response, "GET, PATCH, DELETE");
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "invalid_request";
      const status = message === "preset_not_found" ? 404 : 400;
      json(response, status, { error: message });
    }
  }

  #method(response: ServerResponse, allow: string): void {
    response.writeHead(405, { allow });
    response.end();
  }
}
