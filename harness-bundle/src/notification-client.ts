import { platformQuotaConfiguration } from "./quota-client.js";

export type TerminalNotification = {
  kind: string;
  title: string;
  message: string;
  deepLink?: string;
};

// TerminalNotificationPort delivers automation/team terminal-state
// notifications to the platform Notifications module. Publish failures must
// never break a run, so callers fire-and-forget.
export interface TerminalNotificationPort {
  publish(notification: TerminalNotification): Promise<void>;
}

export class PlatformNotificationClient implements TerminalNotificationPort {
  readonly #configuration: NonNullable<
    ReturnType<typeof platformQuotaConfiguration>
  >;

  constructor(
    configuration: NonNullable<ReturnType<typeof platformQuotaConfiguration>>,
  ) {
    this.#configuration = configuration;
  }

  // The platform connection is the same loopback URL + registration token the
  // quota client uses; notifications are absent only when it is unconfigured.
  static fromEnvironment(
    environment: NodeJS.ProcessEnv = process.env,
  ): PlatformNotificationClient | undefined {
    const configuration = platformQuotaConfiguration(environment);
    return configuration === undefined
      ? undefined
      : new PlatformNotificationClient(configuration);
  }

  async publish(notification: TerminalNotification): Promise<void> {
    const response = await fetch(
      new URL("internal/runtime/notifications", this.#configuration.baseURL),
      {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.#configuration.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          sid: this.#configuration.sid,
          kind: notification.kind,
          title: notification.title,
          message: notification.message,
          deep_link: notification.deepLink ?? "",
        }),
        signal: AbortSignal.timeout(10_000),
      },
    );
    if (!response.ok)
      throw new Error(`platform_notification_http_${response.status}`);
  }
}
