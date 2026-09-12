import { usePresets } from "../agents/api.js";
import { createAutomations } from "./automations.js";
import { apiRoot, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import {
  Button,
  Card,
  Field,
  Input,
  Section,
  Select,
  Status,
} from "../../ui/elements.js";
import { friendlyError } from "../../ui/labels.js";
import React from "react";

const AutomationsPage = createAutomations({
  React,
  request,
  apiRoot,
  useResource,
  usePresets,
  Section,
  Field,
  Input,
  Select,
  Button,
  Card,
  Status,
  friendlyError,
});

export { AutomationsPage };
