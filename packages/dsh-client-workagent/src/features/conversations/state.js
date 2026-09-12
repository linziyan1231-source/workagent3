import { createMessageDelivery } from "./message-delivery.js";
import { createConversationCache } from "./cache.js";
import React from "react";

const conversationCache = createConversationCache();

const messageDelivery = createMessageDelivery(React);

const SESSIONS_CHANGED_EVENT = "workagent:sessions-changed";

const SESSION_SEEN_PREFIX = "workagent.session-seen.";

export {
  conversationCache,
  messageDelivery,
  SESSIONS_CHANGED_EVENT,
  SESSION_SEEN_PREFIX,
};
