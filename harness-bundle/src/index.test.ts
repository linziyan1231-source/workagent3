import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { describe, expect, it } from "vitest";
import { createHealthHandler } from "./index.js";

type RecordedResponse = {
  body: string;
  headers: Record<string, string>;
  status: number;
};

const invoke = (authorization?: string, method = "GET"): RecordedResponse => {
  const request = new EventEmitter() as IncomingMessage;
  Object.assign(request, {
    headers: authorization === undefined ? {} : { authorization },
    method,
  });
  const recorded: RecordedResponse = { body: "", headers: {}, status: 0 };
  const response = new EventEmitter() as ServerResponse;
  Object.assign(response, {
    writeHead: (status: number, headers: Record<string, string> = {}) => {
      recorded.status = status;
      recorded.headers = headers;
      return response;
    },
    end: (body = "") => {
      recorded.body = body;
      return response;
    },
  });
  createHealthHandler("a-secure-runtime-token")(request, response);
  return recorded;
};

describe("runtime health route", () => {
  it("requires the private runtime bearer token", () => {
    expect(invoke().status).toBe(401);
    expect(invoke("Bearer wrong").status).toBe(401);
  });

  it("returns a no-store health response", () => {
    const response = invoke("Bearer a-secure-runtime-token");
    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(JSON.parse(response.body)).toEqual({ status: "healthy" });
  });
});
