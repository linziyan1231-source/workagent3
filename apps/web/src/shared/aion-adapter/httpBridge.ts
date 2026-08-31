import { collaborationPort } from "../../features/collaboration/collaborationPort.js";
import { ApiError, requestJson } from "../api/http.js";

export type BackendHttpError = Error & {
  status: number;
  code: string;
  details?: unknown;
};

export const isBackendHttpError = (error: unknown): error is BackendHttpError =>
  error instanceof ApiError;

export const getBaseUrl = () => "";

export const httpRequest = <T>(method: string, path: string, body?: unknown) =>
  requestJson<T>(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
  });

export const subscribeSharedEvents = () => collaborationPort.retainStream();
export const reconnectSharedEvents = () => collaborationPort.reconnectStream();
export const reconnectRealtime = reconnectSharedEvents;
