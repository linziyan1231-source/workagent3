import type { ConfigKey, ConfigKeyMap } from "@/common/config/configKeys";
import { requestJson } from "../api/http.js";

type Subscriber = (value: unknown) => void;

const managedKeys: ConfigKey[] = [
  "theme.activeId",
  "theme.userThemes",
  "ui.fontSize.chat",
  "ui.fontSize.markdown",
  "ui.fontSize.code",
];

class BrowserConfigService {
  private cache = new Map<string, unknown>();
  private subscribers = new Map<string, Set<Subscriber>>();
  private initPromise: Promise<void> | null = null;

  initialize(): Promise<void> {
    if (this.initPromise) return this.initPromise;
    if (import.meta.env.MODE === "test") {
      this.initPromise = Promise.resolve();
      return this.initPromise;
    }
    const query = managedKeys
      .map((key) => `keys=${encodeURIComponent(key)}`)
      .join("&");
    this.initPromise = requestJson<Record<string, unknown>>(
      `/api/settings/client?${query}`,
    )
      .then((values) => {
        this.cache.clear();
        for (const [key, value] of Object.entries(values ?? {}))
          this.cache.set(key, value);
      })
      .catch((error) => {
        this.initPromise = null;
        throw error;
      });
    return this.initPromise;
  }

  whenReady(): Promise<void> {
    return this.initialize();
  }

  get<K extends ConfigKey>(key: K): ConfigKeyMap[K] | undefined {
    return this.cache.get(key) as ConfigKeyMap[K] | undefined;
  }

  async set<K extends ConfigKey>(key: K, value: ConfigKeyMap[K]): Promise<void> {
    this.cache.set(key, value);
    this.notify(key, value);
    await this.persist({ [key]: value });
  }

  setLocal<K extends ConfigKey>(key: K, value: ConfigKeyMap[K]): void {
    this.cache.set(key, value);
    this.notify(key, value);
  }

  async remove(key: ConfigKey): Promise<void> {
    this.cache.delete(key);
    this.notify(key, undefined);
    await this.persist({ [key]: null });
  }

  async setBatch(
    entries: Partial<{ [K in ConfigKey]: ConfigKeyMap[K] }>,
  ): Promise<void> {
    for (const [key, value] of Object.entries(entries)) {
      this.cache.set(key, value);
      this.notify(key as ConfigKey, value);
    }
    await this.persist(entries);
  }

  subscribe(key: ConfigKey, callback: Subscriber): () => void {
    const subscribers = this.subscribers.get(key) ?? new Set<Subscriber>();
    subscribers.add(callback);
    this.subscribers.set(key, subscribers);
    return () => subscribers.delete(callback);
  }

  isInitialized(): boolean {
    return this.initPromise !== null;
  }

  reset(): void {
    this.cache.clear();
    this.subscribers.clear();
    this.initPromise = null;
  }

  private async persist(values: Record<string, unknown>): Promise<void> {
    await requestJson<void>("/api/settings/client", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(values),
    });
  }

  private notify(key: ConfigKey, value: unknown): void {
    for (const callback of this.subscribers.get(key) ?? []) callback(value);
  }
}

export const configService = new BrowserConfigService();
