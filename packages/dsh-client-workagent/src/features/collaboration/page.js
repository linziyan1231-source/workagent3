import { Markdown, workbench } from "../content/index.js";
import {
  closeMobileSidebar,
  closeSidebar,
  navigation,
} from "../../host/navigation.js";
import { apiRoot, request } from "../../platform/api.js";
import { useResource } from "../../platform/resources.js";
import { createShared } from "./shared.js";
import { Button, Input, Section, Select } from "../../ui/elements.js";
import { EngineMark, Icon } from "../../ui/icons.js";
import { SessionAvatar } from "../agents/avatar-components.js";
import { friendlyError } from "../../ui/labels.js";
import { createUploads } from "../files/uploads.js";
import { ComposerForm } from "../conversations/composer.js";
import { WorkspaceFileManager } from "../files/manager.js";
import React from "react";

const SharedPage = createShared({
  React,
  ComposerForm,
  closeMobileSidebar,
  usePins: workbench.usePins,
  navigation,
  Icon,
  EngineMark,
  SessionAvatar,
  createUploads,
  request,
  apiRoot,
  useResource,
  Section,
  Button,
  Input,
  Select,
  Markdown,
  friendlyError,
  FileManager: WorkspaceFileManager,
  SessionReminder: workbench.SessionReminder,
  closeSidebar,
});

export { SharedPage };
