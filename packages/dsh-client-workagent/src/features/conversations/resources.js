import { useResource } from "../../platform/resources.js";
import { conversationCache } from "./state.js";

// Only conversation resources opt into the session cache. Other features do
// not need to know its endpoint format, lifetime, or eviction rules.
const sessionId = (endpoint) => endpoint.split("/")[5];
const cache = {
  get: (endpoint) => conversationCache.get(sessionId(endpoint), endpoint),
  set: (endpoint, value) => conversationCache.set(sessionId(endpoint), endpoint, value),
  remove: (endpoint) => conversationCache.remove(sessionId(endpoint)),
};

export function useSessionResource(endpoint, select) {
  return useResource(endpoint, select, endpoint ? cache : undefined);
}
