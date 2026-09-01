import { EventEmitter } from "node:events";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createManagedProviderHealthHandler } from "./provider-health-api.js";

const invoke = async (method = "POST", token = "runtime-token") => {
  const request = Readable.from([]) as IncomingMessage;
  Object.assign(request, {
    headers: { authorization: `Bearer ${token}` },
    method,
  });
  const recorded = { body: "", status: 0 };
  const response = new EventEmitter() as ServerResponse;
  Object.assign(response, {
    writeHead: (status: number) => {
      recorded.status = status;
      return response;
    },
    end: (value = "") => {
      recorded.body = value;
      return response;
    },
  });
  const probe = vi.fn(async () => ({
    status: "healthy" as const,
    message: "provider_request_succeeded",
  }));
  await createManagedProviderHealthHandler("runtime-token", probe)(
    request,
    response,
  );
  return { probe, recorded };
};

describe("managed Provider health route", () => {
  it("runs a bounded authenticated probe and returns stable redacted status", async () => {
    const { probe, recorded } = await invoke();
    expect(recorded.status).toBe(200);
    expect(probe).toHaveBeenCalledOnce();
    expect(JSON.parse(recorded.body)).toMatchObject({
      status: "healthy",
      message: "provider_request_succeeded",
    });
    expect(JSON.parse(recorded.body).elapsed_ms).toBeGreaterThanOrEqual(0);
  });

  it("rejects unauthorized and unsupported methods without probing", async () => {
    const unauthorized = await invoke("POST", "wrong");
    expect(unauthorized.recorded.status).toBe(401);
    expect(unauthorized.probe).not.toHaveBeenCalled();
    const method = await invoke("GET");
    expect(method.recorded.status).toBe(405);
    expect(method.probe).not.toHaveBeenCalled();
  });
});
