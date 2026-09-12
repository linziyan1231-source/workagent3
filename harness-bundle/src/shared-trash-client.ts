import { request as httpRequest } from "node:http";
import { platformQuotaConfiguration } from "./quota-client.js";

export const SHARED_TRASH_REQUEST_TIMEOUT_MS = 180_000;
export const SHARED_TRASH_TOOL_TIMEOUT_MS = 210_000;

export type SharedTrashOperation = {
  projectId: string;
  operation: "list" | "recycle" | "restore";
  path?: string;
  entryId?: string;
};

export class SharedTrashError extends Error {
  constructor(
    readonly status: number,
    code: string,
  ) {
    super(code);
  }
}

/** Uses the employee's existing authenticated platform channel. */
export class PlatformSharedTrashClient {
  constructor(
    readonly configuration: NonNullable<
      ReturnType<typeof platformQuotaConfiguration>
    >,
  ) {}

  static fromEnvironment(environment: NodeJS.ProcessEnv = process.env) {
    const configuration = platformQuotaConfiguration(environment);
    return configuration && new PlatformSharedTrashClient(configuration);
  }

  async operate(
    input: SharedTrashOperation,
    source?: "workspace-store",
  ): Promise<unknown> {
    const url = new URL(
      "internal/runtime/shared-trash",
      this.configuration.baseURL,
    );
    const headers = {
      authorization: `Bearer ${this.configuration.token}`,
      "content-type": "application/json",
    };
    const body = JSON.stringify({
      ...input,
      ...(source ? { source } : {}),
      sid: this.configuration.sid,
    });
    // Once the owner's Store admits a deletion, it must keep its move lock
    // until the central transaction acknowledges it, even if the browser or
    // calling tool disconnects. Node HTTP avoids fetch's implicit header timer.
    const response = source
      ? await new Promise<Response>((resolve, reject) => {
          const request = httpRequest(
            url,
            { method: "POST", headers, agent: false },
            (response) => {
              void (async () => {
                const chunks: Buffer[] = [];
                for await (const chunk of response)
                  chunks.push(Buffer.from(chunk));
                resolve(
                  new Response(Buffer.concat(chunks), {
                    status: response.statusCode!,
                  }),
                );
              })().catch(reject);
            },
          );
          request.on("error", reject);
          request.end(body);
        })
      : await fetch(url, {
          method: "POST",
          headers,
          body,
          signal: AbortSignal.timeout(SHARED_TRASH_REQUEST_TIMEOUT_MS),
        });
    if (!response.ok) {
      let code = `shared_trash_http_${response.status}`;
      try {
        const payload = (await response.json()) as { error?: unknown };
        if (typeof payload.error === "string") code = payload.error;
      } catch {
        // Preserve the status if the upstream failure has no JSON body.
      }
      throw new SharedTrashError(response.status, code);
    }
    return response.json();
  }
}
