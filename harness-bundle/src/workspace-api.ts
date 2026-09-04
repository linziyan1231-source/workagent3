import type { IncomingMessage, ServerResponse } from "node:http";
import type { Context } from "@deepseek-ai/cordis";
import { authorized } from "./index.js";
import { WorkspaceStore } from "./workspace-store.js";

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;

const INLINE_PREVIEW_MEDIA_TYPES: Record<string, string> = {
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  pdf: "application/pdf",
  png: "image/png",
  webp: "image/webp",
};

export const workspaceContentHeaders = (
  path: string,
  length: number,
  inlineRequested: boolean,
): Record<string, string | number> => {
  const fileName = path.split("/").at(-1) ?? "file";
  const extension = fileName.toLocaleLowerCase().split(".").pop() ?? "";
  const mediaType = inlineRequested
    ? INLINE_PREVIEW_MEDIA_TYPES[extension]
    : undefined;
  const disposition = mediaType === undefined ? "attachment" : "inline";
  return {
    "cache-control": "no-store",
    "content-disposition": `${disposition}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "content-length": length,
    "content-type": mediaType ?? "application/octet-stream",
    ...(mediaType === undefined
      ? {}
      : {
          "content-security-policy":
            "default-src 'none'; frame-ancestors 'self'; base-uri 'none'",
        }),
  };
};

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

const body = async (
  request: IncomingMessage,
  limit = 64 * 1024,
): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > limit) throw new Error("request_too_large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
};

const objectBody = async (
  request: IncomingMessage,
): Promise<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse((await body(request)).toString("utf8"));
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
    throw new Error("object_required");
  return parsed as Record<string, unknown>;
};

const errorStatus = (error: unknown): [number, string] => {
  const code =
    error instanceof Error ? error.message : "workspace_operation_failed";
  if (code === "workspace_not_found" || code === "file_not_found")
    return [404, code];
  if (code === "request_too_large") return [413, code];
  if (code === "destination_exists") return [409, code];
  if (
    code === "invalid_relative_path" ||
    code === "path_outside_workspace" ||
    code === "reparse_point_rejected" ||
    code === "unsafe_workspace_root" ||
    code === "not_a_directory" ||
    code === "not_a_file" ||
    code === "invalid_session_id" ||
    code === "invalid_asset_name"
  )
    return [400, code];
  console.error("workagent-workspace-api: operation failed", error);
  return [500, "workspace_operation_failed"];
};

export class WorkspaceController {
  readonly #token: string;
  readonly #store: WorkspaceStore;
  readonly #workspaceForSession: (sessionId: string) => string | undefined;

  constructor(
    ctx: Context,
    token: string,
    store?: WorkspaceStore,
    workspaceForSession: (sessionId: string) => string | undefined = () =>
      undefined,
  ) {
    this.#token = token;
    if (store === undefined) {
      const root = process.env.WORKAGENT_WORKSPACE_ROOT;
      const dshHome = process.env.DSH_HOME;
      if (root === undefined || dshHome === undefined)
        throw new Error("workagent-workspace-api: private roots are required");
      store = new WorkspaceStore(root, dshHome);
    }
    this.#store = store;
    this.#workspaceForSession = workspaceForSession;
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: "prefix",
          path: "/v1/workspaces",
          handler: (request, response) => this.#handle(request, response),
        }),
      "workagent-workspace-api: workspace routes",
    );
  }

  async #handle(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    if (!authorized(request, this.#token)) {
      json(response, 401, { error: "authentication_required" });
      return;
    }
    try {
      await this.#route(request, response);
    } catch (error) {
      const [status, code] = errorStatus(error);
      json(response, status, { error: code });
    }
  }

  async #route(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", "http://runtime");
    if (url.pathname === "/v1/workspaces") {
      if (request.method === "GET") {
        json(response, 200, this.#store.list());
        return;
      }
      if (request.method === "POST") {
        const input = await objectBody(request);
        if (
          typeof input.name !== "string" ||
          input.name.trim() === "" ||
          input.name.length > 120
        ) {
          json(response, 400, { error: "invalid_workspace_name" });
          return;
        }
        json(response, 201, this.#store.create(input.name.trim()));
        return;
      }
    }
    const match =
      /^\/v1\/workspaces\/([^/]+)\/(files|content|directories|move|assets|attachments)$/.exec(
        url.pathname,
      );
    if (match === null) {
      json(response, 404, { error: "not_found" });
      return;
    }
    const id = decodeURIComponent(match[1] ?? "");
    const action = match[2];
    const path = url.searchParams.get("path") ?? "";
    const sessionId = url.searchParams.get("sessionId") ?? "";
    if (action === "files" && request.method === "GET") {
      json(response, 200, this.#store.listFiles(id, path));
      return;
    }
    if (action === "content" && request.method === "GET") {
      const content = this.#store.read(id, path);
      response.writeHead(
        200,
        workspaceContentHeaders(
          path,
          content.length,
          url.searchParams.get("preview") === "1",
        ),
      );
      response.end(content);
      return;
    }
    if (action === "content" && request.method === "PUT") {
      json(
        response,
        200,
        this.#store.write(id, path, await body(request, MAX_UPLOAD_BYTES)),
      );
      return;
    }
    if (action === "content" && request.method === "DELETE") {
      this.#store.delete(id, path);
      response.writeHead(204);
      response.end();
      return;
    }
    if (action === "directories" && request.method === "POST") {
      const input = await objectBody(request);
      if (typeof input.path !== "string")
        throw new Error("invalid_relative_path");
      this.#store.mkdir(id, input.path);
      response.writeHead(204);
      response.end();
      return;
    }
    if (action === "move" && request.method === "POST") {
      const input = await objectBody(request);
      if (
        typeof input.source !== "string" ||
        typeof input.destination !== "string"
      )
        throw new Error("invalid_relative_path");
      this.#store.move(id, input.source, input.destination);
      response.writeHead(204);
      response.end();
      return;
    }
    if (action === "assets" && request.method === "GET") {
      if (!this.#sessionBelongsToWorkspace(sessionId, id)) {
        json(response, 404, { error: "session_not_found" });
        return;
      }
      json(response, 200, this.#store.listAssets(id, sessionId));
      return;
    }
    if (action === "attachments" && request.method === "PUT") {
      if (!this.#sessionBelongsToWorkspace(sessionId, id)) {
        json(response, 404, { error: "session_not_found" });
        return;
      }
      const name = url.searchParams.get("name") ?? "";
      json(
        response,
        201,
        this.#store.addAttachment(
          id,
          sessionId,
          name,
          request.headers["content-type"] ?? "application/octet-stream",
          await body(request, MAX_UPLOAD_BYTES),
        ),
      );
      return;
    }
    if (action === "assets" && request.method === "POST") {
      const input = await objectBody(request);
      if (
        !this.#sessionBelongsToWorkspace(sessionId, id) ||
        typeof input.path !== "string" ||
        (input.name !== undefined && typeof input.name !== "string") ||
        (input.mediaType !== undefined && typeof input.mediaType !== "string")
      ) {
        json(response, 400, { error: "invalid_artifact" });
        return;
      }
      json(
        response,
        201,
        this.#store.registerArtifact(
          id,
          sessionId,
          input.path,
          input.name,
          input.mediaType,
        ),
      );
      return;
    }
    json(response, 405, { error: "method_not_allowed" });
  }

  #sessionBelongsToWorkspace(sessionId: string, workspaceId: string): boolean {
    return (
      sessionId !== "" && this.#workspaceForSession(sessionId) === workspaceId
    );
  }
}
