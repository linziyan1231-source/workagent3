import { timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

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

export const authorized = (
  request: IncomingMessage,
  expectedToken: string,
): boolean => {
  const provided = request.headers.authorization;
  if (provided === undefined || !provided.startsWith("Bearer ")) return false;
  const actual = Buffer.from(provided.slice("Bearer ".length));
  const expected = Buffer.from(expectedToken);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
};

export const createHealthHandler =
  (token: string) =>
  (request: IncomingMessage, response: ServerResponse): void => {
    if (!authorized(request, token)) {
      json(response, 401, { error: "authentication_required" });
      return;
    }
    if (request.method !== "GET") {
      response.writeHead(405, { allow: "GET" });
      response.end();
      return;
    }
    json(response, 200, { status: "healthy" });
  };
