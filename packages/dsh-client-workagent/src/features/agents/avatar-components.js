import { createAssistantAvatars } from "./avatars.js";
import { apiRoot, request } from "../../platform/api.js";
import { EngineMark } from "../../ui/icons.js";
import React from "react";

const { AssistantAvatar, SessionAvatar, AvatarPicker, AvatarField } =
  createAssistantAvatars({ React, EngineMark, request, apiRoot });

export { AssistantAvatar, SessionAvatar, AvatarPicker, AvatarField };
