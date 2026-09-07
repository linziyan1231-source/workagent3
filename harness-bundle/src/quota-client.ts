import {
  quotaReservationSchema,
  quotaReserveRequestSchema,
  quotaSettleRequestSchema,
  type QuotaReservation,
  type QuotaReserveRequest,
  type QuotaSettleRequest,
} from "@workagent/contracts";

export interface AutomationQuotaPort {
  reserve(request: Omit<QuotaReserveRequest, "sid">): Promise<QuotaReservation>;
  settle(request: Omit<QuotaSettleRequest, "sid">): Promise<void>;
}

type PlatformQuotaConfiguration = {
  baseURL: URL;
  sid: string;
  token: string;
};

const loopback = (hostname: string) =>
  hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]";

export const platformQuotaConfiguration = (
  environment: NodeJS.ProcessEnv,
): PlatformQuotaConfiguration | undefined => {
  const rawURL = environment.WORKAGENT_PLATFORM_URL;
  const sid = environment.WORKAGENT_EMPLOYEE_SID;
  const token = environment.WORKAGENT_PLATFORM_TOKEN;
  if (rawURL === undefined && sid === undefined && token === undefined)
    return undefined;
  if (rawURL === undefined || sid === undefined || token === undefined)
    throw new Error("platform_quota_configuration_incomplete");
  const baseURL = new URL(rawURL.endsWith("/") ? rawURL : `${rawURL}/`);
  if (
    baseURL.protocol !== "http:" ||
    baseURL.username !== "" ||
    baseURL.password !== "" ||
    baseURL.search !== "" ||
    baseURL.hash !== "" ||
    !loopback(baseURL.hostname) ||
    !sid.startsWith("S-1-") ||
    token.length < 22
  )
    throw new Error("platform_quota_configuration_invalid");
  return { baseURL, sid, token };
};

export class PlatformQuotaClient implements AutomationQuotaPort {
  readonly #configuration: PlatformQuotaConfiguration;

  constructor(configuration: PlatformQuotaConfiguration) {
    this.#configuration = configuration;
  }

  static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
  ): PlatformQuotaClient | undefined {
    const configuration = platformQuotaConfiguration(environment);
    return configuration === undefined
      ? undefined
      : new PlatformQuotaClient(configuration);
  }

  async reserve(
    input: Omit<QuotaReserveRequest, "sid">,
  ): Promise<QuotaReservation> {
    const request = quotaReserveRequestSchema.parse({
      ...input,
      sid: this.#configuration.sid,
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        const response = await this.#post("reserve", request);
        return quotaReservationSchema.parse(await response.json());
      } catch (error) {
        if (
          !(error instanceof Error) ||
          !["quota_usage_pending", "quota_usage_stale"].includes(
            error.message,
          ) ||
          Date.now() >= deadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  async settle(input: Omit<QuotaSettleRequest, "sid">): Promise<void> {
    const request = quotaSettleRequestSchema.parse({
      ...input,
      sid: this.#configuration.sid,
    });
    const deadline = Date.now() + 10_000;
    for (;;) {
      try {
        await this.#post("settle", request);
        return;
      } catch (error) {
        if (
          !(error instanceof Error) ||
          error.message !== "quota_usage_pending" ||
          Date.now() >= deadline
        )
          throw error;
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
    }
  }

  async #post(action: "reserve" | "settle", body: unknown): Promise<Response> {
    const response = await fetch(
      new URL(`internal/runtime/quota/${action}`, this.#configuration.baseURL),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#configuration.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok) {
      let code = `platform_quota_http_${response.status}`;
      try {
        const payload = (await response.json()) as { error?: unknown };
        if (typeof payload.error === "string") code = payload.error;
      } catch {
        // The status-derived code is already actionable and contains no secret.
      }
      throw new Error(code);
    }
    return response;
  }
}
