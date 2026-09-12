export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
  }
}

export const postJson = <T>(path: string, body: unknown) =>
  requestJson<T>(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

export async function requestJson<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  const response = await requestRaw(path, {
    ...init,
    headers: {
      accept: "application/json",
      ...init.headers,
    },
  });
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function requestRaw(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as {
      error?: string;
      code?: string;
    };
    throw new ApiError(
      response.status,
      body.error ?? body.code ?? "request_failed",
    );
  }
  return response;
}
