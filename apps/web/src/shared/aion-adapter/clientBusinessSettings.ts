import type {
  ClientBusinessSettingKey,
  ClientBusinessSettingMap,
} from "@/common/config/clientSettings";
import { requestJson } from "../api/http";

type SpeechCapability = {
  enabled: boolean;
  streaming: boolean;
};

const managedSpeechConfig = async () => {
  const capability = await requestJson<SpeechCapability>(
    "/api/speech/capability",
  );
  if (!capability.enabled) return undefined;

  return {
    enabled: true,
    provider: "deepgram" as const,
    deepgram: {
      api_key: "server-managed",
      model: capability.streaming ? "nova-3" : "batch-only",
    },
  };
};

export async function getClientBusinessSetting<
  K extends ClientBusinessSettingKey,
>(key: K): Promise<ClientBusinessSettingMap[K] | undefined> {
  if (key === "tools.speechToText") {
    return (await managedSpeechConfig()) as ClientBusinessSettingMap[K];
  }

  const data = await requestJson<
    Record<string, ClientBusinessSettingMap[K] | undefined>
  >(`/api/settings/client?keys=${encodeURIComponent(key)}`);
  return data?.[key];
}

export async function setClientBusinessSetting<
  K extends ClientBusinessSettingKey,
>(key: K, value: ClientBusinessSettingMap[K]): Promise<void> {
  if (key === "tools.speechToText") {
    throw new Error("SPEECH_CONFIG_SERVER_MANAGED");
  }
  await requestJson<void>("/api/settings/client", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [key]: value }),
  });
}

export async function removeClientBusinessSetting<
  K extends ClientBusinessSettingKey,
>(key: K): Promise<void> {
  if (key === "tools.speechToText") {
    throw new Error("SPEECH_CONFIG_SERVER_MANAGED");
  }
  await requestJson<void>("/api/settings/client", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [key]: null }),
  });
}
