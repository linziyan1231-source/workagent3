import type {
  IChannelPairingRequest,
  IChannelPlatformSettings,
  IChannelPluginStatus,
  IChannelUser,
} from "@/common/types/channel/channel";
import { requestJson } from "../../shared/api/http.js";

type ConnectorView = {
  id: string;
  display_name: string;
  configured: boolean;
  enabled: boolean;
  account_id?: string;
  has_token: boolean;
  state: { running: boolean; error?: string };
};

type Pairing = {
  id: number;
  connector_id: string;
  external_user_id: string;
  display_name: string;
  status: "pending" | "approved" | "rejected" | "revoked";
  created_at: string;
  updated_at: string;
};

const settingsKey = (platform: string) => `channel.${platform}`;

const pairings = () => requestJson<Pairing[]>("/api/channels/pairings");

export const channelPort = {
  async statuses(): Promise<IChannelPluginStatus[]> {
    const [connectors, users] = await Promise.all([
      requestJson<ConnectorView[]>("/api/channels/connectors"),
      pairings(),
    ]);
    return connectors.map((connector) => ({
      id: connector.id,
      type: connector.id,
      name: connector.display_name,
      enabled: connector.enabled,
      connected: connector.state.running,
      status: connector.state.running ? "connected" : "disconnected",
      ...(connector.state.error === undefined
        ? {}
        : { error: connector.state.error }),
      activeUsers: users.filter(
        (user) =>
          user.connector_id === connector.id && user.status === "approved",
      ).length,
      ...(connector.account_id === undefined
        ? {}
        : { botUsername: connector.account_id }),
      hasToken: connector.has_token,
    }));
  },
  toggle(id: string, enabled: boolean): Promise<unknown> {
    return requestJson(
      `/api/channels/connectors/${id}/${enabled ? "enable" : "disable"}`,
      {
        method: "POST",
      },
    );
  },
  test(id: string): Promise<unknown> {
    return requestJson(`/api/channels/connectors/${id}/test`, {
      method: "POST",
    });
  },
  async pending(): Promise<IChannelPairingRequest[]> {
    return (await pairings())
      .filter((pairing) => pairing.status === "pending")
      .map((pairing) => ({
        code: String(pairing.id),
        platformUserId: pairing.external_user_id,
        platformType: pairing.connector_id,
        display_name: pairing.display_name,
        requestedAt: Date.parse(pairing.created_at),
        expiresAt: Date.parse(pairing.created_at) + 24 * 60 * 60 * 1000,
      }));
  },
  async authorized(): Promise<IChannelUser[]> {
    return (await pairings())
      .filter((pairing) => pairing.status === "approved")
      .map((pairing) => ({
        id: String(pairing.id),
        platformUserId: pairing.external_user_id,
        platformType: pairing.connector_id,
        display_name: pairing.display_name,
        authorizedAt: Date.parse(pairing.updated_at),
      }));
  },
  pairing(id: string, action: "approve" | "reject" | "revoke") {
    return requestJson<void>(
      `/api/channels/pairings/${encodeURIComponent(id)}/${action}`,
      {
        method: "POST",
      },
    );
  },
  async getSettings(platform: string): Promise<IChannelPlatformSettings> {
    const key = settingsKey(platform);
    const values = await requestJson<Record<string, IChannelPlatformSettings>>(
      `/api/settings/client?keys=${encodeURIComponent(key)}`,
    );
    return (
      values[key] ?? {
        platform,
        assistant: null,
        default_model: null,
      }
    );
  },
  async putSettings(
    platform: string,
    patch: Partial<IChannelPlatformSettings>,
  ): Promise<void> {
    const current = await this.getSettings(platform);
    const key = settingsKey(platform);
    await requestJson<void>("/api/settings/client", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ [key]: { ...current, ...patch, platform } }),
    });
  },
};
